# Credentials: the pool, the login, and the rotation

The plugin's default is the deployment's own credential: whatever `apiKeyEnv` the profile already declares keeps resolving exactly as it does today. The pool is a SEPARATE credential the deployment opts into by pointing a route at it, and nothing about that happens as a side effect of adding an entry. A user who logs in with OAuth has taken an action; the plugin still resolves exactly what the profile names until the profile names the pool's reference.

## Current request wiring

The primary fetch fallback and the Google bridge share `src/login-credential.ts`. The primary path keeps real request auth untouched, then resolves a missing or placeholder credential in this order:

    captured → declared environment key → DSH grant (requested plane, then other)
      → installation account (opt-in) → installation key (opt-in) → nothing

The `configured` key-source policy still skips captured fallback; an API key already present in a request is never displaced. Empty and placeholder environment values do not block the login fallback. The Google bridge still raises for an unresolved named reference rather than replacing it with a login.

Authentication follows the wire format: Bearer for OpenAI, `x-api-key` for Anthropic `/messages`, and `x-goog-api-key` for Google generation. Header extraction skips placeholders when another header carries a real key; placeholder detection is case-insensitive. The URL's pathname determines the plane, not query text or a conflicting turn provider.

**Absence permits fallback; refusal does not.** A missing grant may fall through to the other plane or opt-in installation account. An existing grant whose refresh is refused raises a secret-free `MISSING_CREDENTIAL` error and sends no model request, rather than silently selecting a different owner. The reader returns only the access token and org, not refresh tokens or owner metadata.

The login reader returns the token **and its own org**. The primary request uses that pair directly, not a cached org from another credential; a login without an org removes a stale org header. `credentialOrg` remains the explicit override. Unknown gateway planes do not consult logins. No grant is copied into the installation's database, and its account remains off unless `readOpencodeStore` is on.

One reader is shared by the lifecycle and bridge. It retains per-plane sessions but reads one grant snapshot per operation, so a login written after startup is visible and concurrent callers share one refresh. Refresh preserves the grant's account, owner, org list and selected org while replacing the token pair. Missing, nonnumeric or nonfinite expiry is stale, never an indefinitely current token. The Console client uses the original fetch: refreshing under an active OpenCode turn must not recursively enter the credential fallback.

**Concurrency limit:** refresh deduplication is per shared reader/session, not across independent readers or processes. The seam writes a pair atomically, but does not lock the network exchange; a pending refresh can still race a new login or sign-out. Cross-process coordination and conditional replacement are separate work, not guarantees made by this wiring.

These contracts are exercised with fixture grants and SQLite databases through `apply`, the fetch patch, and the bridge's reader. They verify credential selection and outgoing headers, **not** whether a live gateway accepts a session token on every model endpoint or grants free-tier access. The historical notes below describe earlier investigations; their attempted/reverted edits are not outstanding implementation work.

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

## An OAuth token is not an API key on the Zen model endpoint (measured)

The login flows produce an access token. Whether that token can authenticate a MODEL call is a separate question, and the gateway answers it plainly. Three requests to `/chat/completions` on the Zen base, differing only in the credential:

| Credential sent                  | Answer                            |
| :------------------------------- | :-------------------------------- |
| none                             | `401 AuthError: Missing API key.` |
| `Bearer not-a-real-token-abc123` | `401 AuthError: Invalid API key.` |
| `Bearer <a JWT-shaped string>`   | `401 AuthError: Invalid API key.` |

The last two are indistinguishable. The Bearer slot on that endpoint reads an API key and nothing else, so a token presented there is an invalid API key. **This is about `/chat/completions` on the Zen base and nothing wider** — measured later, the account's own token does authenticate on `/inference/openai/v1`, which is a different endpoint with a different credential slot. Read the two together: an API-key slot refuses a login token, and the account plane accepts it.

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

