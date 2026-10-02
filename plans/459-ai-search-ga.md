# Plan 459 — Cloudflare AI Search (GA) as a pass-through `ctx.aiSearch`

**Baseline:** `f79680910` (2026-10-02)
**Status:** IN PROGRESS — workstreams A–D shipped on `feat/ai-search-binding`; the phase-3
live smoke (`lunora dev` + a deployed worker answering a real `search`) needs a Cloudflare
account and is the only open item.

## 0. Headline finding

Cloudflare made [AI Search generally available](https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/)
on 2026-10-01. AI Search was called AutoRAG until now. The GA release brings:

- usage-based billing from **2026-11-01**;
- hybrid (vector + BM25) retrieval as the default for new instances;
- Workers AI embedding and reranking calls folded into the AI Search bill;
- two multimodal embedding models (`@cf/qwen/qwen3-vl-embedding-2b` and
  `google-ai-studio/gemini-embedding-2`);
- image input on search and chat;
- OCR for scanned PDFs, with a 10 MiB limit for plain text, code and OCR-enabled
  PDFs and 4 MiB for everything else;
- an optional source `type`, inferred from a URL or an R2 bucket name.

**Lunora cannot reach any of it today.** The repo has no AI Search binding,
`ctx` field, config key or capability rating anywhere (§1). An action has no
typed escape hatch to an arbitrary binding either, because `ctx.env` only holds
what `defineEnv` validates. The gap does not come from GA: the bindings the docs
now point to shipped before it (`workers-types` ≥ `4.20260304.0`). GA is what
makes it worth closing.

Almost every GA feature is **instance-side**: index method, embedding model,
OCR, file limits and source inference are all set on the instance, not in the
Worker. The Worker-facing API is small and already fully typed in
`@cloudflare/workers-types`. One GA headline does **not** reach Workers at all:
image or file input. The binding's message type is `content: string | null`
(`index.d.ts:4907-4910`), and the docs say "to send image or file content
parts, use the REST API or a public endpoint". The smallest honest design is
therefore **a pass-through `ctx.aiSearch` over the raw namespace binding**, not
a `defineRag` backend and not a wrapper SDK (§4).

## 1. Current state (audit)

**What Cloudflare ships (verified 2026-10-02):**

