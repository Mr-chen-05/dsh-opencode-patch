/**
 * The `fetch` patch: where OpenCode gateway traffic is recognized and fixed.
 *
 * Only requests the plugin claims (gateway URL match, or a configured
 * provider on the active turn) are touched; everything else returns through
 * the original `fetch` byte-identical. For claimed requests the patch
 * restores the session header, the CLI User-Agent, and the gateway origin
 * headers, and runs the free-tier core-tool fallback over the body.
 *
 * @module dsh-opencode-patch/fetch-patch
 */

import type { AsyncLocalStorage } from "node:async_hooks";

import { DEFAULT_GATEWAY_URLS, type ResolvedPluginConfig } from "./config.ts";
import { pairedEndpointUrl } from "./endpoint-pairing.ts";
import { resolveOpencodeStoreKey } from "./go-discovery.ts";
import {
  extractApiKeyFromHeaders,
  getCapturedApiKey,
  isPlaceholderApiKey,
  recordCapturedApiKey,
  tierForRequest,
} from "./key-capture.ts";
import type {
  LoginCredential,
  LoginCredentialReader,
} from "./login-credential.ts";
import { enrichModelsResponse, isModelsListingUrl } from "./models-catalog.ts";
import {
  fallbackSessionId,
  isOpenCodeSessionId,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  SESSION_ID_HEADER,
} from "./session.ts";
import { maybeInjectCoreTools } from "./tool-fallback.ts";
import type { ActiveTurnState } from "./turn-store.ts";

/**
 * Which gateway plane a URL belongs to.
 *
 * From the URL alone, because the observer is called with nothing else and a
 * mis-attributed rotation would move the wrong plane's credential. The Go plane
 * lives under `/zen/go` and the Zen plane under `/zen`, so the longer path is
 * matched first — and an unrecognised URL answers `""` rather than guessing,
 * because a rotation is a side effect.
 */
const gatewayPlaneFor = (url: string): string => {
  const path = new URL(url).pathname;
  // Both endpoint families, because a credential's format decides which one a
  // request belongs on and the plane is the same either way.
  if (/\/(?:zen|inference)\/go\//u.test(path)) {
    return "opencode-go";
  }
  if (/\/(?:zen|inference)\//u.test(path)) {
    return "opencode";
  }
  return "";
};

/** The credential header the request's protocol actually reads. */
const authHeaderFor = (url: string): string => {
  const path = new URL(url).pathname;
  if (path.endsWith("/messages")) {
    return "x-api-key";
  }
  if (
    /\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/u.test(path)
  ) {
    return "x-goog-api-key";
  }
  return "authorization";
};

const extractUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const urlProp: unknown = input.url;
    if (typeof urlProp === "string") {
      return urlProp;
    }
    if (urlProp instanceof URL) {
      return urlProp.toString();
    }
  }
  return "";
};

const readHeaderSource = (
  input: RequestInfo | URL,
  init?: RequestInit
): HeadersInit | undefined => {
  if (init?.headers !== undefined) {
    return init.headers;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.headers;
  }
  return undefined;
};

/** Whether the request already carries a session header (any casing). */
export const hasSessionHeader = (
  input: RequestInfo | URL,
  init?: RequestInit
): boolean => {
  const source = readHeaderSource(input, init);
  if (source === undefined) {
    return false;
  }
  try {
    return new Headers(source).has(SESSION_HEADER);
  } catch {
    return false;
  }
};

/**
 * Determines if a request targets an OpenCode API endpoint.
 *
 * Two independent claims: a URL containing any configured gateway substring
 * (works even with no active turn, which is what keeps session affinity for
 * background calls), or a turn routed to a configured provider.
 *
 * @param url - the request URL.
 * @param state - the active turn, when the request belongs to one.
 * @param providers - configured provider route keys.
 * @param gatewayUrls - URL substrings marking gateway traffic; blank entries
 * are ignored, and the caller's absence of a list falls back to the default
 * gateway markers.
 */