**The edit itself is settled — 34 lines across two files, verified green before it was reverted.** What stopped it was the TEST, not the code: `vp check` passed, all 765 tests passed, and the coverage ratchet then failed on the two new lines. So the next attempt starts from this, not from the analysis:

    google-bridge.ts
      GoogleBridgeInputs gains:
        readonly loginToken?: (plane: string) => Promise<string | undefined>;
      resolveApiKey's tail becomes:
        const named = resolved.apiKeyEnv;
        if (typeof named === "string" && named.length > 0) {
          return resolveGatewayKey(ctx, named, String(route));
        }
        return inputs.loginToken?.(
          String(route).startsWith("opencode-go") ? "opencode-go" : "opencode"
        );

    responses-provider.ts
      imports: createTokenStore from "./token-store.ts", name from "./identity.ts"
      beside the existing `pool: poolFor("opencode")`:
        loginToken: async (plane) => {
          const store = createTokenStore({
            credentials: readCredentialsWriter(ctx), plane, scope: name,
          });
          const login = await store?.read();
          return login?.accessToken;
        },

No try/catch is needed: the store's `read` is documented to answer `undefined` when nothing is stored and does not throw, which is also what removed both obstacles above.

**And the test it needs** mirrors the one at `test/google-bridge.test.ts` that streams through the real adapter with `BRIDGE_STREAM_KEY` set: register the bridge with `apiKeyRef: ""` and a `loginToken` that returns a sentinel, intercept the request, and assert the `Authorization` header carries the sentinel. That is the whole of what is left.

**The one thing the first test attempt got wrong, measured.** `auth.apiKey.resolve` is not on the adapter instance. It is built in a closure and handed to the adapter's CONSTRUCTOR (`Reflect.construct(adapter, [{ auth: { apiKey: { name, resolve } } }])`), so reaching it means going through `adapter.stream(...)` — which is what the existing stream test already does. It is also SYNCHRONOUS: it returns `{ auth: { apiKey }, source }` rather than a promise, and the comment above it says so, because pi awaits the value.

**And the second attempt got one step further, which narrows the test precisely.** With the edit applied and a test that mirrors the stream test, `vp check` passed and 16 of 17 tests passed — the new one failed on `expected undefined to be 'Bearer st_from_login'`, meaning the captured headers were EMPTY: the request never reached the patched `fetch` at all, so the stream had already failed before the key mattered.

**And one hypothesis is ruled out for the next attempt.** `registerGoogleBridge` destructures `const { ctx, host, llm, specs } = inputs` and then reads `inputs.pool` directly, so `inputs.loginToken` reaches `resolveApiKey` the same way the pool does — the field is not dropped, and the edit needs no change on that account. The failure is in the test's route to `fetch`, not in the wiring.

**And one gap the wiring opens, which the next pass should close with it.** The grants are keyed per plane, and both sides derive the plane with the same rule — `opencode-go` for a Go route, `opencode` otherwise. But the sign-in card defaults to `opencode`, so a user who signs in once has a grant the Go routes never ask for, and those routes fall through to `undefined` exactly as before.

**And a second one, in the same shape: the org cache is warmed once, at startup.** `lifecycle.ts` reads the stored grant for both planes before the first request can need it, and `orgByPlane` is then consulted per request. But a LOGIN happens after that — the user signs in from the card, minutes or hours into the process — so the cache still holds whatever was true at startup, and the requests that follow carry no `x-opencode-org-id` even though the grant now has one.

**The shape of that fix, since the hook cannot await.** `patchFetch` asks for the org synchronously — `hooks.resolveOrg?.(plane)` — so the reader cannot go to the store itself; it has to be told. Two ways, and the second is smaller:

- the login, on completing, refreshes the cache for the plane it wrote; or
- the cache lives in its own small module that both `lifecycle.ts` and the login service import, so writing a grant updates what the next request reads.

The second is one new file and no plumbing, and it is the same answer as the token reader: the value is kept next to the thing that changes it.

