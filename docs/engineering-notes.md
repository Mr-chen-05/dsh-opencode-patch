# Engineering notes

Design decisions and protocol findings behind this plugin, written for someone integrating with OpenCode or writing another DSH plugin. The user-facing description is the [README](../README.md); the protocol internals are [deep-dive](./deep-dive.md) and [protocol routing and merge](./protocol-routing-and-merge.md).

## The session id is the vendor's, character for character

`ses_<12 hex><14 base62>`, read off the vendor's own generator rather than inferred:

```ts
let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter);
return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12);
```

Two things follow, and both matter:

- The twelve hex characters are a timestamp, `milliseconds * 0x1000 + counter`, and the vendor parses them back (`timestamp(id)` divides by `0x1000`). Filling them with hash bytes would hand the vendor a random creation instant, and a non-hex alphabet makes that parser throw. So the timestamp comes from the session's own creation time — real, stable, and identical on every turn, in every process and after a restart, without a clock and without state.
- The vendor's buffer is six bytes, so the value is truncated to 48 bits and the embedded time wraps roughly every 795 days (a bug they have filed: [anomalyco/opencode#42589](https://github.com/anomalyco/opencode/issues/42589)). We mirror it exactly, wrap included: a value that recovers a different millisecond than was put in is what a _real_ id does too, and being indistinguishable is the point.

Ascending vs descending is not cosmetic. `descending` is the bitwise NOT of the timestamp value, so the same instant sorts to the opposite end of a lexicographic list — and the vendor's own reader documents that it "does not work with descending IDs". A wrongly-directed id does not merely sort oddly; its embedded time reads as garbage. Direction is a per-type choice (`msg_` and `prt_` may differ from `ses_`); we mint only session ids, so we emit ascending.

A parity test runs the vendor's reader against ids we mint, including a case that fails if the alphabet is ever changed back to something that only _looks_ like an id.

## Endpoints and auth conventions

Covered in full in [deep-dive.md](./deep-dive.md): the two endpoint levels the catalog defines (a provider default plus a per-model `api.url` override) and the rule that authentication follows the **wire shape** rather than the endpoint — Bearer on the OpenAI planes, `x-api-key` on the Anthropic one. Not restated here, because a second copy of a fact is a second thing that can go stale.

## A credential prefix is not an entitlement

A guard that refused to query the Go quota endpoint with a key starting `oc_sk_`, on the belief that the prefix meant "Zen, no Go entitlement", was wrong within one vendor release: the same prefix works on both planes, and the endpoint answers `200` with real windows. What separates the tiers is the **observed request**, never a string prefix. The endpoint's own answer is evidence; a guess about a vendor's key format is not.

## What the meter shows, and why

- The default window is the 5-hour one, not the largest number. A window is shown only when it is actually out (rate-limited or at its cap), widest first; otherwise the smallest window that can still refuse you is the one worth printing. The hover lists all three, because the trigger can only print one.
- Zen draws no ring, because a ring is a gauge and Zen has no window to run out of. Its number is the session spend.
- The spend is split by the plane that served each turn, not by the model's home: the question is which balance paid.
- No estimates. When a number cannot be honest, because the within-allowance vs overage split is not published, the panel states the mechanism instead of inventing a figure. An estimate wearing a precise outfit reads as a measurement, and readers make decisions on it.
- One frame, one list. The panel is the floating surface; rows inside it are plain text. A row that draws its own background is a box inside a box, and a field that repeats a number already on screen is not a second fact.
- A row that disappears reads as a deleted feature. Absent data gets an explicit empty state, not omission.

## The meter's open case, and everything already excluded

One deployment reports an empty meter — the card renders "quota unavailable" — and the host it runs in is the only place the cause can be, because every link that can be checked from outside has been. Recorded here so the next reader starts at the end of this list rather than at the beginning of it.

