# Upstream findings & issue tracking

Three audiences: what the **OpenCode upstream** does that we must track, what the **DSH host** needs to change for us to do it, and what we **verified against upstream source** — because a measurement cited in a comment is a fact that goes stale and nobody re-reads it.

Every claim names the file it was checked against. A claim not checked is marked **unverified** rather than repeated as fact.

---

## 0. Version targets — 1.19 is primary, 2.* tracked for divergence

The payload we send is negotiated with whatever gateway the account is on, and both lines are still served, so we support both. **1.19.x is the target we implement against**; 2.x is tracked because it has already moved several contracts.

|  | 1.19.x (primary) | 2.0.x (tracked) |
| :-- | :-- | :-- |
| Latest at time of writing | 1.19.3 | 2.0.32 |
| Session id generator | `packages/opencode/src/id/id.ts` **and** `packages/schema/src/identifier.ts` | `packages/schema/src/identifier.ts` only (`packages/opencode/` is gone) |
| Header assembly | `packages/core/src/session/runner/llm.ts` | `packages/core/src/session/model-request.ts` |
| Gateway shape | `opencode.ai/zen/v1/…` | `opencode.ai/inference/<proto>/v1/…` |
| Free-tier gate | `allowAnonymous` on the model entry | not present in the snapshot (see §1.5) |

### 0.1 How to refresh the refs

The sibling checkout cannot `git fetch` under the DSH sandbox: git writes `.git/FETCH_HEAD` on every fetch, and the workspace-write sandbox refuses it. A shallow clone works and is the documented path:

```sh
git clone --filter=blob:none --no-checkout --single-branch --branch dev --depth 40 \
  https://github.com/anomalyco/opencode.git
# then, for a specific version's file:
git fetch --depth 1 origin tag v1.19.3
```

Note the remote is `anomalyco/opencode`, **not** `opencode-ai/opencode`.

---

## 1. OpenCode upstream

### 1.1 The session id generator — unchanged across both lines

Read in full from both `packages/schema/src/identifier.ts` (present in 1.19.3 and 2.0.32, byte-identical) and `packages/opencode/src/id/id.ts` (1.19.3 only, same arithmetic):

```ts
let lastTimestamp = 0;
let counter = 0;

export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12));
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("");
}
```

Three facts, each of which contradicts something this plugin once assumed:

1. **`counter` starts at 1 per millisecond** and increments per id. It is a _within-millisecond_ disambiguator.
2. **The low twelve bits are NOT constrained by upstream.** They walk `0x001`, `0x002`, `0x003`, … and are only bounded by the counter's wrap. Nothing reserves a band.
3. **The id is 26 characters: 12 hex timestamp + 14 base62.** The prefix (`ses_`) is added by a caller; `create()` returns the bare 26 characters.

**Implication for the rate-limit claim** — see §3.1.

### 1.2 The header contract — 1.19.3

`packages/core/src/session/runner/llm.ts`, the authoritative assembly:

```ts
const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
const request = LLM.request({
  model,
  http: {
    headers: {
      "x-opencode-session-id": session.id,
      ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
      "x-session-affinity": session.id,
      "X-Session-Id": session.id,
      ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
    },
  },
  providerOptions: { openai: { promptCacheKey } },
  …
```

Five headers, all carrying **`session.id`** — the plain session id, with no derivation, no hash and no band. 1.19.3 does **not** send `x-opencode-session`, `x-opencode-client`, `x-opencode-project` or `User-Agent` from this path.

### 1.3 The header contract — 2.0.32

`packages/core/src/session/model-request.ts`, and it is materially different:

```ts
const affinity = SessionAffinity.get(session)
const base = LLM.request({
  model: model.model,
  http: {
    headers: {
      "x-opencode-session-id": session.id,
      ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
      "x-session-affinity": affinity,
      "X-Session-Id": affinity,
      ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
      "User-Agent": App.useragent(app),
      "x-opencode-project": session.projectID,
      "x-opencode-session": affinity,
      "x-opencode-client": app.name,
    },
  },
  promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
  …
```

Differences that matter to us:

1. **A new `SessionAffinity` value** (`packages/core/src/session/affinity.ts`): `session.parentID ?? session.fork?.sessionID ?? session.id`. So `x-session-affinity`, `X-Session-Id` and `x-opencode-session` carry the **affinity id**, which is the PARENT's id for a subagent, while `x-opencode-session-id` still carries the plain `session.id`. They are different values in general.
2. **Three headers 1.19 does not send**: `User-Agent`, `x-opencode-project`, `x-opencode-client` (value `app.name`).
3. `x-opencode-session` exists in both lines but carries different things.

**Consequence.** Our plugin sends `session.id` in all five of 1.19's headers. That is exactly 1.19's contract and correct for a 1.19 account. For a 2.x account the gateway expects the affinity-derived value in three of them, so a 2.x account sees a session that does not group as the client intended. Whether the 2.x gateway _enforces_ this is **unverified** — it may happily accept `session.id`.

### 1.4 The gateway path table — identical in both lines