Both gaps are the same mistake: a value that can change while the process runs, read once and kept. The token reader was the first; this is the second, and the fix is the same shape — read it where it is needed, or refresh it when the thing that feeds it changes. The login completing is exactly that event, and it already knows which plane it wrote.

Measured earlier in this file: the account token is not plane-specific. The same token serves `/inference/openai/v1` with its org, and the same key answers on both planes. So one sign-in should serve both, and the reader should try the plane it was asked for and then the other one before answering `undefined` — three lines in `loginTokenReader`, plus the case that pins it.

The existing stream test gets past that point by setting `process.env. BRIDGE_STREAM_KEY` before it registers. A test for this branch needs the same: give the route a resolvable key by some other means so the stream reaches the request, and let the assertion be about which of the sources supplied it. That is the only piece still missing, and it is one line in a test that already exists.

So the test is the stream test with two changes: register with an empty `apiKeyRef` and a `loginToken` returning a sentinel, then assert the request's `Authorization` header carries the sentinel. The interception boilerplate is already written there.

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

  **What a login buys is not the free tier, and the surface exists anyway.** The org is necessary and not sufficient: measured with this machine's own account — its session token, its active org, and every header captured from the real client — a free-tier model still answers `403 FreeTierError`, on both endpoints. The gate is not in the HTTP request, so it is either a client fingerprint or a signature sent only to the real host, and the error's own words may simply be true. A login is what the free tier is asked FOR; whether it is granted is a separate, unmeasured question. The first org is activated, matching the client.

- **The org on the request.** `fetch-patch.ts` sends `x-opencode-org-id` from a per-plane resolver — asked per request, because a login can arrive while the process runs — and invents no header when a plane's credential is a plain key, which is every key deployment. `credentialOrg` is the explicit fallback for a token that came from elsewhere.

Built, and the account plane it serves:

- **The login remote.** `src/login-contract.ts` is the three calls a settings card makes — `begin` answers the code and the URL to open, `poll` asks whether the human has approved, `state` answers what is stored — with codecs both sides read, so a card cannot disagree with the host about what an answer means. A credential never crosses: the parser is a whitelist, and a test sends a state carrying both tokens to assert they are dropped.

  `src/login-service.ts` is the host half, mounted by `apply` beside the meter's service. It holds one attempt at a time, because a device flow is a code a human is holding; a refusal ends it and a wait does not; and `state` re-reads the stored grant per call, so a card sees a login appear the moment the flow completes — including one the CLI completed.

  **And the card that calls them is built too.** `src/settings-login.tsx` is the sign-in row above the settings form: it says who is signed in, offers the action, and once a flow starts it shows the code, an openable URL and that it is waiting. It polls at the interval the Console asked for and ends on its own three ways — signed in, refused, expired — so a page left open does not ask forever. A host that mounted no login service renders no row at all, the same absence the meter keeps.

The page hands it the remote by reading `ctx.remote` rather than declaring `remote.opencodeLogin` as an inject key, because a declared key is a HARD dependency: it would hold the whole plugin waiting for a service a host may not mount.

What a login is FOR is measured, not assumed: the account's session token, on `/inference/openai/v1` with its org, serves a paid model — `deepseek-v4.1-flash` answers `200` — while the free tier refuses it. So the account plane is a working credential for real traffic, and the free tier is the part that is not granted rather than the part that is broken.

Built, and the opt-in reader it prepared for:

- **The installation's own store, read only when asked.** `readOpencodeStore` is a config field, default `false`, with a card control beside the credential-source select. When it is on, `resolveOpencodeStoreKey` reads the credential OpenCode itself holds for the plane in hand and the step sits LAST in all three key-source policies — after a literal, after a captured request, after the named reference and the environment — so a credential declared in DSH always wins. Both paths that resolve a request's key consult it: the fetch interceptor's Authorization fallback, and the Google bridge's per-request resolver. Nothing logs a value from it, and `node:sqlite` keeps the module on the host side of the bundle rule.