| Excluded | How |
| :-- | :-- |
| the read itself | the service, mounted with a real-shaped loader row and a real key, answered with real window figures |
| the credential service | a cordis context does see a service provided on it: a probe resolved `Bearer go-key-from-scope` through it |
| the install guard | `usageEnabled` is true and `plugin` is a core registry mixin, so the guard passes |
| the client's inject list | `remote` is declared |
| the contract | the descriptors, the parameter codec and the service's method list all match, and a client query carrying provider, model and sessionId parses cleanly |
| the profile | `config: { usageEnabled: true }` is at the level the schema reads |
| the endpoint | it answers with both keys, measured |
| the host's mount | `ctx.plugin(GoUsageService, …)` succeeds on a real cordis context and `ctx.get('opencodeGoUsage')` resolves — the service registers under the name the client looks for, so the host's half is sound |

What is left is the handshake's client side — the settings context holding a `remote`, `$mount` accepting the contribution, and the face then appearing — and the console is where it will say so, because every branch of that stretch now reports: `readGoUsage` names which of its paths returned nothing, the mount names an absent remote or a throw, and the scoped wait names the service it is still waiting for after ten seconds.

**The host's own diagnostics do not reach a log file.** `ctx.logger.info` from the installers appears in no file under the DSH home, measured — so the client's console is not one channel among several, it is the only one a reader has.

## Next: let a stale deployment say so

The most expensive confusion in this plugin's history was not a bug. A running host was seven and a half hours and eleven commits behind its own build, and every symptom in that window was read as a code fault — because the host bundle is read once at process start, the package is installed through a `link:`, and a browser reload refreshes the client bundle while the host keeps the file it started with. The client's fixes appeared to do nothing and the host's diagnostics appeared never to run, which is exactly what both of those look like when the code is not there.

Documented in three places now, which helps a reader who thinks to look. The next step is to make it say so instead: have the host report an identity for the build it loaded, and have the settings card compare it with the build the client is running. A mismatch is then a line in the console naming both, and a host too old to answer at all is the same signal with the other half missing — which is the state that cost the most time here.

## A missing session reads as a bad credential, measured

The Go plane answers a request with **no** session header `400 MissingSessionID`, and every layer above reports that as an invalid API key. Measured against the live gateway with this deployment's own key:

| Sent | Answer |
| :-- | :-- |
| `Bearer <go key>` with `x-opencode-session: ses_<12hex><14base62>` | `200` |
| the same key with `x-opencode-session: ses_dsh_default` | `200` — the gateway accepts that shape on this path |
| the same key with **no** session header at all | `400 MissingSessionID` |

So the header is the difference, the key is not, and a client that omits it looks exactly like a client with a bad credential. On `/zen/v1` the same malformed value earns a real `401 Invalid API key`, which is why the plugin replaces one wherever it finds it — but "replace it" only helps the requests the interceptor claims.

**The two claims are independent, and that is deliberate.** A URL containing a configured gateway substring is claimed with or without an active turn, which is what keeps session affinity for background calls; a turn routed to a configured provider is claimed too. A request that matches neither goes out untouched, and if it is a Go request it earns the `400` above. When a deployment reports "invalid API key" on a route whose key answers `200` from a shell, this is the first thing to check, and `debug`/`debugFile` records what the interceptor saw and sent — presence only, never the credential — so the answer is a line in that file rather than a guess.

## A model on the wrong protocol route, measured end to end

The report was `400 ModelProtocolUnsupported` from a session, and it is reproducible from a shell against the same gateway with the same key:

| Model                 | Endpoint                      | Answer |
| :-------------------- | :---------------------------- | :----- |
| `deepseek-v4.1-flash` | `/zen/go/v1/chat/completions` | `200`  |
| `gemini-3.8-flash`    | `/zen/go/v1/chat/completions` | `400`  |
| `claude-sonnet-4-6`   | `/zen/go/v1/chat/completions` | `400`  |

All three were listed on the same route, which declares `api: openai-completions`. The last two do not speak that protocol, so choosing either one cannot work — and the routing this plugin exists to do is what would have moved them to a route that does.

**It cannot, because those routes are not registered.** Measured against a real deployment's config: `opencode-responses` is present, `opencode-anthropic` and `opencode-google` are not. The plugin registers model discovery for `opencode` and `opencode-go` only, so the two routes the extra protocols need are the deployment's to write — which is the thing the core model says a user should never have to do.