`packages/console/app/src/lib/inference-proxy.ts`, present and identical in 1.19.3 and 2.0.32:

| Zen path                                   | Inference path                 |
| :----------------------------------------- | :----------------------------- |
| `POST /zen/v1/chat/completions`            | `/openai/v1/chat/completions`  |
| `POST /zen/v1/responses`                   | `/openai/v1/responses`         |
| `POST /zen/v1/messages`                    | `/anthropic/v1/messages`       |
| `POST /zen/v1/systemone`                   | `/systemone/v1/systemone`      |
| `POST /zen/go/v1/...`                      | `/go/...` (all four)           |
| `GET /zen/v1/models`                       | `/v1/models`                   |
| `GET /zen/go/v1/models`                    | `/go/v1/models`                |
| `GET /zen/go/v1/usage`                     | `/go/v1/usage`                 |
| `POST /zen/v1/models/<id>:generateContent` | `/google/v1beta/models/<id>:…` |

**This is the mapping our plane routes exist to serve, and it is stable across both major versions.** The `zen/v1` shape is still accepted by 2.x — the migration is server-side, so 1.19 clients keep working against 2.x gateways. That is the good news: our 1.19-target implementation does not need to change shape to talk to a 2.x account.

### 1.5 Free-tier access — `allowAnonymous`, and it does NOT gate on a session band

1.19.3, `packages/console/app/src/routes/zen/util/handler.ts`:

```ts
const zenApiKey = rawZenApiKey === "public" ? undefined : rawZenApiKey
…
anonymous: opts.modelList === "full" && entry?.allowAnonymous === true,
…
async function authenticate(modelInfo: ModelInfo, zenApiKey?: string) {
  if (!zenApiKey) {
    if (modelInfo.allowAnonymous) return        // <-- free model, no key: allowed
    throw new AuthError(t("zen.api.error.missingApiKey"))
  }
  …
  if (modelInfo.allowAnonymous) return "free"    // billingSource
}
```

and the schema that declares it, `packages/console/core/src/model.ts`:

```ts
const ModelSchema = z.object({
  name: z.string(),
  cost: ModelCostSchema,
  …
  allowAnonymous: z.boolean().optional(),
  …
})
```

**What this establishes:**

- A free model is admitted with **no key at all**, or with the literal key `public`.
- The gate is a **per-model boolean in the vendor's own model registry**, not a property of the session id, the request headers, or the endpoint family.
- With `anonymous`, the proxy strips `authorization`, `x-api-key` and `x-goog-api-key` and forwards keyless; 1.19.3 has an extra rule 2.x drops — `if (anonymous && !generation?.anonymous) return undefined` — so **1.19.3 requires the gateway's own generation path to declare the model anonymous**, while 2.x forwards any keyless request straight through.
- `billingSource` is `"anonymous"`, `"free"`, `"byok"`, `"subscription"`, `"lite"` or `"balance"`, and `"anonymous"` skips accounting entirely.

**Nothing in either line reads the session id's low bits as an admission rule.** §3.1 records the refutation in full.

`allowAnonymous` is **not present in the 2.x snapshot** (`packages/core/src/models-dev/snapshot.txt` carries no such flag, and the 2.x handler file no longer has the key). How a 2.x account decides free access is **unverified**; the 1.19.3 rule is the one we implement against.

---

## 2. DSH host

### 2.1 A per-turn message id — blocks `x-opencode-request`

Recorded in [`docs/engineering-notes.md`](./engineering-notes.md). OpenCode 1.19.0 sent `x-opencode-request` carrying the user's message id, and 2.x dropped it. The turn state carries no message id — `value` is the session's derived id, a different object — and the hook's options carry none either, because the adapter builds the body after the hook returns.

Needed: the host exposing a per-turn message id. Until then the header is omitted, which is 2.x's own choice.

### 2.2 Session affinity for subagents — needs a parent-session notion

1.19 sends the plain session id everywhere, so our derivation is correct. 2.x sends `parentID ?? fork?.sessionID ?? id` in three headers. To match 2.x we would need the parent session id, which the turn state carries as `parentValue`. Whether the 2.x gateway enforces the affinity grouping is **unverified**.

### 2.3 Restart semantics

Not a bug, but the cost of every item above: `lib/index.mjs` is read once at process start, and this package is installed through a `link:` so nothing notices a newer file. A change is not deployed until `pnpm run build` runs **and** the process restarts.

---

## 3. Claims verified against upstream

### 3.1 "The gateway passes only sessions whose low twelve bits are in `f[c-f]x`" — REFUTED