| Surface                                             | Evidence                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Namespace binding `ai_search_namespaces`            | `{ binding, namespace, remote? }`. A `default` namespace exists on every account, and wrangler creates a missing namespace on deploy ([search/workers-binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/))                                                                                                            |
| Instance binding `ai_search`                        | `{ binding, instance_name, remote? }`. The instance must already exist in `default` at deploy time (same page)                                                                                                                                                                                                                                      |
| `AiSearchNamespace` type                            | `get(name)`, `list`, `create`, `delete`, plus multi-instance `search` / `chatCompletions` with `instance_ids` (1–10). `@cloudflare/workers-types@5.20260929.1` `index.d.ts:5622-5688`                                                                                                                                                               |
| `AiSearchInstance` type                             | `search`, `chatCompletions` (with a streaming overload), `update`, `info`, `stats`, `items` (`upload`, `uploadAndPoll`, `list`, `get`), `jobs` (`index.d.ts:5547-5599`; items `:5440-5481`)                                                                                                                                                         |
| Legacy `env.AI.autorag(name)` / `env.AI.aiSearch()` | `@deprecated`, "use the standalone `ai_search_namespaces` or `ai_search` Workers bindings instead" (`index.d.ts:12203-12215`, `AutoRAG` class `:12779`). It keeps working, but "all new features … are only available through the new AI Search bindings" ([migration](https://developers.cloudflare.com/ai-search/api/migration/workers-binding/)) |
| Binding input is text-only                          | `AiSearchMessage.content: string \| null` (`index.d.ts:4907-4910`). Image and file parts are REST / public-endpoint only (search/workers-binding docs)                                                                                                                                                                                              |
| Local dev                                           | There is no simulator. miniflare's `ai-search` plugin proxies both binding types to the remote service only (`miniflare@5.20260926.1-alpha` `dist/src/index.js:111724-111760`)                                                                                                                                                                      |
| wrangler schema                                     | `wrangler@4.143.1` `config-schema.json` declares both `ai_search` and `ai_search_namespaces`, each with a `remote` field                                                                                                                                                                                                                            |
| Limits & pricing                                    | 1,000 semantic + 1,000 full-text queries/month included, then $0.75 / $0.10 per 1k. Ingestion is 5M tokens/month included, then $0.75 per million. 5 custom metadata fields per instance; filterable strings are indexed only to 64 bytes ([limits-pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/))                  |

**What Lunora has:**

- **`defineRag` is a self-assembled pipeline over Vectorize plus an embedder.**
  It does its own chunking (`RagConfig.chunk`, `packages/ai/src/rag/types.ts:409`),
  picks its own `embeddingModel` (`:428`), and takes a Vectorize `index` name
  (`:466`). The other retrieval legs plug in as stores: `lexicalStore` (`:476`),
  `graphStore` (`:460`), `textStore` (`:559`), `store` (`:556`), along with
  `rerank` (`:523`) and `rlsFilter` (`:542`). The store seam
  (`vector-store.ts`, `RagVectorStore`) takes **pre-embedded** vectors through
  `upsert` / `query`. It's a storage seam, not a retrieval-service seam.
- `packages/ai/src/rag/source.ts:6-9` and `packages/ai/docs/index.mdx:636-639`
  say "the one axis on which Cloudflare's managed AutoRAG pipeline is genuinely
  more convenient". The docs never tell a user how to actually use it from
  Lunora.
- No `aiSearch` / `ai_search` / `autorag` symbol exists under `packages/` or
  `templates/`, except those two prose mentions. Checked with
  `grep -rn -i "autorag\|ai_search\|aiSearch"`.
- **Platform matrix:** `PlatformCapabilities.features` has `ai`
  (`packages/platform/src/capabilities/types.ts:139-149`) and `vectorStore`
  (`:530-531`), and no AI Search key. Ratings: cloudflare `ai`/`vectorStore`
  native (`capabilities/cloudflare.ts:93-100`); celld `ai` emulated and
  `vectorStore` unsupported (`celld.ts:42-45`, `:194-197`); node the same
  (`node.ts:145-152`).
- **Codegen:** `CAPABILITY_ROWS` (`packages/codegen/src/capabilities.ts:87-259`)
  is the one table for `ctx.*` capabilities. `CAPABILITY_TO_FEATURE`
  (`platform-target.ts:203-233`) maps rows onto matrix keys, which makes a key
  gate-bearing.
- **Raw-binding access from an action:** `ActionCtx.env` is
  `Record<string, unknown> | undefined`, populated only by a `defineEnv`
  contract (`packages/server/src/types.ts:2715-2722`). There is no sanctioned
  path to `env.AI_SEARCH`.
- **Config:** none of `infer-bindings.ts`, `reconcile-bindings.ts`,
  `validate-bindings.ts`, `binding-manifest.ts`, `remote-bindings.ts` or
  `wrangler-to-alchemy.ts` (all under `packages/config/src/{,cloudflare/}`)
  knows either section. `binding-manifest.ts` reports an unrecognised section
  under `unknown` (`:33`, `:224`), so a hand-written `ai_search_namespaces`
  survives deploy but shows up as an unknown binding.

## 2. Existing seams (do not reinvent)

- **`CAPABILITY_ROWS` + `serverCtxField`** (`capabilities.ts:87-259`). This is
  the one-row way to add a typed `ctx.*` field with a determinism tier. The
  `pipelines` row (`:216-231`) is the closest model: it's detected by `ctx.*`
  access rather than an import, ActionCtx-only, and lives in a
  `@lunora/bindings/*` subpath.
- **`emitKvFragments`** (`packages/codegen/src/emit/shard-bindings.ts:150-175`)
  builds `config.kv?.(env) ?? env.KV`, with a throwing stub whose message names
  the missing wrangler key. Copy it for `config.aiSearch?.(env) ?? env.AI_SEARCH`.
- **`CAPABILITY_TO_FEATURE`** (`platform-target.ts:203`) makes the new key
  gate-bearing in one line. No `PlatformSignals` entry is needed, because usage
  is a `ctx.*` access, not a declaration.
- **`CAPABILITY_SOURCES` + a `CTX_*_PATTERN`** (`packages/config/src/infer-bindings.ts:63-123`,
  the `CTX_PIPELINES_PATTERN` precedent at `:68`). This is the usage signal for
  binding inference.
- **Self-describing auto-write** (`reconcile-bindings.ts:234-243` for
  single-object sections, and `reconcileAnalytics` `:245-256` for array
  sections with a user-chosen name). `ai_search_namespaces` with
  `namespace: "default"` is self-describing: there's no remote id to mint, and
  wrangler creates a missing namespace itself.
- **`ARRAY_SECTIONS`** (`binding-manifest.ts:195-208`),
  **`REQUIRED_FIELD_BINDING_RULES`** (`validate-bindings.ts:708`),
  **`REMOTE_ELIGIBLE_KEYS`** (`remote-bindings.ts:59-66`) and
  **`UNSUPPORTED_FIELDS`** (`wrangler-to-alchemy.ts:190-209`). Each one takes a
  single table row.
- **`defineRag`'s `RetrieveResult`** (`types.ts:757-765`) is the shape agent
  memory already consumes. The docs recipe (workstream D) shows mapping AI
  Search `chunks` onto it by hand instead of shipping an adapter.

## 3. The behavioural contract to preserve

- An app that never reads `ctx.aiSearch` gets byte-identical `_generated/`
  output and a byte-identical `wrangler.jsonc`. Codegen golden fixtures and
  reconcile tests stay unchanged.
- `defineRag`'s public API, chunk-id scheme and Vectorize behaviour do not
  change. This plan adds nothing to `@lunora/ai/rag` except prose.
- A user-written `ai_search_namespaces` or `ai_search` entry is never rewritten
  or removed by reconcile. The inference only adds `AI_SEARCH` when no
  `ai_search_namespaces` entry exists at all (the `reconcileAnalytics`
  idempotence rule).
- `ctx.aiSearch` exists **only on ActionCtx**. Queries and mutations stay
  deterministic and free of external I/O.
- On a target that rates `aiSearch` `unsupported`, codegen omits the field and
  emits `platform_unsupported_feature`. It never emits a stub that fails at
  runtime.

## 4. Design decisions

1. **Adopt AI Search as a separate `ctx.aiSearch` surface (option b), not as a
   `defineRag` backend (option a), and not as explicit non-support (option c).**

    _Rejected (a), a `defineRag` backend or source._ AI Search owns chunking,
    embedding, the hybrid index, reranking, query rewriting and the cache.
    `defineRag`'s config is almost entirely knobs for exactly those stages:
    `chunk`, `chunkSize`, `chunkOverlap`, `embeddingModel`,
    `embeddingModelVersion`, `cacheEmbeddings`, `candidates`, `lexicalStore`,
    `graphStore`, `textStore`, `rerank` and `transformQuery`. A backend would
    have to reject or ignore about 12 of `RagConfig`'s fields, which amounts to
    a second implementation behind the first one's name. The semantics don't map
    either:
    - **Tenancy.** `namespace` is a Vectorize namespace, while AI Search isolates
      tenants with an instance per tenant or a metadata filter.
    - **Row-level security.** `rlsFilter` assumes arbitrary metadata, but AI
      Search allows 5 custom fields per instance and indexes filterable strings
      only to their first 64 bytes. A tenant id longer than 64 bytes would
      silently stop filtering correctly, which is a cross-tenant-leak shape.
    - **Write semantics.** `index()` is synchronous and short-circuits on a
      content hash, while `items.upload` queues the document and returns.

    The store seam (`RagVectorStore`) takes pre-embedded vectors, so AI Search
    cannot sit behind it either.

    _Rejected (c), explicit non-support._ It's the one first-party managed RAG
    product, it's GA and fully typed, and today a Lunora action can't reach it
    at all. Non-support would leave the AutoRAG admission in `source.ts` as a
    standing "go elsewhere".

2. **Pass the raw `AiSearchNamespace` binding through. Do not wrap it.** The
   workers-types class is complete and versioned by Cloudflare, so a wrapper
   adds a second type to keep in sync and gains nothing.
   _Rejected:_ a `createAiSearch()` facade that normalises results into
   `RetrieveResult`. Build it only when a second consumer (an agent tool, for
   example) needs the normalised shape. See open question 3.

3. **Bind the namespace (`ai_search_namespaces`), not single instances
   (`ai_search`).** One conventional binding, `AI_SEARCH` on namespace
   `default`, reaches every existing instance with `.get(name)`. Existing
   instances live in `default` (migration docs). The same binding is also the
   only one that offers per-tenant `create` / `delete` and multi-instance
   `search`. It follows the one-conventional-binding pattern of `ctx.kv` /
   `ctx.ai`, so it needs no new declaration mechanism.
   _Rejected:_ a typed map of `ai_search` instance bindings
   (`ctx.aiSearch.docs.search(...)`). Codegen would have to read binding names
   out of `wrangler.jsonc` or a new `lunora.config` key, and the instance
   binding fails the deploy when the instance doesn't exist yet.
   _Rejected:_ the legacy `env.AI.autorag()`. It's deprecated and misses the GA
   features.

4. **The binding name can be overridden through
   `defineApp().aiSearch((env) => env.X)`.** This is the `appMethod` facet, the
   same as `kv` / `images`. A user with a non-default namespace keeps their own
   wrangler entry and points the thunk at it.
   _Rejected:_ a `namespace` option in Lunora config. Wrangler already owns that
   field.

5. **ActionCtx only (`tier: "action"`).** AI Search is network I/O, billed per
   query and non-deterministic.
   _Rejected:_ `"every"`, as `ctx.kv` uses. A KV read is a deterministic-enough
   point read. A ranked search over a re-indexing corpus is not, and a query
   that ran it would re-bill on every subscription re-run.

6. **The type lives in a new `@lunora/bindings/ai-search` subpath that exports
   only types**: `AiSearch` = `AiSearchNamespace`. The subpath gives the
   capability row a `moduleSpecifier` and gives the emitted field an import
   that doesn't depend on the app's ambient `types`. It carries no runtime
   code: the binding is used as-is.
   _Rejected:_ referencing the ambient global `AiSearchNamespace` directly in
   the emitted `server.ts`. That breaks for an app whose tsconfig doesn't load
   `@cloudflare/workers-types`. See the STOP in §8 if packem's `.d.ts` emit
   can't re-export an ambient class.

7. **Out of scope until asked for:**
    - multimodal input (the binding can't carry it);
    - instance provisioning from Lunora (`create` is already on the binding;
      dashboard and wrangler cover the rest);
    - Studio pages;
    - per-query usage telemetry. AI Search bills on its own invoice, and
      `ctx.trace` spans over `fetch` don't see binding calls. Revisit with
      plan-style evidence if users ask.

## 5. Workstreams

**A. Matrix key and capability row (S).** Add `aiSearch?: Capability` to
`PlatformCapabilities.features` (`types.ts`), with a doc comment and an entry in
the module header's gate-bearing list. Rate it on all three targets (§6). Then:

- add a `CAPABILITY_ROWS` row (`key: "aiSearch"`, `contextProperty: "aiSearch"`,
  `moduleSpecifier: "@lunora/bindings/ai-search"`,
  `requiredPackage: "@lunora/bindings"`, an `appMethod` with
  `configKey: "aiSearch"`, and a `serverCtxField` with `tier: "action"`);
- add `aiSearch: "aiSearch"` to `CAPABILITY_TO_FEATURE`;
- update the node docs table and run `pnpm run lint:node-capabilities-docs`.

**Done.** `aiSearch` is a gate-bearing `PlatformCapabilities.features` key, rated
`native` (cloudflare) / `unsupported` (celld, node) with the §6 notes; the
`CAPABILITY_ROWS` row and `CAPABILITY_TO_FEATURE` entry landed as specified (row
placed after `ai`, so the `.aiSearch()` builder method sorts there). The node
docs table carries the row and `lint:node-capabilities-docs` is green. That check
was already red on the base branch: the web-search commit changed the matrix's
`ai` note without the docs row, fixed in its own commit.

**B. Codegen emit (M).** Add `emitAiSearchFragments` in `shard-bindings.ts`
modelled on `emitKvFragments`. It resolves
`config.aiSearch?.(env) ?? env.AI_SEARCH`, and the stub message names
`ai_search_namespaces` and `defineApp().aiSearch(...)`. Wire it into the
`shard.ts` config fields and ctx literal, ActionCtx only, and add the
`@lunora/bindings/ai-search` subpath (types only) to `packages/bindings`.
Tests:

- a golden fixture for an app with `ctx.aiSearch`, with the existing goldens
  byte-identical;
- a `gateAgainstMatrix` test that `target: "node"` omits the field and emits
  `platform_unsupported_feature`.

Run `api:check`, `dist:check` and `lint:package-json`.

**Done.** There is no `emitAiSearchFragments`: the branch was rebased onto the
table-driven codegen (#933, `refactor/codegen-capability-table`), so the
`CAPABILITY_ROWS` row carries a `shardBinding` facet
(`binding: { envName: "AI_SEARCH" }`, `clientType: "AiSearch"`, no factory) and
the generic emitter renders `config.aiSearch?.(env) ?? env.AI_SEARCH`, cast to
`AiSearch` — no facade is built, the binding is the helper — else
`aiSearchStub`, attached in the `isAction` block only. `emitServer` types it on
`ActionCtx` only and `emitApp` emits `.aiSearch(...)`, both off the same row;
there are no `has*` options. The stub is annotated
(`const aiSearchStub: AiSearch = {…}`), never cast, so a method missing from it
is a compile error in the generated shard.

`@lunora/bindings/ai-search` exports `AiSearch` and `AiSearchInstance` plus
their request / response shapes, types only, as a **structural mirror** of
workers-types' `AiSearchNamespace` / `AiSearchInstance` classes (5.20260929.1),
like every other bindings subpath. The first cut aliased the class through an
optional `@cloudflare/workers-types` peer (`>=4.20260304.0`, with a packem
`dts.resolve` exclusion); review found the class only ships from 4.20260331.1,
so an older or absent install degraded `ctx.aiSearch` to `any` under
`skipLibCheck`. The peer and the packem exclusion are gone. This overrides the
§8 STOP's "do not hand-copy" on the reviewer's call: drift is caught by a type
test in `@lunora/bindings` asserting the real classes still satisfy the mirror,
which fails `lint:types` there rather than at a consumer.

Tests: a new compiled golden fixture `__tests__/fixtures/ai-search` (one action
reading `ctx.aiSearch`, one query whose `ctx.aiSearch` read carries a
`@ts-expect-error`), pulled into `lint:types` through a type import of its
generated `shard.ts` like `delta-sync`; that needed `@lunora/bindings` as a
codegen devDependency. Its test also runs the fixture with `target: "node"`
and asserts the field, the stub, the import and the builder method are all
gone, with one `platform_unsupported_feature`. A `gatePlatformFeatures` case
covers all three targets. Every pre-existing golden regenerated byte-identical.
`api:check` drift (bindings, codegen, config, platform) is intended and
committed; `dist:check` and `lint:package-json` are green.

Open question 4 (`HttpActionCtx`): answered **no**. `HttpActionCtx` picks only
`auth` / `cache` / `fetch` from `ActionContext` and carries none of the
codegen-wired bindings (`images`, `pipelines` and the rest are absent too), so
adding `aiSearch` alone would mean the worker building binding helpers for HTTP
actions. A route reads `c.env.AI_SEARCH` instead (the runtime spreads `env` into
the hono bindings); the docs recipe shows it.

**C. Config: inference, reconcile, validation, manifest, dev (M).**

- `infer-bindings.ts`: add `CTX_AI_SEARCH_PATTERN = /\bctx\s*\.\s*aiSearch\b/`
  and a `usesAiSearch` entry.
- `reconcile-bindings.ts`: add `reconcileAiSearch`, which writes
  `[{ binding: "AI_SEARCH", namespace: "default" }]` only when there is no
  `ai_search_namespaces` entry.
- `validate-bindings.ts`: add `REQUIRED_FIELD_BINDING_RULES` rows for
  `ai_search_namespaces` (`binding`, `namespace`) and `ai_search` (`binding`,
  `instance_name`).
- `binding-manifest.ts`: add `ARRAY_SECTIONS` rows (types `ai_search` and
  `ai_search_namespace`).
- `remote-bindings.ts`: add both keys to `REMOTE_ELIGIBLE_KEYS`.
- `wrangler-to-alchemy.ts`: add both keys to `UNSUPPORTED_FIELDS`.
- **Dev.** AI Search has no local mode (§1), so decide from open question 1
  whether plain `lunora dev` needs `remote: true` written at reconcile time.

Unit tests go in each module's existing suite.

**Done.** All six edits landed, two of them reshaped by the rebase onto #933:
`usesAiSearch` is a ctx-access `CAPABILITY_SOURCES` row
(`contextProperty: "aiSearch"`, no regex), so it is detected by codegen's own
AST pass — a `const { aiSearch } = ctx` destructure counts, a `// ctx.aiSearch`
comment does not — and the write goes through `reconcileSelfDescribingArray`
(key union widened to `ai_search_namespaces`) instead of a bespoke
`reconcileAiSearch`. Review added one behaviour: that helper skips the write,
with a warning naming the owner, when `AI_SEARCH` is already bound anywhere in
the top-level config (an `ai_search` instance, another binding kind, a queue
producer, a var), since wrangler rejects a name "assigned to multiple
bindings". It covers the `ANALYTICS` write too. Also: `ai_search` /
`ai_search_namespaces` in `wrangler-environment.ts`'s `NON_INHERITABLE_KEYS`
(wrangler 4.143.1 reads both through `notInheritable(...)`) and the matching
`WranglerConfig` / `WranglerShape` / `ManifestConfigShape` fields. Tests:
reconcile absent → `AI_SEARCH` added, idempotent; a hand-written entry under
another name → untouched; the name taken by another section → not written, one
warning; inference from `ctx.aiSearch` and its destructure, but not from a
comment or a type-only import; validate rejects a `{ binding }`-only entry in either
section; the manifest lists both sections and nothing as `unknown`; remote
planning and the Alchemy unsupported list cover both keys.

Open question 1 (dev): answered from wrangler 4.143.1's source rather than a
`lunora dev` run (no Cloudflare account in this environment). Wrangler rates
`ai_search` and `ai_search_namespace` as
`"DO-NOT-USE-this-resource-will-never-have-a-local-simulator"` — the same tier
as `ai` — so `pickRemoteBindings` always routes them through the remote proxy
session in plain `wrangler dev`, with or without `remote: true`. Reconcile
therefore writes `{ binding, namespace }` only, exactly as it writes `ai`.
Without the flag wrangler prints a "may incur usage charges" warning; that
warning is kept on purpose (it is the honest billing signal), and the
`LUNORA_REMOTE` path tags the entry, which silences it.

**D. Docs (S).** Add a "Managed RAG: AI Search" section to
`packages/ai/docs/index.mdx` next to `defineRag`. It covers:

- when to choose which. AI Search suits zero-code ingestion of R2 or a website,
  OCR and multimodal corpora, and fully managed hybrid retrieval. `defineRag`
  suits RLS-filtered multi-tenant retrieval over app data, a custom chunker or
  embedder, graph or lexical legs, and non-Cloudflare targets;
- a `ctx.aiSearch.get("docs").search(...)` action;
- a streaming `chatCompletions` from an `httpAction`;
- mapping `chunks` onto `RetrieveResult` for agent memory;
- per-tenant instances through `create`;
- the 2026-11-01 billing note, the text-only binding caveat, and the
  `metadata`-filter 64-byte caveat.

Rewrite the AutoRAG sentence in `source.ts:6-9` and `index.mdx:636-639` to
point there. Add a `wrangler.jsonc` snippet to the `lunora-deploy` skill
reference if it lists bindings.

**Done.** "Managed RAG: AI Search" in `packages/ai/docs/index.mdx` covers every
bullet. One deviation: the streaming recipe is an `httpRouter` route reading
`c.env.AI_SEARCH`, not an `httpAction` reading `ctx.aiSearch` (see open
question 4 under B). Both AutoRAG sentences now point at the section, and
`packages/bindings/{docs/index.mdx,README.md}` list the subpath. The
`lunora-deploy` skill lists no bindings, so it is unchanged. Not done: the
phase-3 live smoke, and with it the §8 STOP about pre-GA instances, which only a
real account can answer.

## 6. Platform parity

New key `aiSearch` (gate-bearing through `CAPABILITY_TO_FEATURE`). It is
host-backed by **no** Lunora contract: it's a provider binding passed through
as-is, like `ai` and `vectorStore`. That's the accepted shape for a pure
provider product. A second host would have to supply an `AiSearchNamespace`
look-alike, and none does.

| Feature                         | `cloudflare` | `celld`     | `node`      | Notes                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------ | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.aiSearch` (`aiSearch` key) | native       | unsupported | unsupported | cloudflare: the `ai_search_namespaces` binding, remote-only even in dev. celld: AI Search is not among celld's binding types (the same list `celld.ts:44` cites for Workers AI). node: no equivalent binding is implemented. Codegen omits `ctx.aiSearch` and emits `platform_unsupported_feature` on both |

`emulated` over the AI Search REST API (account id + API token over `fetch`)
was considered for celld and node and **not** chosen. Nobody has asked for it,
it would need its own secrets plumbing, and the binding API and the REST API
differ (the REST API accepts image parts and the binding doesn't). See open
question 2.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                                                                                                 |
| ----- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | A    | `pnpm --filter "@lunora/platform..." run test`; `lint:node-capabilities-docs` green; `@lunora/codegen` capability-table tests green                                  |
| 1     | B    | new golden for `ctx.aiSearch` passes; all existing goldens byte-identical; node-target gate test emits `platform_unsupported_feature`; `api:check` + `dist:check`    |
| 2     | C    | reconcile tests: absent → `AI_SEARCH` added; present → untouched; validate rejects a `{ binding }`-only namespace entry; manifest lists both sections, not `unknown` |
| 3     | D    | docs build; then a **live** smoke on a real account: `lunora dev` and a deployed worker each answer `ctx.aiSearch.get(<instance>).search({ query })`                 |

## 8. Risks & STOP conditions

- **STOP** if packem's `.d.ts` emit (isolated declarations) cannot express
  `export type AiSearch = AiSearchNamespace` from the subpath without leaking an
  unresolved ambient name into consumers. Do not hand-copy the workers-types
  class. Re-scope to a structural `Pick` interface of the methods we document,
  and bring that back to the user first.
- **STOP** if the live smoke shows the namespace binding cannot reach instances
  created before GA (pre-namespace AutoRAG instances). Decision 3 assumes the
  migration docs' claim that "existing instances are in the default namespace".
- **Risk:** `lunora dev` without `LUNORA_REMOTE` hits a binding with no remote
  proxy and fails opaquely. Mitigate: open question 1. Either reconcile writes
  `remote: true`, or the stub-like dev error names `LUNORA_REMOTE=1`.
- **Risk:** users mistake `ctx.aiSearch` for a `defineRag` replacement and lose
  RLS. Mitigate: the decision table in workstream D states the 64-byte
  filterable-string limit and the 5-field metadata cap explicitly.
- **Risk:** billing surprise after 2026-11-01 for an app that calls search in a
  hot path. Mitigate: ActionCtx-only (decision 5) plus the docs note. No code
  guard.
- **Perf watch:** none. It's a pass-through binding with no Lunora code on the
  hot path, so no `__bench__` suite applies.

## 9. Open questions (answer during execution)

1. Does wrangler 4.143 auto-remote `ai_search_namespaces` in plain
   `wrangler dev` (as it does for `ai`), or does it need `"remote": true`? If
   it needs it, reconcile writes `remote: true` in the inferred entry. Settle
   this with one `lunora dev` run before workstream C lands.
2. Is an `emulated` REST-backed `ctx.aiSearch` for celld and node wanted?
   Default: no, until a user on those targets asks.
3. Should `@lunora/agent` get an `aiSearchTool(instanceName)` matching
   `rag.asTool()`? Default: docs recipe only. Ship the tool when a second app
   writes the same adapter.
4. Should `HttpActionCtx` (a `Pick` of ActionCtx) include `aiSearch`, so a
   streaming `chatCompletions` can be returned straight from an `httpAction`?
   Likely yes. Confirm against how `pipelines` / `images` are picked.

**Answers (2026-10-02, `feat/ai-search-binding`).** 1: no `remote: true` needed;
wrangler always remotes AI Search in dev (see C). 2: default kept, rated
`unsupported`. 3: default kept, docs recipe only. 4: no; `HttpActionCtx` carries
none of the codegen-wired bindings, so routes read `c.env.AI_SEARCH` (see B).
