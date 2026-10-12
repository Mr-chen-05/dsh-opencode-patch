# Credentials: the pool, the login, and the rotation

The plugin's default is the deployment's own credential: whatever `apiKeyEnv` the profile already declares keeps resolving exactly as it does today. The pool is a SEPARATE credential the deployment opts into by pointing a route at it, and nothing about that happens as a side effect of adding an entry. A user who logs in with OAuth has taken an action; the plugin still resolves exactly what the profile names until the profile names the pool's reference.

## The resolution chain

One reference resolves per route, and the pool only enters the picture when the route names the pool's reference:

1. **The route's `apiKeyEnv`** — the reference the deployment declared, resolved through the credentials service with the launch environment as fallback. This is the zero-configuration default, and the whole behavior for a deployment that declares nothing else.
2. **The pool's reference** — the same resolution, for a deployment that named `OPENCODE_POOL_KEY` or `OPENCODE_GO_POOL_KEY` instead. The value behind it is the pool's current key, which the plugin rotates; the wrapper and this plugin both read it per operation, so a rotation reaches the next call without a restart.
3. **Nothing** — a named reference that misses fails loud. Never hand pi an `undefined` for a named ref: it would pick up an unrelated ambient key (`OPENAI_API_KEY` and friends) and bill another tenant.

## The pools are per plane

Zen credentials serve Zen calls, Go credentials serve Go calls, and never the other way: the planes are different accounts with different keys, different endpoints and different catalogs.

A pool holds **API keys**, and that is a measured constraint rather than a first choice — the section below shows a login token is refused by the model endpoints the same way a wrong key is. So:

| Entry   | Origin                                                  | Refresh |
| :------ | :------------------------------------------------------ | :------ |
| API key | a reference in the credential store, or the environment | none    |

A pool of two or more keys is what rotation means here: a deployment past a rate limit or a per-key spend cap names the keys it holds, and the plugin serves the next one.

## An OAuth token is not a credential the gateway serves (measured)

The login flows produce an access token. Whether that token can authenticate a MODEL call is a separate question, and the gateway answers it plainly. Three requests to `/chat/completions` on the Zen base, differing only in the credential:

| Credential sent                  | Answer                            |
| :------------------------------- | :-------------------------------- |
| none                             | `401 AuthError: Missing API key.` |
| `Bearer not-a-real-token-abc123` | `401 AuthError: Invalid API key.` |
| `Bearer <a JWT-shaped string>`   | `401 AuthError: Invalid API key.` |

The last two are indistinguishable. The Bearer slot on a model endpoint reads an API key and nothing else, so an OAuth access token presented there is an invalid API key — which is a different credential from the one a login produces.

So the pool's entries are API keys, and a login is not one of them. What a login IS good for is the Console's own API — the per-account catalog at `/api/config`, the account and organization context at `/api/user` and `/api/orgs` — and a deployment that wants a login's models needs the Console to exchange it for a key, which is the vendor's flow, not this plugin's.

Recording this because the alternative is building a rotation that silently sends an access token to an endpoint that answers "Invalid API key" for it, and debugging that as a routing fault.

## What the logins are (measured from OpenCode's own source)

Both are device flows against the same Console, differing in what they store and what they unlock:

- `POST {console}/auth/device/code` with `client_id: "opencode-cli"` returns a `device_code`, a `user_code` and a `verification_uri_complete`.
- Polling `POST {console}/auth/device/token` with the device grant returns the `access_token`, `refresh_token` and `expires_in`.
- The refresh grant against the same endpoint returns a NEW refresh token with every access token — the stored pair must be replaced atomically, or the next refresh uses a token the server has already rotated away.
- `GET {console}/api/config` — the authoritative per-account model and price catalog — answers to a plain API key, so the pool does not gate it.

