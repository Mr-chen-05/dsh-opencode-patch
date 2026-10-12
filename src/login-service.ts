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
  LoginChallenge,
  LoginPollResult,
  LoginState,
} from "./login-contract.ts";
import { beginLogin, type LoginAttempt } from "./login-flow.ts";
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
export class LoginService extends TypertRemoteService {
  readonly #options: LoginServiceOptions;
  /** The attempt a human is holding, if any. */
  #attempt: LoginAttempt | undefined;

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
    const store = this.#store(plane);
    const attempt = await beginLogin({ client: this.#client(), store });
    if (attempt === undefined) {
      throw new Error(
        "this composition mounts no credential service, so a login cannot be kept"
      );
    }
    this.#attempt = attempt;
    const { authorization } = attempt;
    return {
      expiresInSeconds: authorization.expiresInSeconds,
      intervalSeconds: authorization.intervalSeconds,
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      ...(authorization.verificationUriComplete === undefined
        ? {}
        : { verificationUriComplete: authorization.verificationUriComplete }),
    };
  }

  /**
   * Ask whether the human has approved the attempt in flight.
   *
   * @returns `pending` while they have not, `signed-in` once the login is
   * stored, and `failed` with a reason when it never will be.
   */
  async poll(): Promise<LoginPollResult> {
    const attempt = this.#attempt;
    if (attempt === undefined) {
      return { detail: "no login is in progress", kind: "failed" };
    }
    const outcome = await attempt.complete();
    if (outcome.kind === "signed-in") {
      // The attempt is spent: the flow it belongs to has produced a stored login.
      this.#attempt = undefined;
      return { kind: "signed-in" };
    }
    // A refusal is terminal, so the attempt is dropped; a wait is not, and the
    // surface is expected to ask again.
    if (!outcome.detail.includes("pending")) {
      this.#attempt = undefined;
      return { detail: outcome.detail, kind: "failed" };
    }
    return { kind: "pending" };
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
      { invocation: { kind: "direct" }, method: "state" },
    ]),
    version: 1,
  }),
});