So the fix belongs here rather than in anyone's profile: the routes for the other protocols have to come from the plugin, the way the completions route already does. Until they do, a model that names an SDK other than completions is offered on a route that cannot serve it, and the answer is the `400` above.

**And the deeper half: a model the catalog does not carry cannot be routed at all.** Measured: `gemini-3.8-flash` and `claude-sonnet-4-6` are in neither shipped catalog, so `findModelSpecOn` finds no entry, `provider_npm` is `undefined`, and `undefined` is the DEFAULT — the completions shape. That default is right for a model that omits its SDK and wrong for one the catalog has never heard of, and the two are indistinguishable at that point. A model listed by hand on a completions route therefore stays there whatever protocol it actually speaks, and the gateway answers `400` — which is the whole of the reported symptom.

`catalog-data.ts` carries `provider_npm` only for models that override the default, so absence is meaningful for the 85 it ships and meaningless for anything else. A hand-listed model needs its protocol from somewhere: the catalog, a route that declares it, or a rule that reads it off the id.

**And the other half of I1: it is still OFFERED.** `models-discovery.ts` filters a route's listing with `isServableModel`, which asks the catalog for the model's SDK and treats a missing answer as servable — correctly, because absence means the completions default. For a model the catalog has never heard of, absence means the same thing by accident, so a hand-listed model is offered on a route that cannot serve it. The routing fix above moves it when it is chosen; this is the half that would stop it being offered at all, and the two belong together: I1 says a model that cannot work is not offered, and today that clause holds only for models the catalog describes.

The check needs the plane, which it already has, and the family, which the id names — the same two facts the routing fix uses. What it must not do is read "no catalog entry" as "servable" without also asking whether any route on that plane speaks the protocol the id implies.

## Rules that came out of real failures

- Start from the host's built-ins. The UI kit ships the components _and_ one CSS module each, the fastest inventory of the host's design language available. A hand-rolled look-alike is one whose CSS module was never opened, and it is smaller, wrong and unthemed next to the built-in.
- Declare cross-plugin services with `ctx.inject`, and know which failure each access has. Measured against cordis: `ctx.get(name)` reads the scope's store and does NOT consult `inject`, so an undeclared service answers `undefined` silently; only PROPERTY access (`ctx.name`) throws `cannot get property "name" without inject`. An optional service is therefore best captured through `ctx.inject([name], scope => …)` — a real child scope that can see it — rather than read off the root context, where the answer is `undefined` and the reason is invisible.
- A `Tooltip` clones its child. Wrap a DOM node, never a component: the clone's handlers land on something that ignores unknown props, and the tooltip never appears.
- Opt into the theme instead of re-declaring it. A hand-set elevation stroke pins one theme's answer and silently breaks the other's, and it looks correct in whichever theme you test it in.
- A countdown floors, and its word order belongs to the language. A reset line is a sentence: English wants the word first, Chinese wants it last, and one copy key cannot serve both shapes.
- A comment that describes intended behaviour is not evidence of it. Read the code the comment is attached to before trusting it; a doc comment had described the opposite of what the function did for several sessions.
- Verify the artifact, not the command's output. A grep over a directory that does not exist is indistinguishable from a grep that found nothing, and a cached registry read makes a completed operation look pending. Assert that the input was actually read, and include a case whose answer you already know.
- A test for a behaviour must perform that behaviour. Asserting a constant is not the same as exercising a switch, and a fixture that sits exactly on a floored boundary is a race, not a test.

## The settings card and the composer meter read the same service differently

Found while chasing a card that says "读不到配额" beside a composer that shows the figure correctly. Two reads of one service, in one page:

|  | composer meter | settings card |
| :-- | :-- | :-- |
| call site | `settings-page.tsx:419` | `settings-page.tsx:576` |
| scope | `meterScope` — the injected child scope | `ctx` — the page's own |
| arguments | `{ provider, model, sessionId }` | `{ provider }` only |
| helper | inline | `readGoUsage(ctx)` in `settings-usage.tsx` |