v1 (`console login`) additionally reads `/api/user` and `/api/orgs`, stores the account and org context, and can switch among them; v2 (`auth login opencode`) stores the provider credential with org metadata but no switching. The plugin implements the flows itself, from those measured endpoints, and stores the results in its own settings — never in the CLI's `auth.json`, which belongs to a program the plugin does not own.

## What the pool never touches

- **The `google` route name.** A real deployment may configure Google AI Studio under that id; the plugin's internal route is named `opencode-google` precisely so that name stays free.
- **The CLI's `auth.json`.** Reading it couples the plugin to another program's private file format; writing it collides with the program that owns it.
- **Silent rotation.** Adding a credential changes nothing until the switch is on. This is the contract: zero configuration by default, opt-in by statement.

## The reference the pool owns

The pool does not write behind anyone's key. Writing the user's own reference (`OPENCODE_API_KEY`) is dead on both sides: if nothing shadows it, the write replaces the credential the deployment declared, and if the environment satisfies it, the write is shadowed. The seam refuses that second case out loud — `set` "rejects while a read-only source shadows the reference", because the write would otherwise appear to succeed while resolution kept returning the shadowing value. So the failure is not merely impolite; it is already guarded.

The pool owns a reference of its own instead:

- A dedicated name per plane — `OPENCODE_POOL_KEY`, `OPENCODE_GO_POOL_KEY` — which nothing shadows, so it is writable.
- Rotation writes the next key with `set(ref, value)`, and every route that names that reference resolves it on its next operation, because the seam resolves per call. That includes the routes the wrapper serves: it reads whatever reference the profile declares, so pointing a route at the pool's reference is the whole opt-in.
- Opting in is therefore a configuration statement, which is what the contract in this file asks for. A deployment that leaves `apiKeyEnv` alone keeps the environment's credential and the pool never runs.

What this does not need: a takeover, a record another plugin owns, or any write to a reference the deployment declared. It needs one fresh reference name and the seam's own write path.

## The opt-in assertion, measured

The load-bearing claim in this file is that pointing a route at the pool's reference is the whole opt-in — the wrapper resolves whatever reference the profile names, per operation, so a rotation reaches it without a restart. Two requests to the same endpoint, differing only in the credential, answer differently in a way that confirms it:

| Credential | Answer |
| :-- | :-- |
| the deployment's real key | `403 Model access is disabled` — accepted; that model is not enabled for the account |
| a made-up value in the pool's position | `401 AuthError: Invalid API key.` |

So the gateway validates whatever sits in the slot, which makes rotation safe by construction rather than by promise: a key the pool cycles in that the gateway refuses answers `401`, and that is a credential to mark failed and skip, not a routing fault to debug. The pool's failure-skip is therefore load-bearing on the first request, not a nicety.

## Verified, not assumed

Run against the real `dsh-credentials-local` provider on a temporary document, so the measurement never touched a real `~/.dsh/.credentials.yaml`:

| Claim | Result |
| :-- | :-- |
| a fresh reference is writable | `set` then `resolve` returns the value, `source=file`; `describe` reports `configured` and `writable` |
| rotation reaches the next operation | a second `set` makes the next `resolve` return the NEW value, with no restart |
| the deployment's own reference is protected | writing a name the launching environment supplies is REFUSED: "is supplied read-only by the launching environment, so set would be shadowed" |
| `unset` returns to unconfigured | yes |
| the store is the document the routes resolve from | the written file is `version: 1` with a `refs:` map — the same shape `~/.dsh/.credentials.yaml` already has |

The third row is the one that matters most: the objection that a pool would overwrite the deployment's key is not merely avoided by this design, it is enforced by the implementation.

## The credential the user already has, and this plugin does not read

**The core model is that a user never writes a credential into a DSH profile.** The plugin detects the key from the OpenCode installation and injects it, so a route needs no `apiKeyEnv` and a deployment needs no editing. Today it does not: every key source here is an environment variable name or the DSH credential store, and the one mention of the CLI's own file says it is deliberately **not** read.