export const isOpenCodeRequest = (
  url: string,
  state: ActiveTurnState | undefined,
  providers: Set<string>,
  gatewayUrls: readonly string[] = DEFAULT_GATEWAY_URLS
): boolean => {
  for (const marker of gatewayUrls) {
    if (marker.length > 0 && url.includes(marker)) {
      return true;
    }
  }
  if (state !== undefined && providers.has(state.provider)) {
    return true;
  }
  return false;
};

const resolveSessionHeader = (
  state: ActiveTurnState | undefined,
  headers: Headers,
  sessionIdEnv: string
): string => {
  if (state) {
    return state.value;
  }
  // A header a deployment pinned is honoured only when the gateway would accept
  // it. `ses_dsh_default` starts with `ses_` and is not a session id, and sending
  // it earns a 401 that reads like a credential fault — so a malformed one is
  // replaced by a derived id rather than passed through.
  const existing = headers.get(SESSION_HEADER);
  if (isOpenCodeSessionId(existing)) {
    return existing;
  }
  return fallbackSessionId(sessionIdEnv);
};

/**
 * Wrap `fetch` so claimed OpenCode requests carry the gateway's expected
 * headers and session id.
 *
 * @param original - the fetch implementation to wrap (usually `globalThis.fetch`).
 * @param als - turn store consulted for the session id of the current turn.
 * @param config - resolved plugin configuration.
 */
/**
 * Told when the gateway refused a credential, so a pool can rotate.
 *
 * The interceptor is the only place in this plugin that sees EVERY gateway
 * response, including the ones made by routes the wrapper serves and by the Go
 * plane — which is why rotation is driven from here rather than from a route.
 * A rotation triggered by a route only reaches that route's plane; a
 * credential failure happens wherever the credential was used.
 *
 * @param plane - the gateway plane the request went to.
 * @param status - the HTTP status the gateway answered with.
 */
export type CredentialFailureObserver = (plane: string, status: number) => void;

/**
 * What the interceptor needs from the plugin beyond its configuration.
 *
 * An object rather than more positional parameters, because these are the
 * plugin's own seams into the request path and there will be more of them. The
 * configuration stays separate: it is what the deployment wrote, and these are
 * what the running plugin knows.
 */
export interface FetchPatchHooks {
  /** Told when the gateway refused a credential, so a pool can rotate. */
  readonly onCredentialFailure?: CredentialFailureObserver;
  /**
   * The org a plane's credential belongs to, when it has one.
   *
   * Asked per request rather than captured once, because a login can arrive
   * while the process runs. The org is not a setting: it is part of the
   * credential, and a request carrying a token without its org is answered as
   * though the token were a plain key.
   *
   * @param plane - the gateway plane the request is bound for.
   * @returns the org id, `wrk_...`, or undefined when the plane's credential has
   * none — which is every key deployment, and the reason this is optional.
   */
  readonly resolveOrg?: (plane: string) => string | undefined;
  /** Last-resort login lookup; returns the token with its own org. */
  readonly loginCredential?: LoginCredentialReader;
  /**
   * One entry per claimed request, for the debug file.
   *
   * The question it exists to answer is why a request that should have been
   * patched was not, or was patched wrongly — which is invisible from the
   * outside, because the gateway's answer for a malformed session id reads
   * exactly like the answer for a bad credential. So it records what the
   * interceptor SAW and what it SENT, never the credential itself.
   */
  readonly debug?: (entry: Record<string, unknown>) => void;
}