**The claim** (`src/session.ts`, PR #37, live-probe OmniRoute #16571): the gateway 403s any session id whose low twelve hex bits are outside `[0xFC0, 0xFFE]`, so a uniform 12-bit counter would pass ~1.54% of sessions.

**What upstream actually does.** `counter` resets to 0 when the millisecond changes and becomes 1 on the first id of that millisecond. Verified by porting the vendor's `create()` byte-for-byte and running it — see `scripts/verify-session-band.ts`:

```
upstream OpenCode CLI (packages/opencode/src/id/id.ts)
samples             : 200000
distinct low-12     : 0x1
in band [fc0,ffe]   : 0 (0.0000%)
  => upstream NEVER lands in the claimed band.
```

**Why the claim fails.** A rule admitting only `[0xFC0, 0xFFE]` would reject `0x001` — the value the OpenCode CLI produces for essentially every session. It cannot be an admission gate because it would gate out the vendor's own client. The refutation is confirmed against **both** generators and **both** major versions (1.19.3 and 2.0.32 are identical here).

**What is still true.** Free-tier requests do sometimes answer 403. Some rule applies; it is not this one. And §1.5 now names a rule that _is_ real: `allowAnonymous` on the model entry.

**Cost of the wrong fix.** Clamping collapses our entropy from 4096 possible low-12 values to 63, and it does so in the bits the timestamp occupies — the one part upstream reads back with `timestamp(id)`. It cannot help, and it degrades the id.

**Status.** The clamp and its test are still in the tree. Removing them is a one-line revert plus the test, and it wants its own commit and its own live re-probe rather than a drive-by. Recommended next step: probe with a `0x001`-style id and a legacy key, and record the answer.

### 3.2 "`init.body` is undefined on DSH's dispatch path, so injection was skipped" — VERIFIED

DSH sends inference as `fetch(new Request(url, { body }))`, so `init.body` is `undefined`, and the old `if (init?.body !== undefined)` guard skipped the core-tool injection on exactly that path. Reading the body off `input` via `input.clone().text()` and re-issuing a `Request` is the correct fix, and the tests cover all four sources (string `init`, `Request` input, absent body, non-JSON body). **Correct, adopted, tested.**

### 3.3 "The gateway checks `read`+`bash` on `/chat/completions` as well as `/responses`" — PARTIALLY VERIFIED

The contract test covers both routes. Whether a _paid_ completions body without tools is also refused is **unverified** — the probe described a free-tier body. The injection is harmless when unneeded (tools are additive), so extending it to both routes is a safe default.

### 3.4 "Free-tier ids carry no `-free` marker" — VERIFIED

`big-pickle` is flagged free in the catalog with no `-free` suffix, so a marker test misses it. Reading `findModelSpec(modelId)?.is_free` is the authority. **Correct and adopted.**

---

## 3.5 The registry's `deprecated` flag vs the adapter's installed snapshot — MEASURED DRIFT

Checked 2026-10-17 against `https://models.opencode.ai/api.json` and against pi's installed catalog at `@earendil-works/pi-ai/dist/providers/data/opencode.json`.

|  | count |
| :-- | :-- |
| live `opencode` models | 127 |
| of those `status: "deprecated"` | 43 |
| live active | 84 |
| pi's installed `opencode` ids | 85 |
| pi ids the live catalog has since retired | **5** (`exo-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free`, `step-5-preview-free`, `muse-spark-1.3-contributor-free`) |
| live-active ids pi does not have | **6** (`gpt-5.3-codex-spark`, `glm-5.3-flash-free`, `nemotron-3.5-super-vl-free`, `deepseek-v4.1-flash-free`, `beam-free`, `gemini-4-argon`) |

**Why this matters.** `mergeDiscoveredModels` merges the ADAPTER's rows first and appends catalog rows after. Our parser already drops `status: "deprecated"`, but the adapter's snapshot still lists those ids — so the merge put all 5 back, and the picker led with models the vendor has retired while the 6 current ones sat at the bottom.

**Fixed** by recording retired ids during parse (`isDeprecatedModelOn`) and having the merge drop an adapter row the registry has retired. A model ABSENT from the catalog is still kept: absent is not the same as retired, and the adapter's own row is its answer for a model the catalog does not describe.

Note the pi snapshot is keyed by PROTOCOL bucket (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, `typesafe-system-one`) with `chat:` / `classifier:` prefixes on each id — not a flat model map.

## 3.6 The composer meter's registration guard was per-`apply` — VERIFIED DEFECT

`lib/client.js` registered the meter under a `let registered = false` declared **inside** `apply`. The host may run a plugin's client entry more than once in a page's life, so the second run started from `false`, called `slots.register` with the same id, and threw:

```
list slot "conversation.input.right" already has an entry with id "dsh-opencode-patch-usage"
```

A throw out of the entry is a meter that disappears with no message. The guard is now keyed on the slot REGISTRY (`WeakSet`), so a re-activation against the same registry is a no-op while a genuinely fresh registry still registers, and the registration itself is wrapped so a duplicate can never become an exception.

## 4. How to re-check any of this

1. Find the upstream source that **produces** the value, not a client that consumes it.
2. Simulate the upstream algorithm directly, over the range that matters.
3. Compare the distribution against the claimed constraint. A constraint the upstream violates in its common case is not a constraint.

For the session id, step 2 is already written: `scripts/verify-session-band.ts` prints the low-12 distribution of our own derivation and of a faithful port of the vendor's generator.