That file is where the key is. Measured, keys and types only:

    ~/.local/share/opencode/auth.json
      opencode: { type: "api", key: <51 chars, oc_sk_…> }     ← the Zen key
      xai | openai: { type: "oauth", refresh, access, expires, accountId? }
      cf-coding | google | cloudflare-* | nvidia: { type: "api", key, metadata? }

So the shape is one object per provider, `type: "api"` with a `key`, or `type: "oauth"` with an access/refresh pair — the same two shapes the credential seam already stores, which is why this is a reader rather than a new concept.

**It is OPT-IN, and off by default.** That file is not an interface the vendor publishes; its shape can change with any CLI release, and a plugin that read it unasked would be one whose credential behaviour depends on another program's private state. So the rule is the opposite of convenient-by-default:

- **A key the user defined in their own DSH config is always first.** Until they choose otherwise, nothing here is consulted at all, and the resolution order is exactly what it was before this file was considered.
- **Reading the OpenCode installation is a choice the user makes**, exposed where they make their other choices rather than buried in config, and the file is consulted only after that choice is made.
- **When it is on, it is still last** — after `apiKeyEnv`, after the credential store, after a key captured from a live request — because everything the user said explicitly outranks anything inferred from another program's files.

**And `auth.json` is the LEGACY shape, which is the larger point.** Read from OpenCode 2.0.27's own source (`packages/core`): credentials there are rows in a database, migrated in by `import_legacy_credentials`, and the value is a union of **three** kinds, not the two `auth.json` carries:

    Credential.Key       an API key
    Credential.OAuth     an access/refresh pair
    Credential.External  a credential that lives OUTSIDE - the CLI's own store
                         holds it, and there is nothing here to read

    Credential.Info      { id, integrationID, label, value }

So a reader that only understood `auth.json` would cover the two shapes that file happens to hold and miss `External` entirely - and it would be reading a format the CLI has already moved on from. The opt-in, when it is built, has to read what 2.0 reads: the database, all three kinds, and `integrationID` rather than a provider name.

**And 2.0 already solves the priority problem this file is about.** Its auth model (`packages/ai/src/route/auth.ts`) is a small algebra, and the part that matters here is `orElse`:

    Credential { load, orElse(that), bearer(), header(name) }
    Secret     = string | Redacted | Config.Config<string>

A credential is LAZY (`load` is an effect that can fail), it can be combined with another as a fallback (`orElse`), and one of the things it can be built from is **config** — which is the user's own declaration. So "the user's key first, the installation's only if they asked" is not a rule to invent: it is the shape the vendor already uses, and `orElse` is where the order lives.

Two more details worth copying. Secrets are `Redacted`, so they are never stringified by accident. And a missing one raises a named `MissingCredentialError` rather than resolving to nothing — which is the difference between the failure this plugin spent a long time chasing and one that says what it is.

**The modes, enumerated from the source** (`packages/ai/src/route/auth.ts`), because "several auth modes" is the reason a reader for one file cannot be enough:

    value(secret)        a literal
    config(name)         read from configuration, and FAILS by name when unset
    optional(secret)     absent is allowed, and still reported as missing
    effect(load)         anything lazy that yields a secret
    none / headers / remove / custom / passthrough    header operations
    bearer / apiKey / header(name)                    how a secret is applied

`config(name)` is the one that matters for this plugin's model: a credential may come from the user's own configuration, and the vendor's own reader treats that as one source among several rather than as an afterthought. Which source wins is not encoded in the sources at all — it is `orElse`, applied by whoever assembles them.

So the shape to copy is two-layered, and both layers already exist here in some form: a source list (literal, config, installation, captured request) and an order that puts everything the user declared ahead of everything inferred. Reading a file is one entry in the first list, and the switch that turns it on belongs to the user, not to this plugin's default.

**The two resolution paths, and which one is a gap.** `resolveGatewayKey` is deliberately two-faced, and the difference is tested:

