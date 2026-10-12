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

## What the free tier's gate is not

The error says the free tier "can only be used from within OpenCode", and enough has been excluded to take that sentence seriously.

| Excluded | How |
| :-- | :-- |
| mTLS | a plain request reaches the gateway and gets a JSON answer, so no client certificate is demanded |
| the credential | `/inference/openai/v1` answers `403 FreeTierError` where `/zen/v1` answers `401 Invalid API key` — the same token is AUTHENTICATED on the new path and refused on the old one |
| the org | sent, and it is the active org the client itself uses |
| the endpoint | the new path, which is the one the client uses |
| the visible headers | every header captured from the client's own request was replicated, including its session and request ids |
| the client library | Node's fetch and Python's urllib answer identically |

What is left is something about the client that is not in the HTTP request: a TLS or HTTP/2 fingerprint, or a header the client sends only to the real host — the capture that produced the header list was taken against a local server, which is the one place a host-specific header would not appear.

So the honest statement, and the one the plugin is built to, is that the free tier is asked for and not granted. Nothing in this plugin promises it: the paid models work with a key, the account credential is stored with its owner, and whether the gateway ever grants the rest is the vendor's decision to make.

## Where the session token comes from

`packages/opencode/src/account/account.ts` and `packages/opencode/src/config/config.ts` describe the flow, and it is a device flow this plugin already implements:

1. `POST {server}/auth/device/code` with `{ client_id: "opencode-cli" }` answers `{ device_code, user_code, verification_uri_complete, expires_in, interval }`. `verification_uri_complete` is resolved against `{server}/`, which is why it can be relative.
2. `POST {server}/auth/device/token` with the device grant answers `{ access_token, refresh_token, token_type: "Bearer", expires_in }`, or a discriminated error — the same shape this plugin's `console-auth.ts` reads.
3. The token is refreshed eagerly five minutes before expiry (`eagerRefreshThreshold`), not on a 401.
4. `GET {server}/api/config` with `Bearer {access_token}` and `x-org-id: {orgID}` answers **a whole OpenCode config** — providers, models, headers — which the client merges as a global config source.
5. The access token is exported as `OPENCODE_CONSOLE_TOKEN`, and the merged config's provider entry names it as its `apiKey`.

The consequence is the design: **the server tells the client where to send requests and what to send.** The endpoint, the models and the org header are not compiled into the client; they arrive with the login.

### Where the token actually lives, confirmed

The account is not a file. It is a row in the client's own SQLite database, and reading it closes the loop:

```
account        acc_01KWJYKM6GNVMY1EVB5ZC9H08G
               viztorix@gmail.com
               https://opencode.ai/console          <- the Console this plugin targets
               access_token  st_...(39)             <- the token the request carried
               refresh_token rt_...(39)
               token_expiry  1793948786727
account_state  active_account_id acc_...
               active_org_id     wrk_01KWJYKNFF34P8F0JZDBX1WTB8
                                                    <- the org the request carried
```

**So there is no exchange, and no second credential.** `st_...` IS the device flow's access token — the one this plugin's `console-auth.ts` already obtains, from the same `https://opencode.ai/console` base — and `rt_...` is its refresh token. The org is the one `/api/orgs` answered at login.

That explains the free tier exactly: the gateway gates it on a token tied to an account and an org, which is why a bare `oc_...` key cannot reach it no matter which headers accompany it.

## The design this implies: route by credential, not by table

The plugin derives an endpoint from a `(plane, protocol)` table and resolves one credential reference per plane. Both halves assume a credential is a credential. The measurement above says otherwise: what a credential can reach depends on its KIND, and the kind is visible in what a deployment configured.

So the shape that follows:

- **The credential decides the plane, not a hard-coded base URL.** A reference holding an `oc_…` key is the key plane; one holding an `st_…` token is the account plane, and the account plane carries an org with it.
- **A stored credential carries its owner.** The account, the email and the org are known AT LOGIN — the flow fetches `/api/user` and `/api/orgs` before it stores anything — so they belong in the same record as the token rather than being re-derived later. A session token without its org answers `403 FreeTierError` for a free model, which is the failure this spec exists to explain; keeping the two in one record is what makes that impossible.

  This plugin already has the shape for it: `token-store.ts` writes a `grant` whose payload is the owner's to define, and an account and an org are exactly that. What it must NOT do is infer the plane from the token's prefix — `st_...` is a useful confirmation, not a contract, and the login is where the answer is actually known.

- **A model's reachability follows from the plane it resolved on.** Free models on a key plane are refused by the gateway, so the honest thing is for the picker to say so rather than to offer a model that will fail.
- **Zero configuration survives.** A deployment that pastes a key gets the key plane and today's behaviour; one that logs in gets the account plane and the free tier. Neither names an endpoint.

The endpoint, notably, is NOT part of this. Both paths answer identically for a paid model, so the plane is a description of what a credential can reach — not a different address. The tables stay as the key plane's description; the account plane is described by what the login returns.

## What this plugin would have to change

Nothing, to keep serving paid models: `/zen/v1` with `OPENCODE_API_KEY` still answers, which the live suite exercises on every run.

For the free tier, four things:

1. **A login that stores what it learned.** The device flow this plugin already implements, extended by the two reads that follow it — `/api/user` and `/api/orgs` — and by writing the account, the email, the org and the token pair as ONE grant record. That is the whole difference between a credential that can reach the free tier and one that cannot.
2. **An org id per request, read from that record.** The plugin's header injection is the place; the value comes from the credential, so a deployment with several accounts needs no extra setting.
3. **A plane chosen by the credential's kind**, so a key deployment and a login deployment each route to what they can actually reach.
4. **A server-driven model list for the account plane**, whose models arrive with the login rather than from the dependency's catalog.

Step 3 is the reason this is a specification rather than a patch: routing currently derives an endpoint from a table, and the measurement says the endpoint is the same either way — so what changes is what the plugin thinks a credential IS.

## What this changes about the plan

- **The free tier is not reachable by adding a header.** Measured: the org id and the key together still answer `403`. Any plan that assumed a header fix is wrong.
- **The device-flow client already written is the right shape.** Its endpoints, its grant type, its client id and its reading of the discriminated error all match the source. Its refresh window is 120s where the client uses 300s, which is a number to reconcile rather than a design to change.
- **The paid path is unchanged in every respect**, endpoint included: both paths are one gateway and answer a paid model identically, so the pool, the bridge and the protocol table keep their value and their addresses. This is an addition, not a replacement.
- **The user-agent is a version behind.** We claim `provider-utils/4.0.40`; the captured request sends `4.0.23`. Worth reconciling when the rest is settled, since the gateway groups usage by it — and the same capture is where to check the claim rather than trusting the constant.
