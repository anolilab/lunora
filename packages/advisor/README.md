# @cirrus/advisor

Schema & query lints (splinter-style advisors) for Cirrus. Each lint is a pure
rule over a normalized `LintContext`; `runAdvisor()` runs a set and flattens
their findings for surfacing (CLI, vite, the studio Advisors table).

The rules run against Cirrus's **declared** schema and **discovered query
reads** — so a problem is caught at codegen time, before it ships. This is the
edge a static advisor has over a live-DB-only one like Supabase's `splinter`,
whose taxonomy these lints are modeled on (the rules are reimplemented for
SQLite/Durable Objects, not vendored).

## Static lints

| Name                                | Category    | Flags                                                                                                        |
| ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `unindexed_foreign_key`             | performance | A `one`-relation FK column with no covering index (leftmost-prefix rule).                                    |
| `duplicate_index`                   | performance | A secondary index made redundant by another whose columns it is a leading prefix of. Skips `unique` indexes. |
| `empty_index`                       | schema      | A secondary index declared with no columns.                                                                  |
| `index_references_unknown_field`    | schema      | An index (any kind) on a column the table doesn't declare.                                                   |
| `relation_references_unknown_table` | schema      | A relation whose target table doesn't exist.                                                                 |
| `relation_references_unknown_field` | schema      | A relation FK/`references` column that doesn't exist.                                                        |
| `filter_without_index`              | performance | A `ctx.db.query(...).filter(...)` with no `.withIndex()`/`.withSearchIndex()` — a full table scan.           |

The correctness (`*_unknown_*`, `empty_index`) lints earn their place because
the index/relation column and table arguments are typed `string`, **not**
`keyof Shape` — so the TypeScript compiler does not catch those typos; the
advisor does.

## Feeders

Lints consume a feeder-agnostic `AdvisorSchema` (plus `AdvisorQueryRead[]` for
`filter_without_index`). Two feeders produce it:

- `fromServerSchema(schema)` — adapts the runtime `@cirrus/server` schema (used
  by the studio backend / a live shard, and by tests).
- `@cirrus/codegen` — builds the same shape from its AST IR and supplies the
  query reads it discovers from function bodies; it runs the static lints during
  codegen and returns them on `CodegenResult.advisories`.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.