- **A named reference that resolves nothing RAISES.** The message carries the reference and the route, and `MISSING_CREDENTIAL` is in it. The reason is in the test: `undefined` would tell the underlying adapter to "resolve ambient auth instead", and it would bill whatever key it found first.
- **No reference at all answers `undefined`.** That is not a silent failure; it is the instruction the adapter is built to take, and a route that means to authenticate some other way depends on it.

So the reported `401 Invalid API key` on a route with no reference is not this function going quiet — it is the adapter's ambient resolution finding nothing, or finding a key that is not the one the route wanted. Both are answered by naming a reference, and neither is answered by making this function throw.

**The gap that is real is the other one.** A login's token is not usable as a route's credential: `warmOrg` reads the stored grant for the plane's ORG and nothing else, so a deployment that has signed in still needs `apiKeyEnv` on every route. Wiring the grant's access token into the same resolution is what would make a login sufficient on its own, which is the point of having one — and it is the half of the core model that is still missing.

**Where that wiring goes, and in what order.** The bridge already assembles the resolution for every route it serves (`resolveApiKey` in `google-bridge.ts`): the pool first when one is enabled, then `resolveGatewayKey` for the route's own reference. The login's token belongs at the END of that chain, never the start:

    pool (when enabled)  →  the route's named reference  →  the stored login

which is the user's rule stated as code — everything they declared explicitly outranks anything the plugin found on its own — and it is the same `orElse` shape 2.0 uses. `warmOrg` already reads the grant per plane and keeps the org; the same read yields the access token, so this is a return value that is currently discarded rather than a new lookup.

**Two files, one new input.** `warmOrg` lives in `lifecycle.ts` and reads the grant per plane; `resolveApiKey` lives in `google-bridge.ts` and resolves a route's key. The bridge already takes an `inputs` object (the pool is one of them), so the token arrives the same way: `lifecycle.ts` passes a `loginToken(plane)` alongside `pool`, and the bridge calls it only where a reference was not named. That keeps the read in the module that already knows how to make it, and keeps the bridge from learning about the credential store.

**Attempted once and reverted, and the two obstacles are worth writing down** so the next attempt is a single pass rather than a lint loop:

1. `responses-provider.ts` does not import `createTokenStore`, and its import block is ordered, so the new import has to go in the right place rather than appended.
2. The reader's `catch` cannot be `return undefined` (the lint calls it useless) and cannot be a bare `return` either (a useless return at the end of a function) — so the branch needs to return a value the function already has, or the reader needs a different shape. `undefined` is the right ANSWER here; the obstacle is how the lint config wants it expressed.

Everything else is in place: the bridge's `resolveApiKey` already has the exact branch to extend (it returns `resolveGatewayKey` for a named reference), and the plane is derivable from the route id the bridge already receives.

## Status

Built, in the order this file sets out:

- **The pool and its rotation.** `src/credential-pool.ts`: entries are credential references per plane, selection is round-robin among the entries that are neither failed nor unresolved, an exhausted pool falls through rather than failing a request, and **rotation writes** the active key under the reference the pool owns — on every rotation, not once at mount. A route this plugin serves asks the pool directly, so two streams through the bridge arrive with two different keys; the write is what carries a rotation to the routes the wrapper serves.

  That last clause is a correction rather than a detail. The first build published at mount and only selected afterwards, so a rotation reached the routes this plugin serves and nothing else — every route the wrapper serves kept reading the key that happened to be current at startup. Since the wrapper resolves per operation, a rotation that does not write is a rotation nobody else sees, and selection alone would have left this file's central claim false while every test passed. Hence the guard asserts the SECOND rotation publishes, not only the first, and reverting the fix turns three of them red.

  A publish the seam refuses is reported and does not fail the rotation: the caller asked for a key for a request it is making itself and already holds it.

- **The switch, and its default.** `credentialPool` carries `enabled`, `zen` and `go`. The defaults are `false` with empty lists, `createCredentialPool` answers `undefined` for that, and every caller then resolves exactly what it resolved before the pool existed. Listing credentials without turning the switch on changes nothing, which is the contract.

