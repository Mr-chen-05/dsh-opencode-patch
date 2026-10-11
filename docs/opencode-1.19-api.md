# OpenCode 1.19.0: the API that moved

A specification of what this plugin talks to, what OpenCode 1.19.0 talks to instead, and what a migration would have to change. Written because the difference is not cosmetic: an API key that authenticates a paid model is refused for a free one, and the free tier is where this plugin's original reason for existing lives.

Everything below is measured. Where something is not, it says so.

## The short version

|  | An `oc_…` API key | An `st_…` session token |
| :-- | :-- | :-- |
| Paid models | served | served |
| Free-tier models | `403 FreeTierError` | served |
| Org context | not required | `x-opencode-org-id: wrk_…` |
| Per-request id | not required | `x-opencode-request: msg_…` |
| Where it comes from | a key a deployment pastes or exports | an account login |

**What decides a request is the credential, not the path.** Measured across both paths with one key: `grok-4.7` answers `400 ModelProtocolUnsupported` on `/zen/v1` and on `/inference/openai/v1` alike, and `qwen3.8-max` answers the same `403` upstream error on both. They are two paths into one gateway, and for a paid model the choice between them changes nothing.

The difference is entirely in what a credential can reach. A key reaches paid models; a session token reaches paid models and free ones, because the free tier is gated on the token and the org that comes with it.

So a deployment's API key keeps working exactly as it does today, and the free tier becomes reachable by logging in — not by changing a URL.

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

## The design this implies: route by credential, not by table

The plugin derives an endpoint from a `(plane, protocol)` table and resolves one credential reference per plane. Both halves assume a credential is a credential. The measurement above says otherwise: what a credential can reach depends on its KIND, and the kind is visible in what a deployment configured.

So the shape that follows:

- **The credential decides the plane, not a hard-coded base URL.** A reference holding an `oc_…` key is the key plane; one holding an `st_…` token is the account plane, and the account plane carries an org with it.
- **The org travels with the token.** It is not a separate setting to keep in step. A session token without its org answers `403 FreeTierError` for a free model — which is the failure this spec exists to explain — so the two are one credential in two fields, and treating them as one unit is what makes them impossible to get out of step.
- **A model's reachability follows from the plane it resolved on.** Free models on a key plane are refused by the gateway, so the honest thing is for the picker to say so rather than to offer a model that will fail.
- **Zero configuration survives.** A deployment that pastes a key gets the key plane and today's behaviour; one that logs in gets the account plane and the free tier. Neither names an endpoint.

The endpoint, notably, is NOT part of this. Both paths answer identically for a paid model, so the plane is a description of what a credential can reach — not a different address. The tables stay as the key plane's description; the account plane is described by what the login returns.

## What this plugin would have to change

Nothing, to keep serving paid models: `/zen/v1` with `OPENCODE_API_KEY` still answers, which the live suite exercises on every run.

For the free tier, four things:

1. **A credential that is a session token, not a key.** The pool already holds credential references and resolves them per operation, so an entry can name `OPENCODE_CONSOLE_TOKEN` — but the reference must resolve to an `st_…` token, which means a login, not a pasted key.
2. **An org id per request, carried with the token.** The plugin's header injection is the place; the value comes from the account, and a deployment may have several.
3. **A plane chosen by the credential's kind**, so a key deployment and a login deployment each route to what they can actually reach.
4. **A server-driven model list for the account plane**, whose models arrive with the login rather than from the dependency's catalog.

Step 3 is the reason this is a specification rather than a patch: routing currently derives an endpoint from a table, and the measurement says the endpoint is the same either way — so what changes is what the plugin thinks a credential IS.

## What this changes about the plan

- **The free tier is not reachable by adding a header.** Measured: the org id and the key together still answer `403`. Any plan that assumed a header fix is wrong.
- **The device-flow client already written is the right shape.** Its endpoints, its grant type, its client id and its reading of the discriminated error all match the source. Its refresh window is 120s where the client uses 300s, which is a number to reconcile rather than a design to change.
- **The paid path is unchanged in every respect**, endpoint included: both paths are one gateway and answer a paid model identically, so the pool, the bridge and the protocol table keep their value and their addresses. This is an addition, not a replacement.
- **The user-agent is a version behind.** We claim `provider-utils/4.0.40`; the captured request sends `4.0.23`. Worth reconciling when the rest is settled, since the gateway groups usage by it — and the same capture is where to check the claim rather than trusting the constant.