export const patchFetch = (
  original: typeof fetch,
  als: AsyncLocalStorage<ActiveTurnState>,
  config: ResolvedPluginConfig,
  hooks: FetchPatchHooks = {}
): typeof fetch => {
  const patchedFetch = async function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const state = als.getStore();
    const url = extractUrl(input);

    if (!isOpenCodeRequest(url, state, config.providers, config.gatewayUrls)) {
      return original.call(this, input, init);
    }

    const headers = new Headers(readHeaderSource(input, init));

    // Capture the API key from the request headers so that quota monitoring,
    // usage display, and key resolution don't have to rely purely on static env vars.
    const extracted = extractApiKeyFromHeaders(headers);
    const requestKey =
      extracted === undefined || isPlaceholderApiKey(extracted)
        ? undefined
        : extracted;
    if (requestKey !== undefined) {
      recordCapturedApiKey(requestKey, state?.provider, url);
    }

    // Ensure an Authorization header is present if the caller omitted it or provided a dummy value.
    let login: LoginCredential | undefined;
    const plane = gatewayPlaneFor(url);
    const wireHeader = authHeaderFor(url);
    const authHeader = headers.get(wireHeader);
    const wireKey = authHeader?.replace(/^Bearer\s+/iu, "").trim();
    if (
      wireKey === undefined ||
      wireKey.length === 0 ||
      isPlaceholderApiKey(wireKey)
    ) {
      // The captured key is looked up by tier as well as by provider: a user
      // may have named the route anything, and a provider-id miss must not hide
      // a key that is already known to work. Under the `configured` policy the
      // declared credential wins outright, so the capture is skipped entirely.
      const tier = tierForRequest(url, state?.provider);
      const captured =
        config.keySource === "configured"
          ? undefined
          : getCapturedApiKey(
              state?.provider,
              tier === "unknown" ? undefined : tier
            );
      // Explicit request auth (including x-api-key) and declared sources win.
      // Only a known gateway plane may ask for a login: a configured provider
      // can also claim other URLs, which must not receive an account token.
      const declared =
        plane === "opencode-go" ||
        (plane.length === 0 && state?.provider === "opencode-go")
          ? process.env.OPENCODE_GO_API_KEY
          : process.env.OPENCODE_API_KEY;
      const explicit =
        requestKey ??
        captured ??
        (declared === undefined ||
        declared.length === 0 ||
        isPlaceholderApiKey(declared)
          ? undefined
          : declared);
      if (explicit === undefined && plane.length > 0) {
        login = await hooks.loginCredential?.(plane);
      }
      const fallbackKey =
        explicit ??
        login?.accessToken ??
        resolveOpencodeStoreKey(plane, config.readOpencodeStore);
      if (typeof fallbackKey === "string" && fallbackKey.length > 0) {
        headers.set(
          wireHeader,
          wireHeader === "authorization" ? `Bearer ${fallbackKey}` : fallbackKey
        );
        // Keep the Bearer fallback for callers that use it on other wire shapes.
        // Never overwrite real request auth merely to add the protocol's header.
        const bearer = headers.get("authorization");
        if (
          wireHeader !== "authorization" &&
          (bearer === null ||
            isPlaceholderApiKey(bearer.replace(/^Bearer\s+/iu, "")))
        ) {
          headers.set("authorization", `Bearer ${fallbackKey}`);
        }
      }
    }

    // 1. Session headers: ALWAYS injected for OpenCode requests.
    //
    // There are FOUR, and they do not all carry the same value. Read from the
    // client's own source (`packages/core/src/session/model-request.ts`):
    //
    //   x-opencode-session-id -> session.id   the session making THIS request
    //   x-opencode-session    -> affinity     the id that groups them for cache
    //   x-session-affinity    -> affinity
    //   X-Session-Id          -> affinity
    //
    // where affinity is `parentID ?? fork.sessionID ?? id` (affinity.ts). So for a
    // subagent the two differ by design: the child identifies itself in
    // `session-id` while the cache grouping follows the parent. This plugin sent
    // the child's id in all four, which put a subagent in its own cache group
    // instead of its parent's - the opposite of the lineage the parent headers
    // beside them describe.
    const sessionVal = resolveSessionHeader(
      state,
      headers,
      config.sessionIdEnv
    );
    const affinity = state?.parentValue ?? sessionVal;
    headers.set(SESSION_HEADER, affinity);
    headers.set("x-opencode-session-id", sessionVal);
    headers.set(SESSION_AFFINITY_HEADER, affinity);
    headers.set(SESSION_ID_HEADER, affinity);

    // 1b. Parent session header: injected for subagents and child sessions
    if (state?.parentValue !== undefined) {
      headers.set(PARENT_SESSION_HEADER, state.parentValue);
      headers.set(PARENT_SESSION_ALT_HEADER, state.parentValue);
    }

    // 2. User-Agent: injected / restored when enabled, with user override support
    if (config.injectUserAgent) {
      headers.set("User-Agent", config.userAgent ?? OPENCODE_UA);
    }

    // 2b. The org, when this plane's credential belongs to one. A session token
    // is only half a credential: the gateway gates the free tier on the org that
    // arrived with it, and a request carrying one without the other is answered
    // as though it carried a plain key.
    // A selected login uses its own org, not a mutable cache that another
    // request or a previous account may have populated. An explicit override
    // still wins; absent login metadata must not revive a stale cached org.
    const org =
      config.credentialOrg ??
      (login === undefined
        ? hooks.resolveOrg?.(gatewayPlaneFor(url))
        : login.orgId);
    if (org !== undefined && org.length > 0) {
      headers.set("x-opencode-org-id", org);
    } else if (login !== undefined) {
      headers.delete("x-opencode-org-id");
    }

    // 3. Client & Project origin headers: injected when enabled
    if (config.injectOriginHeaders) {
      headers.set("x-opencode-client", config.originClient);

      if (config.injectProject) {
        const project =
          state?.project !== undefined && state.project.length > 0
            ? state.project
            : "global";
        headers.set("x-opencode-project", project);
      }
    }

    const newInit: RequestInit = { ...init, headers };

    // 4. Core tool schema fallback for free-tier /responses models
    if (init?.body !== undefined) {
      const newBody = maybeInjectCoreTools(url, init.body, headers, {
        enabled: config.injectCoreTools,
        modelMarker: config.freeModelMarker,
      });
      if (newBody !== init.body) {
        newInit.body = newBody;
      }
    }

    // The credential's format decides which endpoint family it belongs to. A
    // mismatched pair is refused in a way that reads like an entitlement fault,
    // so the request is moved to the family its own credential names.
    const wireCredential = headers
      .get(wireHeader)
      ?.replace(/^Bearer\s+/iu, "")
      .trim();
    const paired = pairedEndpointUrl(url, wireCredential);
    const response = await original.call(
      this,
      paired === url ? input : paired,
      newInit
    );

    // One line per request the interceptor touched, so a run that misbehaves can
    // be read back instead of guessed at. Presence, never values: whether a
    // credential, a session and an org were SENT is what explains an answer, and
    // the credential itself has no business in a log.
    hooks.debug?.({
      auth: extractApiKeyFromHeaders(headers) !== undefined,
      claimed: true,
      org: headers.get("x-opencode-org-id") ?? null,
      plane: gatewayPlaneFor(url),
      session: headers.get(SESSION_HEADER) ?? null,
      sessionFormat: isOpenCodeSessionId(headers.get(SESSION_HEADER)),
      status: response.status,
      url,
      userAgent: headers.get("User-Agent") ?? null,
    });

    // A refused credential or an exhausted rate limit is the one moment a pool
    // can do something useful, and this is the only place that sees the answers
    // of routes the wrapper serves — so the rotation is driven from here. The
    // current request has already failed; this is about the next one.
    //
    // 403 is NOT included: the gateway answers a model the account has not
    // enabled with 403, and rotating a key over that would move a deployment
    // off a working credential for a model problem.
    if (
      hooks.onCredentialFailure !== undefined &&
      (response.status === 401 || response.status === 429)
    ) {
      hooks.onCredentialFailure(gatewayPlaneFor(url), response.status);
    }

    // If upstream returns 403 FreeTierError, demultiplex it to HTTP 400 so DSH's
    // error classifier doesn't falsely categorize it as an invalid API key ("AUTH").
    if (response.status === 403) {
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        if (
          text.includes("FreeTierError") ||
          text.includes("from within OpenCode")
        ) {
          return Response.json(
            {
              error: {
                message:
                  "OpenCode's free tier can only be used from within OpenCode. Use space-bunny-free or a pay-as-you-go model.",
                type: "free_tier_restricted",
              },
            },
            {
              status: 400,
              statusText: "Bad Request",
            }
          );
        }
      } catch {
        // Fall back to original response on clone/text errors
      }
    }

    const method = (
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET")
    ).toUpperCase();
    if (
      config.enrichModels &&
      method === "GET" &&
      isModelsListingUrl(url, config.gatewayUrls)
    ) {
      return enrichModelsResponse(url, response);
    }
    return response;
  };
  return patchedFetch;
};