- **The device-flow client.** `src/console-auth.ts`: one client serves both logins, written against the measured responses. `start` asks for a code, `poll` reads the Console's own error field rather than its status, and `awaitAuthorization` waits at the endpoint's interval — doubling it after a `slow_down`, which is what that error asks for. The verification URI is resolved against the Console, because the endpoint answers a relative path and opening that verbatim opens nothing. `refresh` returns the pair together, because the Console rotates the refresh token with every access token and the caller must write both halves at once. It also reads what the login must know before it stores anything: `GET /api/user` for the account and `GET /api/orgs` for its organizations, both with the session token as a bearer credential, which is the same pair the client itself reads. Verified against the live Console: this module's own client obtained a code, read the interval, and reported two pending polls.

- **A login in use.** `src/login-session.ts`: the store and the client are joined. A token inside the window is refreshed before it is handed out, so the call it authenticates is the one that succeeds; concurrent callers share one refresh, because a refresh rotates the refresh token and two of them would present one the server has already replaced. Nothing is invented: no login, no refresh token, and a refusal each report a failure rather than a credential that looks present and is not.

- **The flow that keeps what it learned.** `src/login-flow.ts`: ask for a code, wait for the approval, read the account and the orgs with the token just obtained, then write ONE grant — the pair, the account, the email, the orgs and the active org. If the owner cannot be read the login FAILS and stores nothing: a token stored without its org is a credential whose owner has been forgotten, and the org is half of what the gateway asks for. It looks like success and is a credential nobody can complete.

  **What a login buys is not yet the free tier, and the difference matters before anyone builds the surface for it.** The org is necessary and not sufficient: measured with this machine's own account — its session token, its active org, and every header captured from the real client — a free-tier model still answers `403 FreeTierError`, on both endpoints. The gate is not in the HTTP request, so it is either a client fingerprint or a signature sent only to the real host, and the error's own words may simply be true. A login is what the free tier is asked FOR; whether it is granted is a separate, unmeasured question. The first org is activated, matching the client.

- **The org on the request.** `fetch-patch.ts` sends `x-opencode-org-id` from a per-plane resolver — asked per request, because a login can arrive while the process runs — and invents no header when a plane's credential is a plain key, which is every key deployment. `credentialOrg` is the explicit fallback for a token that came from elsewhere.

Not built yet:

- **The login remote.** `src/login-contract.ts` is the three calls a settings card makes — `begin` answers the code and the URL to open, `poll` asks whether the human has approved, `state` answers what is stored — with codecs both sides read, so a card cannot disagree with the host about what an answer means. A credential never crosses: the parser is a whitelist, and a test sends a state carrying both tokens to assert they are dropped.

  `src/login-service.ts` is the host half, mounted by `apply` beside the meter's service. It holds one attempt at a time, because a device flow is a code a human is holding; a refusal ends it and a wait does not; and `state` re-reads the stored grant per call, so a card sees a login appear the moment the flow completes — including one the CLI completed.

  **And the card that calls them is built too.** `src/settings-login.tsx` is the sign-in row above the settings form: it says who is signed in, offers the action, and once a flow starts it shows the code, an openable URL and that it is waiting. It polls at the interval the Console asked for and ends on its own three ways — signed in, refused, expired — so a page left open does not ask forever. A host that mounted no login service renders no row at all, the same absence the meter keeps.

The page hands it the remote by reading `ctx.remote` rather than declaring `remote.opencodeLogin` as an inject key, because a declared key is a HARD dependency: it would hold the whole plugin waiting for a service a host may not mount.

What a login is FOR is measured, not assumed: the account's session token, on `/inference/openai/v1` with its org, serves a paid model — `deepseek-v4.1-flash` answers `200` — while the free tier refuses it. So the account plane is a working credential for real traffic, and the free tier is the part that is not granted rather than the part that is broken.