Three differences, and reading further narrows it to none of them. The page's `inject` list does declare `remote`, so the card's scope can see the service; `readGoUsage` warns on every failure path and the console showed none of them, though that console predates a restart and is not evidence.

**The mechanism is the read's timing, and it is the race already documented above for the remotes.** `UsageSummary` reads once when the card appears — its own comment says so — while the mount is an asynchronous `$mount` started in an effect. If the card renders before that resolves, the read answers `undefined` and **nothing reads again**: the effect's dependency is `readUsage`, whose identity is a fresh closure each render but whose answer never changes. The meter reads on every turn, so it always has the value.

That also explains why the console can be silent. The read may not fail at all — it may succeed against a remote that is simply not there yet, which is a state `readGoUsage` reports rather than warns about, or it may be the "no remote" warning on a console nobody has open at boot. **Either way the fix is not to teach the card the arguments the meter passes.** It is to make the summary read again once the remote appears, which is the same fix the sign-in row needs and the same shape as the two separate mounts.

**The shape is the finding**: one service, two reads, one of them passing a third of the arguments. That is the same shape as the meter and the sign-in row having separate mounts, and the fix is the same kind — make the two reads one read, rather than teaching the second one the arguments the first already had. Worth doing with the console in front of you, because which of the three differences matters is a measurement, not a reading.

## The sign-in row has the same race, one step worse

The card's usage read is lazy — `readUsage: () => readGoUsage(ctx)` — so it resolves the remote when it is called, and it now reads until answered. The sign-in row is not:

```ts
login: loginCalls(ctx),   // called at inject time
readUsage: () => readGoUsage(ctx),   // called when the card asks
```

`loginCalls` asks for `ctx.remote.opencodeLogin` **while the injector builds the props**, and the mount is an asynchronous `$mount` started in an effect. If it runs first, `loginCalls` answers `undefined`, the card's `props.login !== undefined` is false, and the row never renders — no retry, no second chance, and the warning it prints says the service is missing when it is merely late.

**Fixed, and the choice is worth recording because the two are not equivalent.** `loginCalls` now resolves the remote inside each method and answers the three calls unconditionally. Making them lazy is what fixes the race; answering unconditionally is what makes the row render at all, and it carries a cost: a host that mounts no login service shows a row that reports it rather than showing nothing. That is the better failure — "no row" and "no service" stop looking identical — and it is deliberately the opposite of the meter's choice, which hides itself when its service is absent. The card's prop is now never `undefined`, so the condition that used to guard the row is a formality rather than a decision.

The test that matters is the one the previous version failed: a remote mounted _after_ `loginCalls` has run, which is exactly the case the injector creates.

Either way the tool for it now exists: `readUntilAnswered` in `settings-usage.tsx` is the pattern, and the row needs the same treatment the summary just got.

## The diagnostic, and the mechanism its test needed

The stream hook reports a hand-named model it cannot serve, once per provider/model pair. It has a test now, and the reason the first attempt at one failed is worth keeping: **the hook is registered through `ctx.on(event, handler)`, not by replacing `llm.stream`.** The first test looked for the handler on `llm.stream` after `apply`, found nothing, called nothing, and asserted against an empty warning list.

That is the same shape as the rest of this file — a claim about the tree that the tree did not say — applied to a test rather than to a document. Find how a thing is installed before asserting anything about it.

## A network failure read as a data answer — the class, and where it stops

Two instances, both fixed, and two paths checked that get it right. Worth recording as a class because the symptom is identical every time: something that could not be observed is reported as though it had been, and the conclusion drawn from it is the opposite of what the evidence supports.

**Fixed — three, not two.** The third was found by sweeping this file for the shape rather than by CI, which is the argument for recording a class and not just an instance:

- The catalog-freshness job reports `is src/catalog-data.ts still current?` with exit 1 when its fetch times out. It cannot tell "could not reach models.dev" from "models.dev changed", and it says the second when it means the first. It went red three times in one day and only the third was real.
- The e2e protocol-routing case asserted `toBe(400)` directly on a probe whose status 0 means "the gateway did not answer". A busy gateway was therefore read as the gateway serving a model on the wrong protocol, and the failure message blamed the catalog. `accessDisabled` already treated status 0 as the third shape of "cannot tell"; that loop does now too.
- The same file, one case later: the anthropic-messages probe in the Go-plane case had no guard, while its sibling above and the google case below both did. CI had not reached it. Guarded now.

**And the sweep that found the third found six more.** Every `await probe(...)` in that file, checked for an `accessDisabled` guard within the following lines:

| line | result | shape |
| --: | :-- | :-- |
| ~~325, 342, 569~~ | **guarded now** | the same bug — a status 0 would fail the assertion and report a busy gateway as a routing fault. 325 and 342 share one case, whose signature had no `context`; that is why the guard had nowhere to go until it was added |
| 652 | deliberately not guarded | it checks `freeTierClosed` and reports rather than skips, which the comment there says is the intent — the account is what closed it, so silence would hide a real state |
| ~~591, 612~~ | **guarded now** | not the same bug but the same silence: they assert `not.toBe(404)` and `not.toBe(500)`, which a status 0 satisfies, so a gateway that never replied would PASS a case that proves nothing. The quietest version of the mistake, and the reason the sweep was worth finishing |
| 376, 413, 426, 477, 489, 557 | guarded | 426 and 489 were the two fixed above |

**And the class stops at `probe`.** The other two e2e files call `await fetch(...)` directly rather than through a helper, so a timeout throws and the case fails with an error — which is honest, and is not this class. A failure converted into a value is what makes the shape possible; a failure that stays a failure cannot produce a conclusion at all. That is the boundary, and it is now swept rather than assumed.

So the count was **six unguarded probes, five of them now guarded and one deliberately not** — 325, 342 and 569 were the same bug, 591 and 612 were the same silence, and 652 reports a closed account rather than skipping it, which its own comment says is the intent. The lesson is that recording a class is worth it even when the sweep that follows finds more than the class was named for.

**Checked and correct, so the class has a boundary:**

- `refreshCatalog` — a revalidation failure retains the active catalogs and allows a later retry, rather than emptying the list.
- The models.dev enrichment path — a non-JSON upstream response generates the full catalog response instead of dropping models.

Both were checked precisely because they are the paths where an empty answer would have produced the original symptom — a model list with nothing in it.

## The phantom route, and the sweep that says it was the only one

Five places named `opencode-mistral` as a route while `INTERNAL_ROUTES` has never contained it, and omitted `opencode-google` which it does. The worst of them was the Chinese README saying the patch deliberately does not provide Google Generative AI at all — true before the bridge, false since, and left standing in the translation after the English was corrected.

Swept afterwards for the shape rather than assuming it was the only one: every `opencode-*` name in every document, checked against the routes and planes the code declares. The rest are header names (`opencode-client`, `opencode-org-id`, `opencode-parent-session-id`), the package name, a module name and the CLI — **no second phantom**. That is worth recording because a clean sweep is a result: it is what makes "these five were all of them" a finding rather than a hope.

## The free-tier claim, and the one place it was right all along

The false claim — that a session token, or the org, or a header unlocks the free tier — stood in six places and was swept out of all of them. Two of those places were paragraphs written here, during the round where the exclusion was withdrawn; both now record the withdrawal rather than standing as fact, because the session that appeared to run on a free model was running on `global:step-5-preview`, this host's own model, and the exclusion was right.

**One place had it right before any of this work started.** `docs/opencode-1.19-api.md` already said, at the bottom of its own list: _"The free tier is not reachable by adding a header. Measured: the org id and the key together still answer 403. Any plan that assumed a header fix is wrong."_ That sentence is what the exhaustive table later confirmed, and it was there the whole time — which is the uncomfortable half of this record: the answer was written down, and six other places said the opposite, and the six won for several rounds.

A sweep that ends clean is worth as much as one that finds something, and this one ends with the boundary drawn: every remaining mention of the free tier says it is not served from here.
