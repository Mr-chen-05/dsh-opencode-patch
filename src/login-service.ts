/**
 * The host half of the login surface: a device flow a browser can drive.
 *
 * **It holds the credential and the browser never does.** Every method here
 * answers with a code to show, an outcome to read, or a state to render — never
 * a token. That is the same division the usage meter uses, and it is why the
 * login can live in a settings card at all: the card is a remote, not a vault.
 *
 * **One attempt at a time, per service.** A device flow is a code a human is
 * holding; starting a second one would replace the first and leave the human
 * approving a code nobody is waiting for. `begin` therefore discards any attempt
 * it had, and `poll` answers for the one it started.
 *
 * **`state` is what makes the card honest.** It re-reads the stored grant per
 * call, so a card that polls sees a login appear the moment the flow completes —
 * including one completed in another window, or by the CLI. A grant whose owner
 * was never read renders as signed in with no email rather than as nothing.
 *
 * @module dsh-opencode-patch/login-service
 */

import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import {
  type ConsoleAuthClient,
  ConsoleAuthClient as Client,
} from "./console-auth.ts";
import {
  type CredentialsWriter,
  readCredentialsWriter,
} from "./cordis-context.ts";
import { isRecord } from "./guards.ts";
import { name } from "./identity.ts";
import type {
  LoginBeginQuery,
  LoginCancelQuery,
  LoginChallenge,
  LoginPollQuery,
  LoginPollResult,
  LoginState,
} from "./login-contract.ts";
import { beginLogin, type LoginAttempt } from "./login-flow.ts";
import { setOrg } from "./org-cache.ts";
import { createTokenStore, type TokenStore } from "./token-store.ts";

/**
 * The plane a query names, defaulting to Zen — the plane a login is for.
 *
 * A login signs an ACCOUNT in, and both planes read the same account; the plane
 * here only decides which grant the tokens are written to.
 *
 * @param query - the caller's query, if any.
 * @returns the plane to write to.
 */
const planeOf = (query: LoginBeginQuery | undefined): string =>
  query?.plane === "opencode-go" ? "opencode-go" : "opencode";

/** Prototype key `remoteMethods()` reads Remote markers from. */
const REMOTE_METHOD_DESCRIPTOR_KEY =
  "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** What the service needs from its composition. */
export interface LoginServiceOptions {
  /** The Console base URL; the default is the one the client itself uses. */
  readonly consoleBaseUrl?: string;
  /** The fetch it talks through; the default is the ambient one. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The credential seam, when the caller has it.
   *
   * Injected rather than read off the context because `this.ctx` is cordis's own
   * context, not the object this service was constructed with: a caller that
   * stubbed `get` on the way in would find it bypassed here. The same reason
   * `usage.ts` takes `resolveApiKey` as an option.
   */
  readonly credentials?: CredentialsWriter;
}

/**
 * The device flow, as a remote.
 *
 * Mounted by the plugin's `apply` alongside the usage service, so a settings card
 * has something to call and the credential stays on the host.
 */
interface ActiveLoginAttempt {
  readonly attempt: LoginAttempt;
  readonly controller: AbortController;
  readonly expiresAt: number;
  nextPollSeconds: number;
  polling?: Promise<LoginPollResult>;
}

const MAX_LOGIN_ATTEMPTS = 32;

export class LoginService extends TypertRemoteService {
  readonly #options: LoginServiceOptions;
  /** Each browser tab owns its own device authorization. */
  readonly #attempts = new Map<string, ActiveLoginAttempt>();
  readonly #starting = new Set<string>();