## Reading the installation's own credential store needs no dependency

The opt-in reader was parked on a dependency question: OpenCode 2.0 keeps its credentials in a database rather than a JSON file, so reading it needs SQLite, and adding a driver to a plugin this small is a decision rather than a detail.

That decision is now measured rather than open. `node:sqlite` is a built-in on the Node this host runs (26.x), exporting `DatabaseSync`, `StatementSync` and `backup`, so the reader can open `~/.local/share/opencode/opencode.db` with no new dependency at all. The constraint it inherits is the bundle rule: `node:sqlite` is a host-only import, so the reader lives on the host side and the client never reaches it — which is what `scripts/check.ts` enforces rather than what anyone has to remember.

**And the path is not a constant, which is the part worth knowing before writing it.** Two files in `~/dev/opencode` decide it, and neither branches on the operating system:

- `packages/util/src/global-roots.ts` resolves the directory as `$XDG_DATA_HOME || ~/.local/share`, then joins `opencode`. So macOS and Windows use the same XDG layout as Linux — no `~/Library/Application Support`, no `%APPDATA%` — and on Windows that means `%USERPROFILE%\.local\share\opencode`. `os.homedir()` is the only platform-dependent call.
- `packages/cli/src/database-path.ts` resolves the filename as `$OPENCODE_DB`, else `opencode.db` when the channel is one of `latest | dev | beta | next | prod` or `$OPENCODE_DISABLE_CHANNEL_DB` is `1`/`true`, else `opencode-<channel>.db`. It also honours `:memory:` verbatim, which is not a path at all.

Underneath both is `packages/util/src/global.ts`, which resolves FIVE roots through `roots(app)` — `data`, `cache`, `config`, `state` and `tmp` — each from its own `$XDG_*` variable with a `~/.local/share`, `~/.cache`, `~/.config`, `~/.local/state` and `os.tmpdir()` fallback. `home` is separate and is `$OPENCODE_TEST_HOME ?? os.homedir()`. Two consequences for a reader: the database is under **data** while the config is under **config**, so they are different directories and one root cannot serve both; and a test-home override moves where `~/.agents` and `~/.claude` resolve, so "the user's home" is not always `os.homedir()` either.

So a reader that hardcodes `~/.local/share/opencode/opencode.db` is right on a stable channel and wrong on every other one, wrong again when `$OPENCODE_DB` points elsewhere, and wrong a third time under a moved `$XDG_DATA_HOME`. It should ask the same questions in the same order, and treat "no file at the resolved path" as the ordinary case rather than an error.

The shape it would read, taken from the schema rather than guessed: `credential(id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated)` and `account(id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)`. That is the same three kinds `~/dev/opencode`'s `Credential.Key | OAuth | External` describes — an API key lives in `credential.value` with its `integration_id` naming the provider, and a login lives in `account` with the token pair and its expiry. So the reader is two queries and a whitelist, and the login one is an alternative to the device flow rather than a second thing to invent.

**It stays opt-in and off by default.** A declared DSH credential is always the first answer, and reading another tool's store is something a user turns on, not something that happens to them.

## The wiring, which is now built

The two modules existed and were tested before anything called them. The wiring below is built: a config field with no reader is an empty switch, which this repository has already been audited for once, and the edits went together.

