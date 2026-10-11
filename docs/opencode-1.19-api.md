# OpenCode 1.19.0: the API that moved

A specification of what this plugin talks to, what OpenCode 1.19.0 talks to instead, and what a migration would have to change. Written because the difference is not cosmetic: an API key that authenticates a paid model is refused for a free one, and the free tier is where this plugin's original reason for existing lives.

Everything below is measured. Where something is not, it says so.

## The short version

|  | This plugin today | OpenCode 1.19.0 |
| :-- | :-- | :-- |
| Model endpoint | `https://opencode.ai/zen/v1` | `https://opencode.ai/inference/openai/v1` |
| Credential | `OPENCODE_API_KEY`, an `oc_…` key | `OPENCODE_CONSOLE_TOKEN`, an `st_…` session token |
| Free-tier models | `403 FreeTierError` | served |
| Paid models | served | served |
| Org context | absent | `x-opencode-org-id: wrk_…`, required for the free tier |
| Per-request id | absent | `x-opencode-request: msg_…` |

So: **paid models still work through what this plugin already does, and free models do not.** A deployment that wants the free tier needs the new credential, and the new credential comes from an account login rather than a key.

## What OpenCode 1.19.0 resolves for itself

`opencode debug config` prints the configuration the running client actually uses. For the `opencode` provider, on this machine, with an account signed in:

```json
{
  "name": "Default / OpenCode",
  "npm": "@ai-sdk/openai-compatible",
  "api": "https://opencode.ai/inference/openai/v1",
  "env": ["OPENCODE_CONSOLE_TOKEN"],
  "options": {
    "apiKey": "…",
    "headers": { "x-opencode-org-id": "wrk_…" }
  },
  "models": 84,
  "whitelist": ["big-pickle", "claude-fable-5-1", …, "space-bunny-free", …]
}
```

Three facts, each load-bearing:

- **The endpoint is not `/zen/v1`.** It is `/inference/openai/v1`, spoken through the OpenAI-compatible SDK.
- **The credential is not an API key.** `OPENCODE_CONSOLE_TOKEN` is set from the signed-in account's access token, and `apiKey` in the provider options is that token.
- **The org is named on every request.** `x-opencode-org-id` carries the active workspace, and the free tier is refused without it.

## The request, captured

Pointing the real client at a local server (`OPENCODE_CONFIG_CONTENT` overriding the provider's `baseURL`) captures exactly what it sends:

```
POST /v1/chat/completions
authorization:        Bearer st_3624847b-9048-4656-87ab-309f1516f6bb
user-agent:           opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client:    cli
x-opencode-org-id:    wrk_01KWJYKNFF34P8F0JZDBX1WTB8
x-opencode-project:   global
x-opencode-request:   msg_129d5521b001jov4K0kGYl97tO
x-opencode-session:   ses_ed62aae61ffeA6UwzEFN9YNKk8
x-opencode-session-id: ses_ed62aae61ffeA6UzEFN9YNKk8
```

Against this plugin's headers, the additions are `x-opencode-org-id` and `x-opencode-request`, and the credential differs in kind: `st_…` where we send `oc_…`.

One correction for the record: the `x-opencode-ticket` header this investigation first suspected is `PTY_CONNECT_TOKEN_HEADER` — a terminal websocket ticket, not a model credential. It was read from the binary's strings before the source was available, and the source says otherwise.

## Which credential unlocks which models

Measured, one request each, `space-bunny-free` on both endpoints:

| Credential sent | `/zen/v1` | `/inference/openai/v1` |
| :-- | :-- | :-- |
| the deployment's `oc_…` key | `403 FreeTierError` | `403 FreeTierError` |
| the same key plus `x-opencode-org-id` | `403 FreeTierError` | `403 FreeTierError` |
| the literal `public` | `403 FreeTierError` | `403 FreeTierError` |
| the real client's `st_…` token | — | served |

The literal `public` is worth recording because the source suggests it: a provider with no credential keeps only zero-cost models and answers `options: { apiKey: "public" }`. That is a local placeholder for the SDK, not a credential the gateway accepts, and this measurement is what says so.

So the free tier's gate is the **session token**, and the org id alone does not open it.

## Where the session token comes from

`packages/opencode/src/account/account.ts` and `packages/opencode/src/config/config.ts` describe the flow, and it is a device flow this plugin already implements:

1. `POST {server}/auth/device/code` with `{ client_id: "opencode-cli" }` answers `{ device_code, user_code, verification_uri_complete, expires_in, interval }`. `verification_uri_complete` is resolved against `{server}/`, which is why it can be relative.
2. `POST {server}/auth/device/token` with the device grant answers `{ access_token, refresh_token, token_type: "Bearer", expires_in }`, or a discriminated error — the same shape this plugin's `console-auth.ts` reads.
3. The token is refreshed eagerly five minutes before expiry (`eagerRefreshThreshold`), not on a 401.
4. `GET {server}/api/config` with `Bearer {access_token}` and `x-org-id: {orgID}` answers **a whole OpenCode config** — providers, models, headers — which the client merges as a global config source.
5. The access token is exported as `OPENCODE_CONSOLE_TOKEN`, and the merged config's provider entry names it as its `apiKey`.

The consequence is the design: **the server tells the client where to send requests and what to send.** The endpoint, the models and the org header are not compiled into the client; they arrive with the login.

What is NOT measured: how `st_…` is minted from the stored `oc_…` key. The account store holds an `api` credential and no account record on this machine, yet the captured request carried an `st_…` token, so an exchange happens somewhere this investigation did not reach. A migration needs that answer before it can produce the token itself.

## What this plugin would have to change

Nothing, to keep serving paid models: `/zen/v1` with `OPENCODE_API_KEY` still answers, which the live suite exercises on every run.

For the free tier, four things:

1. **A credential that is a session token, not a key.** The pool already holds credential references and resolves them per operation, so an entry can name `OPENCODE_CONSOLE_TOKEN` — but the reference must resolve to an `st_…` token, which means a login, not a pasted key.
2. **An org id per request.** The plugin's header injection is the place; the value comes from the account, and a deployment may have several.
3. **The new endpoint**, which is per-provider rather than global, so the per-protocol base table is the wrong shape for it — the server-supplied config is the right one.
4. **A server-driven config source**, if the plugin wants to follow the models and endpoints the vendor publishes rather than a catalog pinned in a dependency.

Steps 3 and 4 are the reason this is a specification rather than a patch: the plugin's routing derives an endpoint from a table, and the new API derives it from a login.

## What this changes about the plan

- **The free tier is not reachable by adding a header.** Measured: the org id and the key together still answer `403`. Any plan that assumed a header fix is wrong.
- **The device-flow client already written is the right shape.** Its endpoints, its grant type, its client id and its reading of the discriminated error all match the source. Its refresh window is 120s where the client uses 300s, which is a number to reconcile rather than a design to change.
- **`/zen/v1` remains the paid path**, so the pool, the bridge and the protocol table keep their value. This is an addition, not a replacement.
- **The user-agent is a version behind.** We claim `provider-utils/4.0.40`; the captured request sends `4.0.23`. Worth reconciling when the rest is settled, since the gateway groups usage by it.