  #expireAttempts(now = Date.now()): void {
    for (const [flowId, current] of this.#attempts) {
      if (now >= current.expiresAt) {
        current.controller.abort();
        this.#attempts.delete(flowId);
      }
    }
  }

  #forgetAttempt(flowId: string, current: ActiveLoginAttempt): void {
    if (this.#attempts.get(flowId) === current) {
      this.#attempts.delete(flowId);
    }
    current.controller.abort();
  }

  constructor(ctx: unknown, options: LoginServiceOptions = {}) {
    if (!isRecord(ctx)) {
      throw new TypeError("LoginService requires a Cordis context object");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `TypertRemoteService` takes cordis `Context`, whose types ship only from the Harness installation; the object guard above is the runtime check this stands in for.
    super(ctx as never, "opencodeLogin");
    this.#options = options;
  }

  #client(): ConsoleAuthClient {
    return new Client({
      ...(this.#options.consoleBaseUrl === undefined
        ? {}
        : { baseUrl: this.#options.consoleBaseUrl }),
      ...(this.#options.fetch === undefined
        ? {}
        : { fetch: this.#options.fetch }),
    });
  }

  #store(plane: string): TokenStore | undefined {
    return createTokenStore({
      credentials: this.#options.credentials ?? readCredentialsWriter(this.ctx),
      plane,
      scope: name,
    });
  }

  /**
   * Start a device flow and answer the code a human approves.
   *
   * @param query - which plane to sign in to; the account is the same for both.
   * @returns the challenge to render.
   * @throws {Error} when no login can be kept, or the Console issues no code.
   */
  async begin(query?: LoginBeginQuery): Promise<LoginChallenge> {
    const plane = planeOf(query);
    this.#expireAttempts();
    if (this.#attempts.size + this.#starting.size >= MAX_LOGIN_ATTEMPTS) {
      throw new Error("too many login flows are already in progress");
    }
    const flowId = globalThis.crypto.randomUUID();
    this.#starting.add(flowId);
    try {
      const store = this.#store(plane);
      const attempt = await beginLogin({ client: this.#client(), store });
      if (attempt === undefined) {
        throw new Error(
          "this composition mounts no credential service, so a login cannot be kept"
        );
      }
      const { authorization } = attempt;
      const active: ActiveLoginAttempt = {
        attempt,
        controller: new AbortController(),
        expiresAt: Date.now() + authorization.expiresInSeconds * 1000,
        nextPollSeconds: Math.max(authorization.intervalSeconds, 1),
      };
      this.#attempts.set(flowId, active);
      if (Date.now() >= active.expiresAt) {
        this.#forgetAttempt(flowId, active);
        throw new Error("the device code expired before it could be shown");
      }

      return {
        expiresInSeconds: authorization.expiresInSeconds,
        flowId,
        intervalSeconds: authorization.intervalSeconds,
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        ...(authorization.verificationUriComplete === undefined
          ? {}
          : { verificationUriComplete: authorization.verificationUriComplete }),
      };
    } finally {
      this.#starting.delete(flowId);
    }
  }

  /**
   * Ask whether the human has approved the attempt in flight.
   *
   * @returns `pending` while they have not, `signed-in` once the login is
   * stored, and `failed` with a reason when it never will be.
   */
  async poll(query: LoginPollQuery): Promise<LoginPollResult> {
    const { flowId } = query;
    const current = this.#attempts.get(flowId);
    if (current === undefined) {
      return { detail: "no login is in progress", kind: "failed" };
    }
    if (Date.now() >= current.expiresAt) {
      this.#forgetAttempt(flowId, current);
      return { detail: "the device code expired", kind: "failed" };
    }
    this.#expireAttempts();
    if (current.polling !== undefined) {
      return current.polling;
    }
    const polling = this.#pollAttempt(flowId, current);
    current.polling = polling;
    try {
      return await polling;
    } finally {
      if (current.polling === polling) {
        current.polling = undefined;
      }
    }
  }

  async #pollAttempt(
    flowId: string,
    current: ActiveLoginAttempt
  ): Promise<LoginPollResult> {
    let outcome;
    try {
      outcome = await current.attempt.poll(current.controller.signal);
    } catch (error) {
      if (current.controller.signal.aborted) {
        this.#forgetAttempt(flowId, current);
        return { detail: "login was cancelled", kind: "failed" };
      }
      throw error;
    }
    // A cancellation during account/org reads must not commit a granted token.
    if (
      current.controller.signal.aborted ||
      this.#attempts.get(flowId) !== current
    ) {
      this.#forgetAttempt(flowId, current);
      return { detail: "login was cancelled", kind: "failed" };
    }
    if (outcome.kind === "pending") {
      return {
        intervalSeconds: current.nextPollSeconds,
        kind: "pending",
      };
    }
    if (outcome.kind === "slow_down") {
      current.nextPollSeconds *= 2;
      return {
        intervalSeconds: current.nextPollSeconds,
        kind: "slow_down",
      };
    }
    this.#forgetAttempt(flowId, current);
    if (outcome.kind === "signed-in") {
      return { kind: "signed-in" };
    }
    return { detail: outcome.detail, kind: "failed" };
  }

  /** Cancel one flow without affecting logins in other windows. */
  cancel(query: LoginCancelQuery): { readonly kind: "cancelled" } {
    const current = this.#attempts.get(query.flowId);
    if (current !== undefined) {
      this.#forgetAttempt(query.flowId, current);
    }
    return { kind: "cancelled" };
  }

  /**
   * What is stored for a plane, without the credential.
   *
   * @param query - which plane to describe.
   * @returns the state, with `signedIn` false when nothing is stored.
   */
  async state(query?: LoginBeginQuery): Promise<LoginState> {
    const plane = planeOf(query);
    const login = await this.#store(plane)?.read();
    if (login === undefined) {
      return { orgs: [], plane, signedIn: false };
    }
    // A login that has just completed is the event the org cache was waiting for.
    setOrg(plane, login.orgId);
    return {
      ...(login.owner?.email === undefined ? {} : { email: login.owner.email }),
      ...(login.orgId === undefined ? {} : { orgId: login.orgId }),
      orgs: (login.orgs ?? []).map((org) => ({ id: org.id, name: org.name })),
      plane,
      signedIn: true,
    };
  }
}

// `@Remote()` cannot be used: this build transform rejects TC39 decorator
// syntax, and the decorator only writes this one property. See `usage.ts` for
// the full note.
Object.defineProperty(LoginService.prototype, REMOTE_METHOD_DESCRIPTOR_KEY, {
  configurable: true,
  value: Object.freeze({
    methods: Object.freeze([
      { invocation: { kind: "direct" }, method: "begin" },
      { invocation: { kind: "direct" }, method: "poll" },
      { invocation: { kind: "direct" }, method: "cancel" },
      { invocation: { kind: "direct" }, method: "state" },
    ]),
    version: 1,
  }),
});