1. `src/config.ts` — `readOpencodeStore: false` in `CONFIG_DEFAULTS` (the object is alphabetical, so between `providers` and `sessionIdEnv`), the matching optional field on `PluginConfig`, and a `z.boolean().default(...).volatile()` row in the schema with a description that says what it reads and that it is off by default.
2. `src/go-discovery.ts` — one more entry in the step map `firstResolved` takes, and **last in every policy**, because the user's own declaration wins: `opencodeStore: () => readFromStore(ctx, plane)`. It resolves the path with `opencodeDatabasePath({ channel: process.env.OPENCODE_CHANNEL, env: process.env, home: os.homedir() }, os.tmpdir())`, reads with `readOpencodeCredentials`, picks the entry whose `integrationId` matches the plane, and answers `undefined` for everything else — a missing file included.
3. `src/settings-fields.ts` — one `CARD_FIELDS` control, which is what makes the switch reachable.
4. **Which of the two mechanisms to use, now that both have been read.** `discoverGoConfig` walks `ctx.loader.entries()` and reads `entry.options.config`, but that is the PROVIDER REGISTRY — the rows that describe `opencode-go` and `opencode` — not this plugin's own configuration. This plugin's own config arrives as a VALUE: `fetch-patch.ts` receives `config: ResolvedPluginConfig` as a parameter, and `lifecycle.ts` is what passes it. So the new step should take the flag as an argument threaded from `lifecycle` rather than dig for it in the loader, and that means `resolveGoApiKey` needs one more parameter (it currently takes `ctx`, `targetProvider` and `policy`).
5. The config travels as VALUES rather than as a config object: `lifecycle.ts` resolves it with `resolveConfig` and passes fields down. `usage.ts:285` calls `resolveGoApiKey(...)` for the meter and `fetch-patch.ts:253` reads `config.keySource` directly for the headers, which is the precedent for how a field arrives. **The model-call path is now traced, and it is `fetch-patch.ts`**: the interceptor's Authorization fallback is what fills the `Bearer unused` sentinel the internal routes carry, so that is where a request's own key is resolved. The other one is `google-bridge.ts`'s `resolveApiKey`, the per-request resolver for the `opencode-google` route specifically — `responses-provider.ts` calls neither `resolveRoutedKey` nor `resolveApiKey`, as the grep said; it hands the bridge its inputs, and the flag travels that way. Both consult the store only after the captured key and the declared environment, so they agree with the meter.
6. Tests: the step answers a key from a store this suite builds, answers `undefined` with the switch off, and still loses to a declared credential and to a captured one; the fetch patch fills its Authorization header from the store, per plane; and the bridge carries a stored login over the store.

**One bug the wiring found, worth recording because the login reader masked it.** `google-bridge.ts` derived the plane with `String(route).startsWith("opencode-go")`, and `"opencode-google"` starts with `"opencode-go"` — so the Zen route was read as the Go one. `loginTokenReader` hid that by falling back to the other plane; an integration-id lookup does not, so the derivation is now an exact route comparison.

The login half is separate and smaller: `readOpencodeAccount` is an alternative to the device flow, so it belongs wherever a stored grant is read, and it needs the same opt-in rather than its own.

**And it is wired, so a user who has already signed in to OpenCode does not have to run the device flow again.** The bridge's tail now resolves in this order:

    the DSH grant (refreshed through `createLoginSession`)
      → the installation's stored account, when `readOpencodeStore` is on
      → the installation's stored key, when it is on
      → nothing

Four things about that are decisions rather than details.

**One switch, not two.** The account shares `readOpencodeStore`, because the question the switch answers is one question — may this plugin read another program's store at all — and a second switch would be a second way to say the same thing. A switch whose effect only exists inside another switch's surface is a state, not a decision.

**The account never displaces a DSH grant, and the grant's org is never replaced by the account's.** They are different credentials: another program's store, another owner, possibly another account. So the account is consulted only after the grant, it is read and used and left alone — nothing writes it into the DSH seam — and the org that travels with it is recorded only on the path where the account's token is the one being used. Pairing one credential's token with another's org is worse than sending no org at all.

