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
import { resolveOpencodeStoreKey } from "./go-discovery.ts";
import { isRecord } from "./guards.ts";
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
import {
  enrichModelsResponse,
  findModelSpec,
  isModelsListingUrl,
} from "./models-catalog.ts";
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

/**
 * Whether the model a body names is one the gateway admits with no key.
 *
 * The gateway's free-tier rule is per-model, not per-plane: `allowAnonymous` on
 * the model entry admits a request with no key at all, or with the literal
 * `public`, and the proxy strips it before forwarding
 * (`packages/console/app/src/lib/inference-proxy.ts`, identical in 1.19 and 2.x;
 * `docs/upstream-findings.md` §1.5). So "no credential resolved" is only a fault
 * for a model that NEEDS one, and reporting it for a free model sends the reader
 * to set a key they do not need.
 *
 * The body is read rather than assumed, because the model is the only thing that
 * decides. A plane-level check would be wrong in both directions: the Zen plane
 * offers free models, and so does Go, which serves them by subscription key.
 *
 * @param body - the request body, when there is one to read.
 * @returns whether the model it names is flagged free.
 */
const isFreeModelBody = (body: RequestInit["body"]): boolean => {
  if (typeof body !== "string" || body.length === 0) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const model: unknown = (parsed as Record<string, unknown>).model;
    // Both JSON routes carry the id under `model`, the Responses API included.
    if (typeof model !== "string" || model.length === 0) {
      return false;
    }
    return findModelSpec(model)?.is_free === true;
  } catch {
    return false;
  }
};

/** The credential header the request's protocol actually reads. */
const toolNamesOf = (body: RequestInit["body"]): string => {
  if (typeof body !== "string" || body.length === 0) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) {
      return "";
    }
    const tools: unknown = (parsed as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) {
      return "";
    }
    const names: string[] = [];
    for (const tool of tools) {
      if (typeof tool !== "object" || tool === null) {
        continue;
      }
      const rec = tool as Record<string, unknown>;
      const direct = rec.name;
      if (typeof direct === "string") {
        names.push(direct);
        continue;
      }
      const fn = rec.function;
      if (typeof fn === "object" && fn !== null) {
        const fname = (fn as Record<string, unknown>).name;
        if (typeof fname === "string") {
          names.push(fname);
        }
      }
    }
    return names.join(",");
  } catch {
    return "";
  }
};
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
 * A gateway refusal, restated as a 400.
 *
 * 403 means "understood and refused" on this gateway, and DSH reads 403 as AUTH —
 * so passing one through tells a user with a working key that their key is
 * invalid. The `type` distinguishes the refusals; the message keeps the gateway's
 * words so it stays searchable.
 */
