# @lunora/search-core

The full-text search core every Lunora storage backend shares.

**Internal, not published.** It is bundled into its consumers, the way `@lunora/dispatch` is. The search API you write against is `.searchIndex()` in your schema and `.withSearchIndex()` on a query.

Part of the [Lunora](https://github.com/anolilab/lunora) framework.

## Why it exists

Search is implemented twice in Lunora — synchronously over JSON blobs inside a Durable Object, asynchronously over columns on a `.global()` backend — and the two must return the same documents in the same order. Everything that decides **which** documents and **what order** lives here, so neither engine can drift from the other by reimplementing it.

It sits outside both engines because both need it and neither may depend on the other: the schema builder has to stay usable without the Durable Object runtime, and the `.global()` store must not import a Durable Object. Reaching across from `@lunora/do` instead — the shape this replaced — turned two dozen internal contracts into permanent public API of that package purely so the second engine could reuse them.

## Why a package rather than a folder under `shared/`

`shared/` is for tiny, genuinely dependency-free leaf helpers that must not create a dependency edge. This is ~800 lines across five modules with an internal dependency order, its own test suite, and one import of `@lunora/errors` (the query surface's refusals have to carry a code the runtime renders as a 400; a bare `TypeError` surfaces as a 500).

As a package it gets ESLint, its own tests and its own coverage gate. As `private`, being a package costs nothing on npm.

## What is in it

| Module      | Owns                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `languages` | The declared analysis languages and storage strategies — the single source the schema builder and the engines both validate against. |
| `analyzer`  | What a token _is_: Unicode folding, per-language stopwords, and the versioned profile that makes a change to either detectable.      |
| `text`      | The indexing side — what a companion stores, and the caps on it.                                                                     |
| `query`     | The read side — the query surface's guards, the scorer, the ranking, and the paging algebra.                                         |
| `backfill`  | How far an index has got, and what the next pass should do about it.                                                                 |

## Before changing anything here

**Analysis is stored.** The same analysis must run over a document when it is indexed and over the query when it is searched, forever, or the two stop meeting. That is why `createSearchAnalyzer` carries a `profile` string: it is recorded alongside each companion's backfill progress, so changing a language — or bumping `ANALYZER_VERSION` — is _detected_ and rebuilds the index instead of leaving half of it analyzed the old way.

The recorded profile is `<analyzer>:<field>`, not the analyzer alone — re-pointing an index at another column leaves every stored row holding the text of the column you abandoned, and a profile that only tracked analysis reported such an index complete while searches over the new column returned nothing. Any change to the recorded profile string rebuilds every deployed index once, in place, on the first migration after the change: nothing is ever emptied, the re-walk restarts at the top of the table and rewrites each row where it stands, so it costs one backfill walk per index, not a refill from nothing.

What that rebuild costs a reader depends on which half of the profile moved:

- **The analyzer moved** (a language change, or an `ANALYZER_VERSION` bump). Coverage is latched through the rebuild and **reads keep being served** — under the previous analysis rules, row by row, until each row's turn comes. The stored rows still answer about the column that was asked for.
- **The field moved.** Coverage is dropped (`searchCoverageSurvives` compares the recorded field, not the analyzer), so **reads refuse with `SEARCH_INDEX_BUILDING` until the re-walk completes** — the stored rows hold another column's text, and serving them would answer confidently with matches from the column the index was pointed away from. The window is bounded by one walk, and `backfillSearch` closes it without waiting for write traffic to drive the re-walk. One call finishes the walk by default — but it takes a `maxPages` budget and returns `{ done: false, pages }` when that budget runs out, because a table large enough to outrun the isolate's CPU budget has to be paged across several calls. Treat "one call" as true for a modest index and as a loop over `done` for a large one.

If you change folding, stopwords, the token-length cap, or (one day) stemming, bump `ANALYZER_VERSION`. Not doing so leaves every existing index half-matching, silently, for the rest of its life.

## License

FSL-1.1-Apache-2.0