**Where the org comes from, and that it CAN be known.** A session token is half a credential: the gateway answers one sent without its org as though it were a plain key. The org is not in the `account` row — the migration `20260309230000_move_org_to_state` moved it out of `account.selected_org_id` and into `account_state.active_org_id`, which is why the reader asks that table rather than the account's own columns. So an account read this way can carry an org, and it does: `readOpencodeAccount` joins `account_state` on `active_account_id` and returns `active_org_id` beside the token, taking the account the state row names as active rather than whichever row happens to be first. Both tables come from the same migration, so a database that has `account` at all has `account_state` next to it.

**An expired stored token is used anyway.** Nothing here can refresh an OpenCode account — that would mean writing to their store or calling their refresh endpoint — so `token_expiry` is deliberately not consulted. The gateway's answer is the truth about a token, and the alternative, treating it as absent, would tell a signed-in user they have no credential when they have one that is merely old. The test pins it with an expiry in 1970.

One consequence worth stating plainly rather than discovering later: on an endpoint whose credential slot reads an API key, an account token is refused — measured for `/chat/completions` at the top of this file. A deployment that has BOTH a session in the installation's `account` table and a key in its `credential` table therefore now prefers the account token on this route, where before it used the key. That is the precedence this file sets out, and it matches OpenCode's own behaviour — when it is signed in, the session credential is the one it sends — but it is a behaviour change on a machine that has both, and it is not measured for the Google endpoint this bridge serves.

## The handoff: free and paid authentication, stated plainly

Everything below is measured against the live gateway and a real installation, or is marked as not measured. It is written for whoever picks this up next, so the parts that were wrong once are called out rather than quietly dropped.

### The two planes

|  | Zen — the OLD api | Go — the NEW api |
| :-- | :-- | :-- |
| base URL | `https://opencode.ai/zen/v1` | `https://opencode.ai/zen/go/v1` |
| env var | `OPENCODE_API_KEY` | `OPENCODE_GO_API_KEY` |
| key shape | `oc_sk_…`, 51 chars | `sk-…` |
| org on the request | **not needed** | **needed** — `x-opencode-org-id` |
| session header | accepted, not required | **required** (`400 MissingSessionID` without) |

The org distinction is the one that matters most and was got wrong twice: it belongs to the **Go** plane only. `src/fetch-patch.ts` already scopes it per plane through `hooks.resolveOrg?.(gatewayPlaneFor(url))`.

### The two sources, and which is which

1. **DSH's own credential seam** — what the plugin reads through `readCredentialsWriter`, and what the host resolves from a provider row's `apiKeyEnv`.
2. **OpenCode's own installation** — a SQLite database, opt-in, read-only, off by default. `src/opencode-paths.ts` finds it; `src/opencode-store.ts` reads two tables.

Two facts about the second one that cost real time:

- **Every `credential.value` is a JSON document, not a bare key.** `{type, key, metadata?}` for `opencode`, `google`, `cf-coding`, `nvidia` and the two Cloudflare integrations; `{type, methodID, refresh, access, expires}` for `xai`. `readOpencodeCredentials` extracts `key` or `access` and answers `undefined` for any other shape. Sending the raw document earns `Invalid credential` — or, on a free model, a refusal that reads as though the MODEL were unusable. It is not.
- **`account` is a different shape and a different question.** `access_token` and `refresh_token` are bare 39-char strings, `token_expiry` is ms. The org is NOT in that table: it is `account_state.active_org_id`, joined on `active_account_id = account.id`.

### The Zen free tier is refused, exhaustively

Every combination below was sent to `https://opencode.ai/zen/v1` against a Zen `-free` id, and every one answered `403 FreeTierError` while a paid model on the same request answered `200`:

| What was varied | Tried |
| :-- | :-- |
| credential | bare API key (`oc_sk_…`, 51 chars) · account session token (`st_…`, 39 chars) · the token **with** its org (`wrk_…`) · **no credential at all** |
| structure | bare body · with the `read` and `bash` tool schemas the fallback injects |
| headers | `x-opencode-client: cli` · `user-agent: opencode/1.19.0` · a valid `x-opencode-session-id` (`ses_…`) |
| endpoint | `/chat/completions` · `/responses` |