const restrictedResponse = (message: string, type: string): Response =>
  Response.json(
    { error: { message, type } },
    { status: 400, statusText: "Bad Request" }
  );

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
  // One report per plane for the no-credential case, because this runs on every
  // gateway request and the same missing credential would otherwise log on each.
  const warnedNoCredential = new Set<string>();
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
      } else if (
        plane.length > 0 &&
        !warnedNoCredential.has(plane) &&
        // A free model is ADMITTED with no credential at all, so "no credential
        // resolved" is not a failure there and saying it is sends the reader to
        // a key they do not need. The gateway's own rule is per-model
        // (`allowAnonymous` on the model entry, with no key or the literal
        // `public` - `docs/upstream-findings.md` §1.5), so the model is asked
        // rather than the plane. Keep the placeholder: the proxy strips it for
        // an anonymous request anyway, so stripping it here would change nothing
        // but would also deprive a keyless-but-paid model of a header to fill.
        //
        // `init.body` is read, not the `Request`: the tool-injection block below
        // resolves a `Request`-carried body, and this check runs before it. A
        // body the switch cannot see answers "not free", which is the safe
        // side - the warning is the status quo, not a new failure.
        !isFreeModelBody(init?.body)
      ) {
        warnedNoCredential.add(plane);
        const sources: string[] = [
          `a key on the request: ${requestKey === undefined ? "none" : "present"}`,
          `a key captured from a live request (policy ${config.keySource}): ${
            captured === undefined ? "none" : "present"
          }`,
          `${plane === "opencode-go" ? "OPENCODE_GO_API_KEY" : "OPENCODE_API_KEY"}: ${
            declared === undefined || declared.length === 0 ? "unset" : "set"
          }`,
          `a stored login: ${login === undefined ? "none" : "none resolved"}`,
          `the installation's own store: ${
            config.readOpencodeStore ? "read" : "not enabled"
          }`,
        ];
        console.warn(
          `[dsh-opencode-patch] no credential resolved for ${plane}; sending the adapter's placeholder, which the gateway answers with 401. Consulted: ${sources.join("; ")}.`,
          "set a key on the route or its env var, or sign in through the settings card"
        );
      }
    }

    // 1. Session headers, as the version this plugin emulates sends them.
    //
    // Read from the 1.x line's last release, v1.19.3, in
    // `packages/opencode/src/session/llm/request.ts`: `x-opencode-session-id`
    // and `x-opencode-session` both carry `sessionID`, and the affinity pair
    // belongs to relays. 2.x splits the first of those into an affinity id; the
    // plugin emulates 1.19.3, so it follows 1.19.3.
    //
    // Which ENDPOINT the request goes to is the deployment's, not this block's:
    // measured, either key serves a paid model on either endpoint - they are two
    // paths into one gateway - so nothing here has to pick one. `x-opencode-
    // request` is the one header of the set this plugin does not send, because
    // the CLI fills it from its own user id and the turn store has no equivalent.
    const sessionVal = resolveSessionHeader(
      state,
      headers,
      config.sessionIdEnv
    );
    headers.set("x-opencode-session-id", sessionVal);
    headers.set(SESSION_HEADER, sessionVal);
    // The affinity pair belongs to the OTHER branch in 1.19.3: for a provider
    // that does not start with `opencode` - a relay a deployment claimed by URL -
    // the client sends `x-session-affinity` and `X-Session-Id`; for an OpenCode
    // plane it sends `x-opencode-session` instead and nothing else. This plugin
    // sent all three everywhere, which is neither generation's behaviour.
    if (!(state?.provider ?? "").startsWith("opencode")) {
      headers.set(SESSION_AFFINITY_HEADER, sessionVal);
      headers.set(SESSION_ID_HEADER, sessionVal);
    }

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
    let requestToSend = input;

    // 4. Core tool schema fallback for free-tier /responses models.
    //
    // DSH sends inference as fetch(new Request(url, { body })) — so init.body
    // is undefined and the old `init?.body !== undefined` guard skipped the
    // whole block: Agent Team turns left with no bash and the gateway 403s
    // the body as non-OpenCode. Read the body off whichever half carries it.
    let bodySource: "request" | "init" | "none" = "none";
    let bodyToPatch: RequestInit["body"] = init?.body;
    if (bodyToPatch !== undefined) {
      bodySource = "init";
    } else if (input instanceof Request) {
      try {
        bodyToPatch = await input.clone().text();
        bodySource = "request";
      } catch {
        bodyToPatch = undefined;
      }
    }
    let finalBody = bodyToPatch;
    if (bodyToPatch !== undefined) {
      const newBody = maybeInjectCoreTools(url, bodyToPatch, headers, {
        enabled: config.injectCoreTools,
        modelMarker: config.freeModelMarker,
      });
      if (newBody !== bodyToPatch) {
        finalBody = newBody;
        if (bodySource === "request" && input instanceof Request) {
          // The input Request already owns the old body — clone() so the
          // caller's stream is never consumed, and send a new Request.
          // `method` is restated so the lint can see it — the Request copy
          // carries the same method either way. The instanceof repeat is
          // there for the type checker.
          requestToSend = new Request(input, {
            body: newBody,
            method: input.method,
          });
        } else {
          newInit.body = newBody;
        }
      }
    }

    const response = await original.call(this, requestToSend, newInit);

    // One line per request the interceptor touched, so a run that misbehaves can
    // be read back instead of guessed at. Presence, never values: whether a
    // credential, a session and an org were SENT is what explains an answer, and
    // the credential itself has no business in a log.
    hooks.debug?.({
      auth: extractApiKeyFromHeaders(headers) !== undefined,
      bodySource,
      claimed: true,
      org: headers.get("x-opencode-org-id") ?? null,
      plane: gatewayPlaneFor(url),
      session: headers.get(SESSION_HEADER) ?? null,
      sessionFormat: isOpenCodeSessionId(headers.get(SESSION_HEADER)),
      status: response.status,
      toolNames: toolNamesOf(finalBody),
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

    // **403 is never a credential answer on this gateway.** It answers 401 for a
    // credential it will not accept (`Missing API key`, `Invalid API key`, `Go
    // requires a credential`) and 403 for a request it understood and refused.
    // DSH's error classifier maps 403 to AUTH, so every refusal used to reach the
    // user as "API key is invalid" — with a key that was working.
    //
    // Measured on the live gateway, all of these are 403 and none is about auth:
    //
    //   FreeTierError            "…can only be used from within OpenCode…"
    //   server_error             "Upstream request failed: Model access is disabled"
    //   WAF 1010 (plain text)    the request did not look like the OpenCode client
    //
    // All three are remapped to 400 so the classifier reads them as a request
    // problem rather than a key problem, and each keeps the gateway's own words so
    // the reader can search them. The `type` is what tells them apart.
    // Scoped to INFERENCE requests. `/usage` answers 403 for "subscription
    // required", and `GoUsageService` reads that status to say so — remapping it
    // would leave the panel describing a permission problem as a bad request.
    const isUsageRequest = (() => {
      try {
        return new URL(url).pathname.replace(/\/+$/u, "").endsWith("/usage");
      } catch {
        return false;
      }
    })();
    if (response.status === 403 && !isUsageRequest) {
      try {
        const text = await response.clone().text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }

        if (isRecord(parsed)) {
          const inner = isRecord(parsed.error) ? parsed.error : parsed;
          const type = typeof inner.type === "string" ? inner.type : "";
          const message =
            typeof inner.message === "string" ? inner.message : text;
          if (
            type.includes("FreeTier") ||
            message.includes("FreeTierError") ||
            message.includes("from within OpenCode")
          ) {
            return restrictedResponse(
              "The gateway refused this model for the credential in use (403 FreeTierError). If it is a free-tier id the refusal is about this request rather than the key - the same credential answers 200 for a paid model on the same endpoint. Reported as 400 so DSH does not read it as an invalid API key.",
              "free_tier_restricted"
            );
          }
          // Everything else the gateway refuses with a JSON 403 is an
          // entitlement answer: the key was accepted, the account does not have
          // this model. `Model access is disabled` is the common one.
          return restrictedResponse(
            `The gateway refused this model for this account (403 ${type || "refusal"}: ${message}). The credential was accepted - this is about what the account may use, not about the key. Reported as 400 so DSH does not read it as an invalid API key.`,
            "entitlement_restricted"
          );
        }

        if (text.includes("1010")) {
          return restrictedResponse(
            "Cloudflare refused this request (403 error code 1010): it did not look like the OpenCode client. This plugin restores the client User-Agent, so this means that restoration did not apply to this request. Reported as 400 so DSH does not read it as an invalid API key.",
            "client_identity_blocked"
          );
        }
      } catch {
        // Fall back to the original response when the body cannot be read.
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