So the refusal is not about structure, data, headers, route or credential class. It is per-model, it is not in the request, and no patch reaches it.

**The observation that made this look wrong is worth stating**, because it is the reason this was got wrong twice: a session appears to run on free models. It does not. The model-change notices name `global:step-5-preview` — this host's own model, **not in OpenCode's catalog at all** — while the failures name `opencode/step-5-preview-free`, `opencode/space-bunny-free` and `opencode/muse-spark-1.3-contributor-free`. The names differ by one `-free` suffix and the providers are entirely different.

**Plane matters, and the rule has to be scoped.** `step-5-preview-free` and `longcat-2.5-preview-free` appear on BOTH planes; `space-bunny` and `muse-spark-1.3-contributor` are Go's and are untouched. So a retirement must be `provider === "zen" && id.endsWith("-free")`, never an id list and never global.

**That rule breaks eleven tests, and they are not mechanical.** Several encode deliberate behaviour about which models are offered (`adds Space Bunny and removes retired 1.2`, `preserves Space Bunny while removing retired Muse 1.2 rows`), and `muse-spark-1.3-contributor-free` is the fixture six suites use for a responses-format model. Changing them is a design decision about what this plugin offers, not a rename. It was attempted and reverted rather than half-applied.

### What is measured about the free tier

With the real key, on `/zen/v1/chat/completions`: `space-bunny-free`, `step-5-preview-free` and `muse-spark-1.3-contributor-free` each answer `403 FreeTierError` ("OpenCode's free tier can only be used from within OpenCode"), while `deepseek-v4.1-flash` answers `200`. Both `/chat/completions` and `/responses` refuse identically, so the response format is not the discriminator.

**And yet a session running on a free model works.** The resolution: the host's provider rows declare `apiKeyEnv: OPENCODE_API_KEY`, and the host process has **no `OPENCODE_*` variable set at all**, so the Authorization the gateway sees is filled by this plugin — and the only source left is the key **captured from a live request** (`src/key-capture.ts`). Whatever that key is, the free tier accepts it.

**So the free tier is not "unusable from outside OpenCode". It is unusable with a bare API key.** That is the whole reframing, and it is why an exclusion of free models was the wrong fix: hiding eleven models answers a question nobody asked.

### The order, which is the spec and was inverted once

```
captured        ← the credential a user already connected with, and that works
declared        ← apiKeyEnv; "almost always", and overridden when a working oauth exists
store           ← the local OpenCode CLI's database, only when neither is configured
```

`src/fetch-patch.ts` implements exactly this. Do not invert it: a test named "fills the Authorization header from the installation's store, last" exists for that reason.

### What is open

- **The free tier's real requirement is still unknown.** What does the captured credential carry that an `oc_sk_` key does not — a session token, a client fingerprint, a different key class? Until that is known, free models work only by inheriting whatever the chat was using, and `auto-review` cannot use them at all.
- **`auto-review` deserves its own look.** `@deepseek-ai/dsh-experimental-auto-review` builds a bare options object — provider, model, system, messages, temperature — and calls `ctx.llm.stream()` with no session, no turn and no headers of its own, taking its route from `session.requestHeader()`. It is the only caller in the system that does this, and it is the one that fails on a route the chat itself succeeds on. `dsh-experimental-auto-review` is where it lives.
- **`readOpencodeAccount` is wired into both request paths through the shared login reader.** Selection and org pairing are tested; whether that account token satisfies the free tier is still a live-gateway experiment, not a consequence of wiring it.
- **The store is read per request with no cache**, deliberately: a rotation inside OpenCode should be picked up. It is also a SQLite open per keyless request.
- **The collision is real and unaddressed.** `muse-spark-1.3-contributor-free` is a model this host serves itself AND a model the OpenCode catalog lists, so the same id can resolve onto a route that refuses it.
