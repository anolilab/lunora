## @lunora/shard-engine [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.57...@lunora/shard-engine@1.0.0-alpha.58) (2026-09-06)

### ⚠ BREAKING CHANGES

* **shard-engine:** `aggregate`/`groupBy` now refuse a `v.any()` / `v.union()` /
`v.from()` column instead of reducing it. Declare an `aggregateIndex` covering
the `(by, field, op)`, or narrow the column's validator.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* refactor(shard-engine): drop readCdcChanges' inert table filter

The `tables` option narrowed the page to a set of tables, and its docblock said
the shape/poke path read one filtered page per flush. Nothing passed it: both
production callers (`cdc-retention.ts`, `shard-do.ts`) pass `{ limit, sinceSeq }`
only, and the shape/poke path goes through `readCdcChangeKeys`, which takes a
single `table` and returns keys without post-images. The only thing exercising
the option was its own unit test.

It could not simply be wired up either. `tableInClause` binds one parameter per
table name against workerd's cap of 100, unchunked — its sibling
`cdcTouchesTables` chunks at 90 for exactly that reason. And chunking is not the
same shape here: `cdcTouchesTables` is an existence probe that may answer from
any chunk, while this is an ordered, LIMIT-ed page — chunks would have to be
merged back into commit order with the cursor re-derived from the merge, or the
page truncates at whichever chunk filled `limit` first.

So the option goes, the docblock says what the reader actually does, and
`tableInClause` now takes a non-empty set so the parameter cap stays one call
site away rather than one argument. Its test asserts the interleaving a
table-dropping reader would break — a single-table log looks right either way.
* **shard-engine:** `readCdcChanges` no longer accepts `options.tables`. Read one
table's changes through `readCdcChangeKeys`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ
* **errors,values,server:** `ERROR_CATALOG` gains six keys, so `LunoraErrorCode` widens, and a `CONFIG_INVALID`
message is now redacted to "Internal error" on the wire.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shared): stop refusing SQLite's read-only `replace()` scalar

`FORBIDDEN_KEYWORD` listed `replace` as a bare word, so a plain
`SELECT REPLACE(name, 'a', 'b') FROM users` was rejected as "not read-only" — naming a rule the
operator had not broken. `replace` is a write only in the `REPLACE INTO` statement form; as a scalar
it is a core string function. The docblock's accepted trade covers a keyword inside a string
literal, not a bare function call.

The discrimination is a one-token negative lookahead — the write form is `REPLACE INTO`, never
`REPLACE (`. Deliberately a lookahead rather than matching `replace\s+into`, so an inline block
comment wedged between the two words (whitespace to SQLite's tokenizer, but not to `\s`) still fails
the scan. Every other word on the list has no read-only meaning, so none of them moves.

`VALUES (1)` stays refused, and that is left as-is: the diagnostic states exactly the rule enforced
("only SELECT / WITH / EXPLAIN"), widening the lead set buys nothing, and `INSERT … VALUES` is
already caught by `insert`. Noted in the docblock so it is not re-litigated.

The AI SQL assistant made a false refusal invisible: it retries once and then discards, and the
caller only ever learns `unsafe-response` — which reads the same whether the model wrote a real
`DELETE` or the gate misread a read-only shape. Each discard now warns to the server console with
the gate's rejection code.

Tests: the scalar form is allowed while `REPLACE INTO` — including from inside a CTE, which is why
the keyword scan exists — is still refused; and the assistant logs the rejection code once per
attempt.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(values): make the emitted JSON Schema agree with the runtime parser

Four claims in the schema contradicted what `parse` actually does, so a client generated from the
OpenAPI/OpenRPC spec rejected bodies the server accepts and could not express what the server
requires:

  - `additionalProperties: false` on every object, while `v.object` STRIPS an unknown key rather
    than refusing it (only `.output()`'s `rejectUnknownKeys` refuses one, which is not what these
    schemas describe). Dropped — absent means allowed, which matches the parser.
  - `required` listed every key whose kind was not `optional`, so `v.any()` and a union with an
    optional member were required although `parse {}` succeeds for both. Requiredness is now decided
    by whether the parser accepts the field ABSENT.
  - bigint was described two incompatible ways — `{ format: "int64", type: "integer" }` for the
    scalar, `{ const: "5", type: "string" }` for `v.literal(5n)` — and codegen spelled the literal a
    third way (`{ const: "5n" }`, the IR's source text falling through the numeric branch). One
    lossless carrier for all three: an int64 decimal string. `type: "integer"` advertised the one
    JSON form the parser refuses, and truncated past 2^53 besides; a bigint already rides as its
    decimal string in the wire codec, and this is the treatment `bytes` already gets.
  - `v.record(v.string().pattern(…), …)` emitted no `propertyNames` — the reader read only the value
    child — while the runtime rejects a non-matching key. The reader gains `keyChild`.

Regenerated: both codegen golden fixtures and all 13 examples' committed `_generated` trees.

Also pins the ORDER-DEPENDENT `.check()`/`.nullable()` semantics that round 28 questioned. It holds
as written: `.nullable().check(p)` refines the widened type, so `p` runs on null — and its parameter
is typed `string | null`, so dereferencing it is a compile error, not a runtime surprise.
`.check(p).nullable()` is the other reading and short-circuits. No behaviour change, a test so the
pair is not "fixed" into agreement later.
* **errors,values,server:** `SchemaNodeReader` gains a required `keyChild` member, and generated OpenAPI /
OpenRPC documents change shape (no `additionalProperties: false` on argument objects, a narrower
`required`, `propertyNames` on records, bigint as an int64 string).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* docs: correct two APIs the snippets taught with a shape they never had

`useMutation` returns `{ data, error, isError, mutate, pending, reset, withOptimisticUpdate }`, but
13 snippets — the flagship realtime-chat tutorial, error handling, the React and reactive-loaders
pages, both migration guides, three blog posts — wrote `const send = useMutation(...)` and then
called `send(...)`. A reader following them gets `TS2349: This expression is not callable`, or
`TypeError: send is not a function`. The React page was half-right, reading `send.pending`, which
does exist on the object. Two prose sentences said "returns a callable with a `.pending` flag".

`ctx.db.findMany("users")` exists on the untyped runtime writer but not on the generated typed
`ctx.db`, so the masking and RLS snippets may run yet never typecheck in a user project. Replaced
with the per-table facade (`ctx.db.users.findMany()`).

`check-doc-imports.mjs` only validated import NAMES, so both classes were invisible to it. It gains
a small deny-table of shapes found wrong in shipped docs, each entry carrying the correct form in
its message, and now walks `content/blog` as well — two of the wrong snippets lived there. Not a
type checker: doing this properly needs the packages installed in apps/docs plus synthesized
`_generated` modules, which is noted in the file.

Only tracked files are touched. `apps/docs/src/content/docs/packages` is gitignored — a local copy
regenerated at build — so nothing there ships.

The round also reported `ctx.db.from("invoices").all()` in the cloudflare-access page. That call
appears nowhere in the repo, tracked or otherwise, so nothing was changed for it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(playground): make the inbound-email sink internal, and stop claiming a DO reset

The worker entry gates `email()` on `verify: authenticatesFrom` and says so at length: Cloudflare
Email Routing authenticates the RECIPIENT domain, never the sender, so without the gate anyone who
can send mail to the routed address reaches the sink with a `from` of their choosing. But the sink
was a plain `mutation`, registered publicly, so the same call was on the client `api` — the gate was
walked around rather than through.

`internalMutation` is the sibling pattern (`cleanup.ts`), and it costs the mail path nothing:
`@lunora/mail`'s shard dispatcher already sends `x-lunora-system: 1`, which is exactly what admits a
server-initiated dispatch to an internal target — the package's own docblock says an inbound target
"should be" internal for this reason. Verified rather than assumed: nothing in the app or the e2e
suite calls it from a client.

`inbound:list` stays public and now says why: it demonstrates that the write lands on the change
feed, and the `inbox` table has no owner column to scope a read by. Called out as the demo's choice,
not the pattern to copy.

Separately, `/test/reset` POSTed `https://do/internal/reset` at a DO named `__e2e_reset__` inside a
swallowing `catch`. `ShardDO.fetch` answers 404 to anything that is not `/rpc` or its WS/relay
routes, and that name is neither `__root__` nor any channel shard, so even a real route would have
reset the wrong DO. Only `clearD1` ever ran. Deleted rather than implemented: shard-local rows are
reachable only through their channel and every spec mints a fresh one, so nothing depends on
clearing them. The e2e fixture's "Clears DO state so tests are order-independent" and the
`workers: 1` rationale now say what actually happens — D1 is truncated, DO state is not, and
order-independence comes from each spec minting its own channel.

Tests: the generated `api` keeps `onEmail` out of `ApiTypes` and in `InternalApiTypes`, and the
worker entry no longer calls the phantom route.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* test(docs): make the doc-snippet deny-table falsifiable on its own

Every `NONEXISTENT_API` entry was added because a shipped doc matched it, and
once that doc is fixed the pattern matches nothing forever. From then on a
narrowed or broken regex reads exactly like a clean repo — the run is green
either way. That is the property the error-catalog scanner grew a self-check
for in this same wave; this file had none.

Add fixture strings per entry, asserting both directions: the pattern still
matches the wrong form, and does not match the correct one. Verified by breaking
it each way — narrowing `(?:const|let|var)` back to `const` reports the missed
`let`, and widening `\w+` to swallow a destructuring pattern reports that it
would now reject valid docs.

Two patterns widened while adding their fixtures: `useMutation` was bound to
`const` and missed `let`/`var`, and `ctx.db.findMany` matched only quote
characters, missing a template literal.

Also demote the payment section header in the error catalog from `/**` to `/*` —
as a docblock it attached itself to nothing, sitting between the previous entry
and `CONFIG_INVALID`'s own docblock.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(docs): stop the useMutation gate rejecting a correct snippet

The pattern matched any `const <name> = useMutation(` binding, so it rejected
the correct non-destructuring form — `const m = useMutation(fn)` then
`await m.mutate(args)` — which keeps the hook's object and calls `mutate` off
it. A CI gate that blocks valid docs is worse than the misuse it catches, and
the self-check added alongside it could not see this because its samples only
covered the destructuring form.

The two forms differ in whether the bound name is later CALLED, and that spans
two lines, so a per-line scan cannot tell them apart. Buffer each fence and
match over its body, with a backreference requiring the binding to be seen
called. Line numbers are recovered from the match offset, so reports still point
at the offending line rather than the fence.

Verified against all four shapes: `const send = useMutation(…)` + `send(args)`
reports at the right line; both correct forms pass; the `ctx.db.findMany` entry
still fires, so the fence-scoped scan did not weaken the line-local pattern.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(payment): mint the arg-shape guard as VALIDATION_ERROR, not CONFIG_INVALID

Cataloguing `CONFIG_INVALID` as `internal: true` is right for what the code was
meant to carry — "webhook secret not configured", a duplicate or absent adapter
— messages that name server wiring and that the caller can do nothing with. But
`check()`'s argument-shape guard minted the same code for "check() requires a
featureId or priceId", which is the caller's own mistake, so marking the code
internal turned actionable guidance into a generic 500.

Move those two sites to `VALIDATION_ERROR`, already in the payment taxonomy at
400 and already catalogued as caller-safe. The `entitlements`-not-configured
sites stay on `CONFIG_INVALID`: those do name server configuration, and the
detail survives in the server-side log.

Record the constraint in the catalog docblock so the next caller-fixable failure
is not added to this code, which would quietly re-widen what the flag redacts.

252 payment tests and 669 errors tests pass.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* docs(values,errors): correct two claims the code does not support

`v.bigint()`'s JSON Schema said it names "the JSON carrier". It does not: every
RPC arg path runs `decodeWire` first (`shard-do.ts` 5528/5588/5647/5925), so a
bigint's actual carrier is the tagged array `["$lunora.wire$","bigint","5"]` and
a bare `"5"` fails the parser exactly as a bare `5` did. The emitted shape is
unchanged and still right by the file's own convention — `bytes` and `date`
describe their decoded payloads the same way, and nothing here consumes a tuple
schema — but the comment claimed a parser agreement this node does not have,
which is the class of thing the surrounding wave exists to remove. State the
convention and the residual gap instead.

The webhook-rejection entry claimed "the messages are fixed and name no internal
state". Five of the six mints are fixed strings; `providers/stripe.ts` forwards
the Stripe SDK's verification message. The non-internal verdict is still right —
those texts describe the request the poster sent — but the justification was
wrong, so it now says which site differs and what keeps it safe.

187 values tests and 669 errors tests pass.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* style(docs): format check-doc-imports

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* style(errors): add the blank line jsdoc/lines-before-block requires

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* **errors,values,server:** close the gates that were failing open ([#621](https://github.com/anolilab/lunora/issues/621)) ([42879c4](https://github.com/anolilab/lunora/commit/42879c4d43379f6475fb3dc9971e70a856fa796b))
* **shard-engine,container:** bracket two control channels with the wire codec ([#623](https://github.com/anolilab/lunora/issues/623)) ([da5e903](https://github.com/anolilab/lunora/commit/da5e903f9d6ea9c878fe2587f534706f02ecfff4))
* **shard-engine:** reach global rows through their own by-id facade ([#626](https://github.com/anolilab/lunora/issues/626)) ([7eb4033](https://github.com/anolilab/lunora/commit/7eb40330e4d269918a8dbf8d19323826f6fe1e07))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33
* **@lunora/bindings:** upgraded to 1.0.0-alpha.52

## @lunora/shard-engine [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.56...@lunora/shard-engine@1.0.0-alpha.57) (2026-09-05)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.27
* **@lunora/bindings:** upgraded to 1.0.0-alpha.51

## @lunora/shard-engine [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.55...@lunora/shard-engine@1.0.0-alpha.56) (2026-09-05)

### ⚠ BREAKING CHANGES

* **data:** `LocalMirror`'s `onChange` callback receives a `"diff" | "clear"`
reason argument. A zero-argument callback is unaffected.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(replica): let a replay reach the log's own readers

`events()` promises to yield every entry "continuing with every future
applyEvent / replayFromLog call", but it streams off `state-changed` and
`replayFromLog` emitted only `replay-error`/`ready`. Its phase-1 catch-up loop
exits once, so every entry a replay appended was invisible to a generator
already running. Each replayed entry now emits `state-changed`, the same
notification `applyEvent` emits for the same reason.

The same append also dropped the source entry's `timestamp`, so `EventLog#append`
stamped `Date.now()` and a replay rewrote history to the moment it ran — forty
lines below `applyEvent`, which pins the timestamp deliberately (REPLICA-07) so a
timestamp-dependent reducer stays reproducible. It is pinned on both paths now.

`EventLog#append` discarded an `InputEvent`'s own required `timestamp` the same
way, while `commitAll` has always preserved it; and `getFrom(fromSeq, 0)`
returned `{ entries: [], hasMore: true }`, which spins a paginating caller on a
page it can never advance past — `limit` is now validated like `maxEntries` and
`truncateBelow`'s floor.

Also corrects `TableDiff.id`'s docblock: it describes a `deriveInsertId`
derivation `apply-diff.ts` deliberately no longer does (hashing the diff id into
a row key is what grew the mirror by a row a second).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): page and rank past a NULL sort column

A rank sort column genuinely holds NULL — `syncRankIndexEntry` writes
`record[field] ?? null`, so a document simply missing the field is a NULL in
`__sort_k<i>__` — and `col > NULL` / `col < NULL` are both UNKNOWN. The
lexicographic seek used NULL-safe `IS` for the prefix equalities but a bare
comparator at the pivot, so:

- the `rankPage` that first reached the NULL group came back EMPTY, with
  `isDone: false` on the page before it, and pagination stopped there; and
- `rank()` returned a confident position counted against a partial set, next to
  a correct total.

Four sites had the same shape (the DO writer's seek and its `countRankBefore`,
and the SQL store's twins of both). All four now go through one
`rankPivotConditionSql`, which is the treatment `pivotCondition` already applies
to the row-store's keyset seek: a NULL pivot resolves to "every non-null row" or
"no row" depending on which side is sought, and a non-null pivot picks up the
NULL group with an `IS NULL` arm when the ordering puts it there. A branch that
cannot match is dropped rather than emitted as an always-false disjunct.

The SQL store's rank `ORDER BY` also named no NULL placement, so on Postgres
(NULLS LAST ascending) the NULL group sat opposite where the seek assumes it is.
It now states the placement for the sort columns the way `compileOrderBySql`
already does for every other read.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sql-store): round-trip a scalar in an untyped column

`v.any()`, `v.union()` and `v.from()` all store as TEXT — SQLite affinity TEXT,
Postgres TEXT, MySQL LONGTEXT — and `sqliteEncode` keys off the runtime type, so
a number or boolean written to one was COERCED by the engine on the way in: 42
landed as the text `42.0`, `true` (encoded 1) as `1.0`. The decode had no
declared type to reverse that with, so the caller read back a string. The
codec's own docblock claimed a scalar member "round-trips through SQLite's
native column type"; it cannot, and the unit test that pinned the claim called
`sqliteDecode` with a JS value that had never been bound to a column.

`sqliteEncode` now takes the column's kind and writes a number or boolean in
those three kinds in the marked, self-describing form the composites already
use, which `sqliteDecode` reverses by the marker alone. Strings, bigints and
composites keep the storage form they had: the WHERE path binds through the same
function without a kind, and changing them would stop existing equality filters
matching. Equality on an untyped numeric column did not match before this either
(a stored `42.0` never equalled a bound `42`), so nothing regresses.

The kind reaches the encoder only where the caller knows which column it is
filling — insert, upsert's soft-delete update, patch, replace — through
`serializeDocumentColumn`. `serializeColumnValue` stays kind-blind because it
also binds every WHERE comparison and the rank companion's sort keys, where both
sides of a comparison have to agree byte for byte.

The regression test writes and reads through a real column; asserting on
`sqliteDecode` alone is what let this ship.

`api-snapshots/sql-store.api.md` records this widening together with the
`SqlDialect.columnType` one from the MySQL `.unique()` fix that follows, so the
snapshot lands with that commit rather than being written twice.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(hyperdrive): index a .unique() column whole on mysql

InnoDB cannot index a LONGTEXT without a key prefix, `indexKeyPrefix` supplies
191, and the synthesized `.unique()` index went through the same `indexRef` as
every other index — so the constraint enforced uniqueness of the first 191
CHARACTERS. Two distinct 200-character values sharing that prefix raised
ER_DUP_ENTRY, which `mapWriteError` surfaced as "unique constraint violation":
a rejected write with a correct-looking error, on MySQL only, where D1 and
Postgres both accept it.

A `.unique()` character column is now declared `VARCHAR(768)` (768 × 4 bytes
under utf8mb4 is exactly InnoDB's 3072-byte single-column key limit), bytes
`VARBINARY(768)`, and the synthesized index takes no prefix. A value past the
bound is a loud write error rather than a wrong conflict. The numeric kinds and
bigint's `VARCHAR(64)` key were already indexable whole and are unchanged, as
are SQLite and Postgres, which index text of any length.

Pre-existing MySQL tables keep the type they were created with — the same caveat
the column collation carries, and for the same reason: `CREATE TABLE IF NOT
EXISTS` does not reshape one. Converting is
`ALTER TABLE <t> MODIFY <col> VARCHAR(768) COLLATE utf8mb4_0900_bin`.
* **data:** `SqlDialect.columnType` takes an optional second argument
`{ unique?: boolean }`. A dialect implementing the one-argument signature still
satisfies it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(hyperdrive): reject a vector filter shape json cannot represent

The containment-filter guard exists because a filter this store cannot honour
must be an ERROR rather than a silent drop, and its own docblock names the case
it then failed to catch. The walk recursed through `Object.entries`, which is
`[]` for a `Map`, a `Set`, a `Date` or a class instance — so it inspected
nothing and rejected nothing, while `JSON.stringify` turned the value into `{}`.
`metadata @> '{"tenant":{}}'::jsonb` is satisfied by every row that has metadata
at all: a filter that fails OPEN, across tenants.

At the top level it was worse. `Object.keys(someMap).length` is 0, so the
`length > 0` gates skipped both the guard and the containment clause, and the
query went out with no filter on it whatsoever.

Both are now rejected by prototype — the only test that can see a shape whose
own enumerable entries are not its contents — and the guard runs on any filter
that is present rather than on one with countable keys.
* **data:** a `Date` in a metadata filter is now rejected along with `Map`,
`Set` and class instances. Pre-compute it into an equality-shaped metadata field.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(d1): decode a studio table as global only when it is

The database browser branched on `schema.tables[table] !== undefined` — whether
the schema declares that NAME — with no `shardMode` check, in six places. But
only a `.global()` table lives in D1, so a same-named `.shardBy()`/root table
describes a Durable Object's storage, not the D1 table being read. A schema
declaring a shard-local `user` alongside better-auth's D1 `user` sent every read
of the D1 table down the schema branch: it was decoded as a `.global()` row, so
the `password|secret|token|hash|salt|credential` redaction never ran, and the
same wrong branch simultaneously disabled the two guards that exist BECAUSE
redaction is imperfect — the eq-filter equality oracle and the facet's masked
bucket. Every site now goes through one `globalTableDefinition`, the test the
admin export/import path already applies.

Two ordering defects in the same reader:

- the page read was `LIMIT ? OFFSET ?` with no ORDER BY, so which rows a page
  contains was up to the plan and two identical requests could disagree — a row
  could appear on two pages or on none. It now orders by the table's `id` (every
  `.global()` table has a TEXT primary key), or `rowid` for an external table
  without one. The shard browser keyset-paginates for the same reason.
- the facet's `ORDER BY count DESC` had no tiebreaker, so which equally-frequent
  values land in the top-N — and whether the result reports `truncated` — was
  planner-dependent. It now breaks ties on the value.

Also corrects the D1 dialect's docblock, which described `bigint` as "serialized
as a decimal string" where the shared encoder writes the order-preserving
40-character key. Both sibling dialects describe it correctly, and this module is
what the `lunora migrate generate` emitter reads for the physical column form.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* test(shard-engine): give the wide-where case more than one condition

`Object.fromEntries(Array.from({ length: 200 }, () => ["title", "kept"]))` is
`{ title: "kept" }` — an object literal holds each key once. The only
behavioural case in the expression-depth-cap suite therefore ran ONE condition
while claiming 200, and passed identically with `compileWhereSql`'s halving-pair
nesting deleted.

It now builds distinct fields. 90 of them, not 200, because the two caps meet
here: one equality binds one parameter and the bound-parameter ceiling the suite
above pins is 100, so a genuinely-200-term `where` is rejected before it can be
executed at all. The structural `widestChain` assertions still cover the full
200 — those were never vacuous, and they are what discriminates against an
un-nested implementation; a flat 90-term AND is well under stock SQLite's
expression-depth limit, so this case cannot.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(d1): teach the migration lexer sqlite's other identifier quotings

The single-statement check models `'…'`, `"…"`, `--` and `/* */`, but not
SQLite's `[…]` or `` `…` `` — both of which it accepts for MS-Access and MySQL
compatibility. A `;` inside either read as the statement terminator, so a
perfectly valid migration was rejected with "contains more than one SQL
statement". Bracket quoting has no escape (it ends at the first `]`); backtick
doubles to escape, like the other two.

Two adjacent inconsistencies in the same class:

- `buildMysqlExec.all` returned mysql2's result verbatim, where mysql2 hands
  back a `ResultSetHeader` rather than a row array for a statement that returns
  no rows. The sibling `fromMysql2` normalises that to `[]`; two adapters over
  one driver disagreeing about the same shape is how a caller ends up indexing
  into a non-array. Unreachable today.
- `advanceClientWatermark`'s module docblock said the watermark advances "in the
  same transaction" as the writes, while the function's own docblock forty lines
  down says it is NOT atomic with them. Both paths exist (`shard-do.ts`); the
  module doc was the over-broad one and now names which is which.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sql-store,d1,replica): close the review gaps in the round-26 data fixes

Five review findings, each verified against the code before it was acted on.

A UNIQUE index declared in `definition.indexes` never got the treatment a
`.unique()` column got. `indexRef` consulted only the validator's own flag, so a
declared unique index on a plain text field kept `LONGTEXT` and a `(191)` key
prefix — enforcing uniqueness of the first 191 characters, which is the same
false `ER_DUP_ENTRY` the column flag was fixed for, reachable through the other
producer. Both producers now feed one `fullValueIndexedFields` set that decides
the column type and the prefix together.

A COMPOSITE unique index cannot be handled that way: InnoDB caps a key at 3072
bytes, so bounding two columns to 768 characters each overflows it. Those are now
refused at migration time rather than silently prefixed, because a prefixed
composite UNIQUE constrains something other than what was declared.

The studio page reader chose its ORDER BY column with a test that conflated the
two table kinds. `resolveColumns` returns DISPLAY names for a `.global()` table
(`_id`, whose physical column is `id`) and PHYSICAL names for an external one, so
an external table carrying a literal `_id` column ordered by an `id` it does not
have. External tables are asked for their own primary key instead, which also
covers `WITHOUT ROWID` — those have no `rowid` to fall back on.

`subscribeToMirror` could lose a clear. `applyDiff` fans out to every `onChange`
listener, and one of them may call `clearData()` while this listener is mid-frame;
the assignment at the end of the callback then restored the map the clear had just
reset, so the next identical frame reported no changes over an emptied table. The
frame now captures a clear generation and publishes only if it still holds.

Two docblocks corrected: `mergeDiffs` promised that distinct child sequences mint
distinct ids, which an optional `id`, a shared `timestamp` fallback and a 64-bit
digest all defeat; and the watermark contract cited
`commitMutationBookkeeping(…, { strict })`, which takes no such argument — it
calls `advanceClientMutationWatermark({ strict: true })`. Also dropped an
edit-history sentence that described a previous wording rather than the contract.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* **data:** stop the mirror, rank pagination and three adapters returning wrong answers ([#604](https://github.com/anolilab/lunora/issues/604)) ([fb4a70c](https://github.com/anolilab/lunora/commit/fb4a70cd55131f72d2f5e3b8431d8396cdb8ee5a))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32
* **@lunora/bindings:** upgraded to 1.0.0-alpha.50

## @lunora/shard-engine [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.54...@lunora/shard-engine@1.0.0-alpha.55) (2026-09-04)

### ⚠ BREAKING CHANGES

* `MaterializerReducer` returns `S | typeof UNHANDLED` and `Materializer.apply`
returns a boolean. A reducer that signalled "not my event type" by returning the input state must
return `UNHANDLED`; returning the state now means "handled, nothing to do". `EventLogDO`'s
`GET /state` (and `EventLogDOClient.getState`) answers 413 past 1000 entries.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(codegen): withhold the vector wiring from the shard on a host with no vector store

The platform gate's `vectorStore` verdict reached `emitServer` and `emitApp` and not `emitShard`,
which recomputed the flag from `schema.vectorIndexes` instead. Running codegen for a target rating
`vectorStore: "unsupported"` produced a `generated.shard` byte-identical to the Cloudflare one — the
`@lunora/bindings/vectors` imports, the `createVectorSyncHook` write hook and `vectors` on the
runtime ctx all emitted — while the type surface was correctly withheld. `emitShard` now takes
`hasVectors` like its siblings, and the shard-key namespace fragment (with the `ROOT_SHARD_NAME`
import only it reads) is gated with it. `assertRequiredPackages` was a fourth consumer of the raw
count and hard-failed the build unless the app installed `@lunora/bindings` for an import the
emitted code no longer contains; it now takes the same verdict.

The regression test asserted one of the three emitters, which is how this shipped; it now asserts
all three, plus the required-package check and the sharded fragment.

Also closed, all the same class of a check that skips the caller it exists for:

- A `defineSchemaExtension` key was never validated on either path, and the package-runtime path
  validated no table names at all — so `defineSchemaExtension("rate-limit", …)` died in emit with an
  unlocated `INTERNAL` naming `rate-limit_buckets`, a table the user never typed. Both are checked
  now at the single point both paths namespace through, with a `file:line:column` diagnostic.
- `assertNoNamespaceCollisions` was fed functions and mutators only, so two `.stream()` route files
  sanitizing to one namespace emitted a duplicate key into both the `HttpStreamsRef` interface
  (TS2300) and its object literal (TS1117) — the exact failure the assert exists to name. It now
  runs once per emitted namespace space.
- Two `NODE_CAPABILITIES` notes asserted the opposite of the code they describe, in the matrix
  codegen trusts to decide whether an app can target a host: `objectStorage` claimed the bucket
  folds `A`/`a` into one object where the code percent-escapes `A-Z` to prevent exactly that, and
  `workflows` listed "terminate is not a barrier" as a gap where the host has a barrier, a guarded
  store, and a test named for it.
- `createNodePlatform` bound nothing for `globalTables`, the fourth `emulated`, gate-bearing
  capability beside queues / workflows / object storage — so an app with one `.global()` table
  passed codegen green and failed at the first global read with nothing upstream having warned. It
  composes `createNodeGlobalStore` from a `globalTablesPath` now, on the same declare-or-omit rule
  the bucket follows.
- The reference host supplied the one `SchedulerHost.cron` shape the contract forbids (declared and
  silently inert), and the TCK leg that would catch it skipped itself because it also keyed on
  `cronTicks`, which such a host never has.
* the host conformance suite now fails a host that declares `SchedulerHost.cron`
without a `cronTicks` observer instead of skipping the leg; a host with no dynamic cron must omit
the method, as the contract already required. `createReferenceHost` no longer implements `cron`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): stop silent data loss on CDC replay, relay pokes and durable streams

Three defects on the data plane, each one a place where a write, a delivery or a
transcript went missing with no error anywhere.

CDC replay's `replace` fallback carried no table scope, so it fell back to
`locateRowById(id, undefined)` — a probe over every non-global table that rests
on ids being unique across tables. That premise is false for `.source()` tables:
`liftSourceId` sets `_id` to the upstream natural primary key, so two sourced
tables with `id serial` both own a row whose id is `"1"`, and an orders update
was written into the users row. This is the normal update path, not a corner —
the incremental tick emits `op: "insert"` for a changed existing row, the PK
collision maps to a ConflictError, and the catch takes the unscoped replace. The
delete and insert siblings in the same function already carried the table.

A relay's per-socket cohort memos lived only in an instance WeakMap while
`ShardDO` builds a fresh `RelayMember` on every wake and the hibernatable sockets
survive. One eviction — the steady state, since the keepalive answers pings from
the hibernation auto-response without waking the DO — emptied them, every socket
was skipped, and the relay still answered 204, so the owner advanced the cohort
frontier and no later poke could reopen the range. They are now durable in
`__lunora_relay_memos`, hydrated on a cold miss and dropped through the same
`releaseRelayShapes` hook that retires the owner's proxy registrations, the way
`__shape_poke_cursor` and `__lunora_relay_shapes` already are. Deliveries also
gate on `trySendFrame`'s boolean instead of discarding it: a memo advanced past
frames that never left froze that shape the same way, and over-counted the
fan-out metric.

A durable-stream run whose row a TTL sweep took mid-production orphaned every
chunk it appended afterwards — the sweep's chunk delete is scoped by a subselect
over the run table, so no future sweep could reach them — and because
`appendStreamChunk` is `INSERT OR IGNORE`, the next run under that key silently
inherited them at the colliding seqs. The terminal now reclaims the chunks when
its run row is gone, and a fresh claim clears the key before inserting. Sweeping
on every attach makes the mid-run window easier to hit, not harder.
* a relay DO's `RelayHost.sql()` is now load-bearing rather than
owner-only; the engine conformance suite drives it on the host under test, so a
host whose SQL cannot carry the memos fails the suite instead of silently
freezing its subscribers after the first wake.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine)!: report an undelivered relay poke instead of pinning the memo

The relay's delivery gate held a socket's cohort memo back when `trySendFrame`
returned false, and answered 204 regardless. That inverts the repair it was
written for. `buildShapePoke` opens each range where the last one closed, so
consecutive pokes are `(A, B]` then `(B, C]` — a memo held at `A` is BEHIND the
next poke's base, `pokeAppliesToMemo` refuses it, and refuses every poke after
it. That is exactly the permanent silent freeze that rule's own docblock
describes, and the relay cannot self-heal out of it: the owner rewinds only on a
non-ok response, and the control channel returned `noContent()` for every poke.

The memo now advances for every socket the poke was applied to, the fan-out
metric counts only the sockets that took every frame, and a poke where those two
differ answers 503 with the counts — which is the signal `rewindShapeCursor`
already acts on, the same way it does for a POST that never landed. The frame
loop is `.map` before `.every`, matching the owner's local path: a short-circuit
emits a `pokeStart` with no `pokeEnd` and strands the client's buffer.

The durable memos move to `ctx-db-relay-memos.ts`, alongside their two siblings,
and hydrate ONCE PER WAKE into a `connectionId`-keyed map rather than lazily per
socket. The per-socket form issued one `WHERE connection_id = ?` per socket in a
single poke handler, on a tier that exists only past the promotion threshold and
whose evicted wake is the steady state. A targeted poke now filters by
`targetConnectionId` before hydrating anything at all.

`__lunora_relay_memos` rows were reclaimed only through `releaseRelayShapes`,
which runs from `webSocketClose` — never dispatched for a server-initiated close,
so an expired-credential drop leaked every row it held. A relay clears the table
when it loses its last socket, the one moment every remaining row is provably
dead.

Also: `ctx-db-relay-shapes`'s cost docblock claimed the relayed path was strictly
cheaper per subscriber, which stopped being true the moment a per-subscriber memo
row landed beside the cohort row; it now describes what the code does and records
the per-cohort question as open. `durable-stream`'s three copies of the chunk
delete are one `deleteStreamChunks`.
* `RelayLink.onShapePoke` returns `RelayPokeDelivery`
(`{ delivered, matched }`) rather than a bare delivered count, and a relay's
`relay_shape_poke` response is 503 rather than 204 when a matched socket did not
take the poke.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sql-store)!: decode untyped bigint keys and key mirror rows by content

`sqliteEncode` keys off the runtime JS type, so a bigint written to a `v.any()` /
`v.union()` / `v.from()` column is stored as the same order-preserving key a declared
`v.bigint()` column gets — but `sqliteDecode` returned it verbatim, so the column read back
as 40 characters of padding. The min/max companion inherited that: `mayHoldBigintKey`
matched those kinds and folded them in JS, but the fold coerced the padded string to
`undefined`, so deleting a group's stored extreme left the companion on a stale value. Decode
through `decodeBigintSqlKey` instead, which fixes the round-trip and the fold in one place.

That test is by SHAPE — exactly 40 characters, `"0"` or `"1"` then 39 digits — so a stored
*string* of that shape reads back as a bigint. Preferred to the alternative, which is not "no
ambiguity" but guaranteed corruption of every bigint in every untyped column, on every read.
The unambiguous wire marker cannot carry it instead: `sqliteEncode` returns at its `bigint`
branch first, takes no column kind, and doubles as `serializeColumnValue`, so a second storage
form would never match a WHERE binding built from the first. The collision is pinned by a test.

The JS fold reads every surviving row of a group, and `mayHoldBigintKey` matches columns holding
no bigint at all (`v.union(v.number(), v.null())`), so one extreme-removing write against a
200k-row group put 200k rows in the isolate. It now pages by keyset on `id`, the shape
`ensureRankBackfilled` already uses.
* `deriveInsertId` keys an id-less insert by the row's CONTENT rather than by
the diff that carried it. `subscribeToMirror` re-emits an un-keyed row (an aggregate, or a
projection dropping the pk) on every frame and stamps each frame with `Date.now()`, so the old
digest minted a fresh key per frame: a shard writing once a second grew the mirror by ~86,400
rows a day, nothing ever removed them, and every read returned the whole history. Two id-less
inserts carrying identical data now collapse onto one row — nothing downstream can tell them
apart, so that is the only key that stays stable across replays. Derived ids change value.

Also: `applyDiffInto` accepts a `bigint` primary key, matching the SQLite path that already
did — the two disagreed on where an int64-keyed row lands. And the `unknownEventHandling`
docblock now says it reacts only to a reducer explicitly returning `UNHANDLED`, since one that
returns `state` for an unrecognised type makes `"fail"`/`"warn"` inert.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(codegen): gate the studio's vector page on the platform verdict

`buildStudioFeatures` was fed the raw `.vectorize()` count and the raw
`@lunora/bindings` dependency, so a `target: "node"` build emitted
`studioFeatures.vectors: true` into the generated shard and the studio rendered
its Vector browser nav entry — advertising a binding the same build had just
withheld `ctx.vectors` and the whole Vectorize wiring for. The verdict now AND's
the entire expression, so both arms fall together; it is the one feature a signal
can force off, because failing open against a host with no vector binding points
the nav at what was withheld.

`hasVectors` also meant two different things across the three emitters that take
it: `emitServer` and `emitShard` took the platform verdict and AND'd the schema
count internally, while `emitApp` took the CONJUNCTION under the same prop name,
with optional-vs-required as the only tell. All three now take the raw verdict
and AND internally — `emitApp` gets the declaration as `vectorIndexCount` — so
the "declared but gated" decision is made in one place per emitter instead of
per call site. `platformGate.signals.vectorStore !== false` is named once per
call-site file rather than re-derived four times.

Also in this change:

- The shard emitter's docblock still said the `@lunora/bindings/vectors` import
  hangs on the schema alone; it is conditioned on the platform verdict too.
- `NodePlatform.globalTables` claimed to close the hole where a store nobody
  bound fails at the first global read. It does not: `.global()` reaches its
  backend only through `createShardCtxDb({ globalDb })`, `globalDb` comes only
  from the generated shard's `d1`/`hyperdriveGlobal` thunks, and this
  composition root builds no shard DO. Softened to what it is — a building block
  — with the hop a caller has to make written down. Wiring it end to end was the
  alternative and is out of reach here: nothing in this package constructs a
  generated shard to route a global read through.
- The `objectStorage` capability note claimed a lowercase key maps to a
  byte-identical filename unconditionally; `%`, `:` and a trailing `.`/space are
  escaped too. Corrected in the matrix and its verbatim docs copy.
- `EXTENSION_KEY_IDENTIFIER_RE` was a second copy of `TABLE_NAME_IDENTIFIER_RE`
  in a module that already imports from its home; the constant is exported and
  reused.
- `assertTableNameAllowed` ran twice on the AST path, which throws at the precise
  name node first, so the coarse second gate only ever fired for the
  package-runtime path. Moved to that path, where the check was actually missing.
- `RequiredPackageOptions` was a one-field options object with one caller and no
  importer; it is a positional parameter now.
- Four copies of the same `emulated` ⇒ codegen-emits-the-surface argument in
  `node-platform.ts` are one copy, on the composition comment.
* `EmitAppOptions.hasVectors` is optional and now means the
platform's `vectorStore` verdict, not "emit `.vectors()`" — pass the schema's
index count as the new `vectorIndexCount` alongside it. `assertRequiredPackages`
and `requiredPackagesFor` take the verdict as a positional `hasVectors` argument
and the `RequiredPackageOptions` type is gone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(payment): stop losing refunds, retried captures and chargeback amounts

Four money-path defects on the webhook ledger, each of which left the store holding a number
that did not match the money the provider had actually moved.

**Creem refunds never reached the ledger.** `refund.created` keyed the session on
`transaction.id`, but every Creem payment row is written under the CHECKOUT id
(`checkout.completed` stores `CheckoutEntity.id`, and `getPaymentStatus` retrieves the same id
via `checkouts.retrieve`). `RefundEntity.transaction` is required while `checkout` is optional,
so the transaction read always won and the checkout fallback was dead code. Every dashboard
refund therefore hit a nonexistent row: orphaned, 500, one retry, then silently unhandled, with
the row left `captured` and `refundedAmount = 0` forever. Creem's `refundPayment` throws, so
this webhook is the only path a Creem refund has. The existing regression test pinned the bug
(it asserted `sessionId === "tx_1"` from a fixture with no `checkout`); it now asserts the
checkout id from a fixture carrying both fields, plus a second test that pins the refund key
against the key `checkout.completed` writes.

**A payment that failed and then succeeded was dropped.** `failed` was modelled as terminal,
but a declined Stripe PaymentIntent returns to `requires_payment_method` and the same `pi_` can
be confirmed again and reach `succeeded` (or `requires_capture` on a manual-capture intent).
The confirming `payment_intent.succeeded` was rejected as `illegal_transition` with a 200, so
Stripe stopped retrying while the money was captured and the row read `failed` with
`capturedAmount = 0`. `failed` now permits exactly the transitions the provider performs —
`capture`, `authorize`, and a `fail` self-loop for a second decline on the same intent — while
refunds stay illegal, since nothing was captured to reverse. `failed` accordingly leaves
`PAYMENT_TERMINAL_STATES`, so a reconcile sweep over non-terminal rows now covers it.

**A lost Dodo chargeback reversed zero.** `GetDispute.amount` is a string, so `readNumber`
yielded `undefined` and a lost dispute recorded `0` while moving the row to
`partially_refunded`. The fixture used a number the real API never sends, so the gate asserted
nothing. A whole-number string is now read as minor units, matching every money field Dodo does
document; a non-integer string is refused rather than scaled, because the dispute amount's unit
is undocumented and choosing between "25.00" meaning 25 and meaning 2500 is a 100x error on a
reversal — the action then carries no amount, which records a full reversal with the money
untouched instead of a guessed figure. No other numeric read in that adapter reads a field the
SDK types as a string.

**Every provider guide taught the webhook wiring the overview forbids.** All five pages wired
the route with `Response.json(await ctx.runAction(...))`, which collapses the deliberate 500 on
an orphaned event to a 200 and makes the whole orphan/one-retry mechanism inert for anyone who
copies a provider page. They now use `webhookResponse`, and a new test asserts no docs page
regresses to the hand-built response.

Also corrects the `paymentsFromContext` comment that claimed `??` normalises an empty-string
identity to `undefined`; it does not, and the invariant rests on the authorizer's `trim()`
clause, which the comment now says so nobody removes it.
* `PAYMENT_TERMINAL_STATES` no longer contains `failed`, and the payment FSM
accepts `capture`, `authorize` and `fail` out of `failed`. A caller sweeping non-terminal rows
will now include failed payments, which is the point: they may have succeeded on a retry.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* test(codegen): stop pinning the heaviest suite below the shared timeout

Every full `vis run test:coverage` sweep reported one or two
`Error: Test timed out in 10000ms` from `codegen:test:coverage` with zero
assertion failures, varying which specs lost the race. Run alone the project
passed 1674/1674. That was written off as sweep contention five sweeps running,
which made a real codegen failure indistinguishable from the noise.

It was not generic contention. `getVitestConfig` stopped keying its timeouts on
`process.env.CI` and settled on a flat 30s, because `vis` fans the suite across
a developer's machine while CI gets a dedicated runner — local is the MORE
contended environment and the ternary gave it the shorter fuse. Two packages
kept hand-rolled copies of the old idiom and were missed. codegen's read
`CI ? 60_000 : 10_000`, so the intent was double headroom but the effect was
that the single heaviest suite in the repo ran at a THIRD of the shared ceiling
— the one project pinned below the default.

Measured, the 10s ceiling was not margin at all. Nearly every codegen spec
builds a fresh ts-morph `Project`; constructing one costs ~1ms, but the first
type-checker query against it builds a TypeScript program and parses
`lib.d.ts` at 390-710ms, paid again per Project because nothing is shared.

    codegen alone, coverage      20 specs >5s, slowest 10,625ms -> FAILED
    sweep-shaped (slots=5+load)  13 specs >5s, slowest  9,459ms -> 5% margin

Both configs now use a flat timeout. The specs cannot be made cheaper by
sharing a Project: they overwrite the same fixture paths and assert on which
declarations are visible, so reuse would leak one case's types into the next.
Concurrency is already handled — codegen inherits the `VIS_TASK_SLOTS` worker
cap from the shared config; only the timeout half of that fix was missing. No
assertion changed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(advisor): stop the KV IDOR lint failing builds on internal procedures

`kv_unscoped_user_key_idor` is the third arg-derived sink at ERROR, and the only one without the
`internal` downgrade its two siblings carry. ERROR is the build-failing tier (`advisory-gate`
defaults `strictAdvisories` on in CI), so an `internalMutation` doing `ctx.kv.put(args.key, …)`
aborted `lunora codegen` / `lunora deploy` over "any caller can read/overwrite/delete another user's
entry" — false by construction for a procedure no caller can reach. The evidence was missing too:
`run-codegen` handed the resolved function table to the owner-field and storage-key discovers and
not to the KV one, so `AdvisorKvKeyAccess` had no visibility to branch on.
* `AdvisorKvKeyAccess` and `KvKeyAccessIR` gain an optional `visibility`, and
`discoverKvKeyAccesses` takes the function table as a third argument (defaulted, matching its two
siblings). Findings for `internal` procedures now emit at INFO/INTERNAL, and every finding's
metadata carries `visibility`.

Also in the advisor:

- `workflow_unused` guarded on the DECLARATION array and defaulted the usage array, so `workflows`
  without `workflowCalls` reported every declared workflow as never started — a verdict about call
  sites nobody supplied. It now requires both, which is what `geo_index_unused`'s comment already
  claimed it did.
- `parseAdvisorMap` validated every field `compareToBaseline` dereferences except `checks`, which
  `checksWorsened` calls `.map` on. A row of `checks: {}` survives `?? []` and threw a TypeError
  inside the CI gate — the merge-conflicted-artifact case the docblock says it defends against.
- Column masking was documented two opposite ways in one package: the relation-load evidence
  modules said masking does not descend into `with` hops, while the lint implements (and the runtime
  does) the opposite — the loader applies the READING procedure's policy at every depth. Corrected
  in all three places.
- The docs advertised a `Lint.weight` override that no interface declares and nothing reads;
  dropped, along with the `weightOf` seam in `attributeFindings` that existed only for it. The docs
  also claimed `parseAdvisorMap` rejects an older-version baseline, which `baseline.ts` deliberately
  does not.

Four gates asserted nothing for the shape production emits, all now covered:

- `fan_out_breadth` was only ever exercised with a `group` set, yet the runtime's `ShardTrafficEntry`
  has no such field — the ungrouped deployment-wide prose and cacheKey every real run produces were
  asserted nowhere. Same for `hot_shard`'s root-shard label (`shardKey: ""`).
- `relation_references_unknown_field`'s `many`-side column swap — its only non-trivial logic — had
  three fixtures, all `r.one`. Dropping the swap raises a false ERROR on every to-many relation.
- `allow_unauthenticated_shard_access_enabled` had no fixture for the `lunora()` callee, which per
  its own docblock is the only way a default-Vite app can set the flag.
- `circular_fk`'s Johnson unblock cascade had no fixture; without it a real cycle is silently
  dropped while all ten existing tests stay green. The MAX_CYCLES cap was untested too, and the
  rotation the docblock calls load-bearing genuinely is — the search order is locale-collated while
  the rotation compares by codepoint, and they disagree on mixed-case names.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(do)!: close the socket-plane gaps in the stream cap, expiry drop and admin gate

Three defects on the WebSocket path, each one a control the code claims to enforce and does not.

`MAX_STREAMS_PER_SOCKET` was defeated by re-sending one stream id. The cap reads `cancellers.size`
and `id` comes straight off the client frame, so N `stream` frames sharing an id all passed the cap
and each started its own pump under a single map entry. The overwritten `AbortController` became
unreachable (neither `unsubscribe` nor `webSocketClose` could abort it) and whichever pump finished
first deleted the entry its siblings were still cancelled through. A duplicate id is now refused
with the new `STREAM_ID_IN_USE` code. The cap itself was asserted by no test at all; it is now
pinned, together with the duplicate-id case.

The credential-expiry drop ran on four of five outbound socket paths. Whisper fan-out skipped it,
and on the canonical whisper workload — presence, cursors, typing indicators — none of the other
four ever fires: no SQLite write means no refresh flush, no shape poke and no global poll, and a
passive receiver sends nothing inbound. A lapsed socket kept receiving every whisper on its joined
topics, including the sender's userId, for its whole life. The same gap existed on three further
outbound paths found by sweeping every send site: the legacy `broadcastDelta` fan-out, and both
stream pumps, where the inbound check ran once on the frame that started a run that can outlive the
credential by hours. All four now drop the socket.

An admin socket was never re-authorized. `refreshSubscriptions` recomputed `isAdmin` from the
function path alone, two lines below an `isPaidFunction` re-check that exists precisely because the
registration-time gate can no longer see a later change. Rotating or clearing `LUNORA_ADMIN_TOKEN`
closed the HTTP admin plane instantly and closed nothing here: the 60-second sub-token bounded only
how long an attacker had to OPEN a socket that then served `runSql`, `readTablePage` and `getLogs`
output indefinitely, and `isSocketExpired` cannot help because an admin socket carries no identity
expiry. The upgrade now stamps an HMAC fingerprint of the authorizing token on the attachment, and
both the subscribe gate and the refresh path re-derive it from `env` and compare exactly, so a
rotation revokes the live socket. Fails closed on an unset token, an unstamped attachment, or a
mismatch.
* `SocketAttachment` gains `adminBinding`, and an admin socket without one is
refused. Attachments minted before this change lose their admin subscriptions at the next flush;
clients reconnect and re-upgrade. `ERROR_CATALOG` gains `STREAM_ID_IN_USE` (409).

Also corrects two comments that asserted properties the adjacent code does not provide:
`withRequestIdentity` claimed a single caller and used that to argue it is race-free, but
`dispatchLifecycle` is a second caller reached from `webSocketClose`; and
`x-lunora-shard-binding` was documented as riding every forwarded request when the owner `/rpc`
path never sends it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(studio): stop reporting verdicts for checks that never ran

Six defects where a panel answered confidently about work the server never did, plus the two
gates that were sitting on the worst of them.

Permissions playground: the probe dispatched `runAs` with whatever was in "Run as (userId)",
including nothing. The server rejects a blank `userId` with a BAD_REQUEST before dispatching,
and the probe's catch-all painted every throw as a red **Denied** — a security-diagnostic tool
answering DENY for a call that was never made, invited by the field's own "Leave empty to run
as admin" placeholder. The guard now lives in the shared probe (the function runner and the CLI
already had it at their own dispatch sites) and refuses with a neutral "Not run" outcome; the
placeholder says the field is required. The happy-path test clicked Run with the field empty
and passed only because the mock answered `runAs` unconditionally — the mock now models the
server's own argument validation.

Storage integrity check: past 10,000 bucket keys the check deliberately skips the RPC, and the
failure path bails the same way; both set `references = []`, which the panel renders as "No
dangling references. Every record's file reference points at an object that exists in the
bucket." The truncation warning written for exactly that case was nested inside the
`length > 0` branch, so it could never appear there. A check with no verdict now reports none
(`undefined`), the notice renders independently, and the all-clear needs a completed scan. A
bucket of exactly the cap that enumerated to its end is no longer called truncated.

KV browser: clicking Filter cleared the key list but only re-keyed the load effect when the
prefix changed, so a no-op Filter — including the very first click — blanked the list for the
rest of the session. The action bumps the reload nonce.

Studio shell: the login gate opens on the raw token while the client was built from the
debounced one, so every panel's first admin read after a login ran on a credential-less client
for 300 ms. The mirror now snaps on the empty/non-empty transition; editing an existing token
stays debounced.

`useAdminSpec`: the "fetcher must be stable" contract was violated at both call sites, and
because `classify` mints a fresh object every settled fetch re-rendered and refetched. Under
vitest the loop is unbounded (a test asserting one fetch times out); in the build only React
Compiler's silent bail held it. The effect reads both callbacks through effect events, so it is
keyed on `inlineSpec` alone and a caller cannot get it wrong.

Bulk drain: `written` was assigned only from the resolved result, so a failed delete/patch
always reported "at least 0 rows were already deleted" no matter how many batches had committed.
The count is accumulated at the transport, where a batch is on disk the moment its call
resolves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(client): hold, never destroy, an offline write of unknown identity

The built-in offline queue purged the queuing user's own durable writes on every
reload. `passesReplayIdentityGate` had no branch for "nobody signed in yet": the
constructor hydrates the queue and opens a socket itself, the socket's `open`
flushes with no auth gating, and the app's session resolve lands a tick later —
so a write stamped `subj:u1` met a `null` current identity, was rejected
`OFFLINE_IDENTITY_CHANGED` and unpersisted. Irreversible.

The client already owned the rule: `replayIdentityVerdict` returns `"unknown"`
for exactly that state and its docblock says dropping there destroys the write.
The outbox path honoured it; the queue path — the default for the standalone
client — never did. Both now route through the one verdict, which grew a third
outcome: hold (stay queued and persisted, stamp intact) instead of a boolean.
`rejectQueuedForIdentityChange` gets the same per-item treatment, so signing in
from signed-out no longer drains the signing-in user's own restored writes, and
no longer wipes the whole durable read cache on every cold boot.

The sticky-`subject` machinery that keeps a token refresh from reading as a user
switch was unreachable in production: every shipped adapter calls
`setAuthToken(token)` with no subject, and `useAuth`'s `setToken` gave apps no
way to pass one. `getCurrentUser` now establishes it from the resolved user —
the one call every adapter's identity store already makes — so a refresh keeps
the identity, the queue and the read cache. A subject carried across a token
change is unconfirmed until the next session resolve attributes the NEW
credential, and every replay verdict holds for that window: the client cannot
yet tell a refresh from an account switch, and must not replay one user's writes
under the other's token.

Also: re-stamp `ShardConnection.identity` alongside the queue and watermarks, or
every read cached after a late subject resolve is filed under a fingerprint the
next session's identity gate rejects; bound `clientWatermarks` by identity;
open sockets for queued-write shards when a `crossTabSync` tab self-promotes,
which a write-only shard's restored writes otherwise never got.
* clearing the auth token now clears an established subject. A
credential-less subject would let the next sign-in inherit the previous user's
identity, queue and read cache.

Two tests asserted the destroyed-write behaviour with a signed-out fixture
titled "a different identity"; both are rewritten to hold, with separate cases
for a genuinely different identity that still drops.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(server): close the policy gates that failed open on the request edge

`mask()`'s `bypass` was the one policy hook evaluated by TRUTHINESS, and it failed
open: a `bypass` returning a claim rather than a decision (`({ auth }) =>
auth.identity?.role`, the `.can(...)` forgotten) skipped the whole mask for every
caller whose claim was merely present, serving `ssn` / `email` / `hashedPassword`
raw with no error and nothing in the logs. Narrowed to `=== true`, matching every
sibling gate. No test covered it; one now returns a truthy non-boolean and asserts
the column stays masked.

`storageRules()` rebuilt `ctx.storage` as an allowlist literal and dropped
`deleteAfterCommit`, which the generated ctx installs on every dispatch that can
host a mutation handler — so a guarded mutation threw a bare `TypeError` on a
method its own type promises. It is now a guarded method, gated as a `delete` at
ENQUEUE time (the queue replays `delete(key)` after the transaction commits, past
every wrapper, so the enqueue is the only point a rule can see the key).

`ctx.db.system` reached the same R2 adapter `storageRules` fences, ungated: a query
under a `read` prefix rule could still enumerate key/size/sha256 for every object
in the bucket, and fetch any one by key. Bytes were gated; keys and hashes were
not. The middleware now rewrites `ctx.db.system` too — the `_storage` enumeration
is filtered to the objects that clear both `list` and `read`, and the by-key `get`
is refused like `getMetadata`/`head`. `list` rules consequently govern something
real, which their docblock previously admitted they did not.
* `httpRoute(...).output(v)` now binds `.stream()`, so a stream
handler must yield the declared output type and each chunk is parsed through the
validator before its SSE frame is written. `.output()` used to be accepted and
silently discarded on a stream route — SSE was the one result path that skipped
`applyOutput`, whose contract is that every transport routes through it. A chunk
that violates the schema ends the stream with a redacted `event: error` frame.
* `defineListArgs(...).toQueryArgs()` now rejects an over-long
`in`/`notIn` array instead of truncating it, matching what the validated `.input()`
path does with the same value. Truncating `in` merely narrows; truncating `notIn`
DROPPED exclusions and returned rows the caller asked to exclude.

Also in `@lunora/server`:

- `document-history`'s `redact()` now walks `Map` and `Set`. Both round-trip
  through the wire codec and a `Map` holds NAMED keys, so a column holding
  `new Map([["refreshToken", tok]])` was retained verbatim against the module's
  "secret-shaped fields are dropped recursively" claim.
- `listForDocument`'s `limit` is clamped. It was the one preset read with no
  ceiling on `take()`, and it returns full un-RLS'd row snapshots.
- `defineActionCache`'s "What it does not do" now states that the cache is global:
  the key is `(name, args)` with no identity component, so a `compute` closure that
  reads `ctx.auth.userId` serves one caller's result to every other caller.

In `@lunora/runtime`:

- `serverQuery` and an `httpRoute`'s `ctx.run*` skipped `assertDispatchableEnvelope`,
  leaving the RLS-blind `__lunora_relation__:*` read reachable single-shard — and
  the shard applies no gate of its own, citing the worker's refusal as the reason.
  The refusal is now one shared guard applied on every dispatch surface, the
  scheduler/cron root included. `ctx.run*` also stamps `x-lunora-system: "1"`, so
  an unguarded dispatch there read raw rows as a trusted caller.
- The two admin RPCs the worker serves itself at `/_lunora/rpc` never evaluated
  `adminGate` (it is scoped to `/_lunora/admin/*` to stay off the data hot path), so
  an Access-only deployment got 403 on the Studio's auth-audit and
  notification-device reads. The grant is now recorded once the envelope has named
  one of them, leaving ordinary RPC traffic untouched.
- `resolveX402Charge` served every paid procedure FREE when `options.functions` was
  absent, under a docblock promising the paywall is fail-closed by construction. It
  warns once now, like the identical missing-registry condition for `replicaReads`.
- `health-routes` sorted by `localeCompare` under a comment claiming snapshot
  stability; `localeCompare` resolves against the runtime's locale and ICU version,
  which the repo says twice in writing. Now UTF-16 code unit.
- The two scheduler admin routes reading a bare `request.json()` read under the
  shared byte budget like every sibling.

New gate: `admin-route-table.test.ts` walks every `/_lunora/admin/*` path declared
in the source through a credential-less worker and asserts none of them answers.
Nothing previously enumerated the route table, so a newly added admin route that
forgets its gate was caught by no test. Verified by ungating one route and watching
it go red.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* chore(shard-engine): record adminBinding on the socket attachment snapshot

`SocketAttachment` gained `adminBinding` when the socket plane started
re-authorizing admin subscriptions, but the type lives in `shard-engine` while
the change landed in `@lunora/do`, so the per-package `api:check` that ran there
never saw this snapshot.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(advisor,platform-node): validate baseline check entries and unwind a failed compose

`parseAdvisorMap` guarded the `checks` container but not its entries, which left the same
defect one level in: `checksWorsened` keys a Map on `check.name` and compares
`check.occurrences` with `>`, so a `null` entry throws inside the CI gate the same way a
`checks: {}` did, and a non-numeric `occurrences` makes every comparison `false` — a corrupt
baseline then reads as "no regression". Both the procedure rows and the project bucket now
require each entry to carry a string `name` and a finite `occurrences`, the only two fields a
baseline's checks are ever read for; `level` and `weight` stay unchecked because nothing reads
them off a baseline.

`createNodePlatform` built the shard connection, the registry and the scheduler before queues,
object storage and global tables. Several of the later steps throw on bad input — a queue whose
dead-letter target nothing declares, a `globalTablesPath` that cannot be opened — and the throw
escaped before any platform object existed, so the sqlite handle (with its WAL/SHM sidecars),
the registry's live shards and the scheduler's armed timers leaked for the life of the process.
Construction now records each resource's own teardown thunk — they are three different shapes,
a bare `dispose()`, a `close()` method and a `dispose()` method — and unwinds them in reverse
on the way out, swallowing a teardown error so the construction error still reaches the caller.
* `close()` unwinds the same list, so it now runs in reverse construction order
(global store, scheduler, registry, shard) rather than the previous scheduler-shard-registry-
global-store order. Scheduler timers still come before the connection they would fire against.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* security(runtime)!: refuse to build an x402 paywall that cannot see its paid functions

`.x402({ price })` tags are read off the `functions` registry, so a worker configured with an
`x402Charge` gate and no registry paywalled nothing: `resolveX402Charge` returned `undefined` for
every path, and EVERY paid procedure dispatched free — no 402, no settlement, no receipt — under
a docblock promising the paywall is fail-closed by construction. The condition warned once per
worker and served the request, trading an authorization hole for a log line nobody reads.

Move the refusal to worker construction: `createWorker` now throws `MISCONFIGURED` when
`x402Charge` is supplied without `functions`, naming both ways to fix it. A misconfigured paywall
should fail at boot with an actionable message, not serve paid functions free at runtime. Per-RPC
refusal was the wrong lever — it would have taken a free app down over a paid-function config,
which is the objection the warn-instead choice was answering; construction-time refusal answers it
without leaving the gate inert.
* `createWorker({ x402Charge })` without `functions` now throws instead of building
a worker that serves paid procedures free. `defineApp()` always supplies the registry, so only a
hand-rolled `createWorker` can hit this; no example or template passes `x402Charge` today.

The identical missing-registry condition on `replicaReads` is left as a warning. It is a placement
optimization, not a gate: inert means every read is served by the shard owner, which is correct and
merely slower, so refusing to boot over it would trade availability for nothing.

Also enforce the studio orphan check's live-key cap during iteration, not only between pages.
`StorageListFunction` is a caller-supplied seam and the admin route returns its result unchanged,
so nothing enforces `objects.length <= limit`; the walk pushed every object of every page and
only then re-tested the cap. An over-sized cursorless page therefore produced a key list past the
bound while reporting `truncated: false` — a complete verdict over work it did not bound. Take
only what fits and mark the walk truncated when a page's keys were dropped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(replica): key rows on the wire form and bound the /state body

Three defects around the content-derived row id and the event-log DO's unpaged read.

Derived row ids hashed a JSON encoding of the row AFTER the wire decoder had run, so every
value with no own enumerable key rendered as `{}`. A `Date`, a `URL`, a `Map`, a `Set`, an
`ArrayBuffer` and a literal `{}` therefore shared one digest and one mirror row — the upsert
that content-keying exists to enable was overwriting unrelated rows. `NaN`/`+-Infinity`
collapsed onto `null`, a typed array aliased the plain object with the same indices, and a
`bigint` did not hash at all: `JSON.stringify` threw, and in `applyDiffToDb` that throw is
inside the transaction, discarding every well-keyed row in the batch. Encode with
`stableWireKey` (`encodeWire` + `stableStringify`) instead, which is already what
`subscribeToMirror` keys its `known` map with, so the keyed and un-keyed paths now agree on
what "the same row content" means.
* derived ids change for any row holding a `bigint`/`Date`/`Map`/`Set`/`URL`/
bytes/non-finite number, and an `undefined` array element is now distinct from `null`. Pure-
JSON rows are unchanged. `canonicalizeForHash` is gone (it was exported for the bench and
tests only, never from `src/index.ts`).

`MaterializerRuntime.applyEntries` reported an entry as unknown whenever no reducer that RAN
handled it — but a materializer already past the entry's seq does not run. Replaying an entry
to catch up a lagging materializer, over events a snapshot-recovered sibling had applied, was
therefore classified unknown and `"fail"` aborted on an event that was in fact processed.
Unknown now means no materializer handled it, not that the subset still behind it declined.

`GET /state` checked only the entry COUNT, and parsed every payload before that check, so
exactly 1000 valid-but-large entries built the whole body inside a 128 MB isolate. Both bounds
are now decided on the raw rows before a single payload is parsed, `/since` shortens a page
that would exceed the same budget (reporting it through `truncated`/`cursor`), and `/append`
carries a matching per-event cap in the same units — so an event the log accepts is always
readable, and no read can pull more than the cap times the page size.
* `/append` now rejects an event whose serialized payload exceeds 32768
characters, and one with no `payload` at all (which previously reached the NOT NULL column and
surfaced as a 500).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* close 4 audit rounds across the data path, request edge, socket plane and money path ([#590](https://github.com/anolilab/lunora/issues/590)) ([c2a8377](https://github.com/anolilab/lunora/commit/c2a8377e01c6b34926a3fe9810b3a404702ab479))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/platform:** upgraded to 1.0.0-alpha.26
* **@lunora/bindings:** upgraded to 1.0.0-alpha.48

## @lunora/shard-engine [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.53...@lunora/shard-engine@1.0.0-alpha.54) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))

## @lunora/shard-engine [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.52...@lunora/shard-engine@1.0.0-alpha.53) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/platform:** upgraded to 1.0.0-alpha.25
* **@lunora/bindings:** upgraded to 1.0.0-alpha.47

## @lunora/shard-engine [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.51...@lunora/shard-engine@1.0.0-alpha.52) (2026-09-02)

### ⚠ BREAKING CHANGES

* `lunora import` and `lunora backup restore` against a remote
URL now require `--yes`, as does `lunora seed --reset` off a TTY.
`lunora deploy --allow-schema-drift` no longer advances the schema baseline;
use `--update-schema-baseline` for that.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(protocol): close the wire-codec divergences the fixture never asserted

All eight non-JS ports accepted a map entry with MORE than two elements while
the reference rejects it, so `[["k","v","EXTRA"]]` threw in the JS client and the
Durable Object runtime and decoded to `Map{k→v}` everywhere else — two peers of
one deployment reading different values from identical bytes.

The cause is instructive: an earlier fix hardened the reference in both
directions and added only the too-short case to
`protocol/fixtures/wire-codec.json`. Every port was written against the fixture,
not against the reference, so the too-long half was never implemented. The
fixture is the contract, and it was incomplete.

So each divergence here is fixed fixture-first — add the entry, watch all eight
go red, then fix — which is both the repair and the permanent guard. Kotlin
turned out to have no map-entry check at all, and its rejection helper was
catching the resulting `ClassCastException` only by accident.

Also aligned: a typed-array payload whose byte length is not a multiple of its
element size is now rejected rather than handed back as raw bytes for the
consumer to misread; an unknown typed-array constructor name decodes to raw
bytes and drops the name, which is what the protocol README already specified
and only the reference did, and which matters because the name survived into
`stableWireKey` and therefore into subscription dedup; and duplicate map keys
collapse last-wins to match the reference. That last one was measured rather
than assumed — `Map.prototype.set` overwrites at the FIRST occurrence's position
and collapses under SameValueZero, so bigint keys merge while structurally equal
`Date` and bytes keys do not, and a second fixture case pins that half.

Python's decoder leaked `IndexError`, `TypeError` and `ValueError` out of a read
loop whose guard catches only `WireFormatError`, so one malformed frame killed
every subscription on the client — and on the built-in socket path it was
swallowed instead, leaving the query silently stale. Fixed at the source: the
decoder now raises only `WireFormatError`, and `_is_bigint_literal` no longer
uses Unicode-aware `str.isdigit()`, which accepted digits `int()` refuses. A
string `set`/`arr` payload decoded to a set of its characters — inventing data —
where the `map` branch in the same file already had the type guard its siblings
lacked; Ruby raised a `NoMethodError` its own assertion could not accept. Java
and Kotlin charged the WebSocket frame envelope against the value's depth
budget, so a value the reference legitimately encodes at the cap produced a
frame they refused.

Two reference behaviours are tightened rather than reproduced. A payload-less
`date` decoded `undefined` into an Invalid Date and re-encoded it as a NaN
timestamp, and a non-object `error` props slot ran `Object.keys` over a string
and produced `{0:"a",1:"b"}` where every port produced `{}`. Both are JS
accidents rather than contracts, both are shapes `encodeWire` never emits, and
every port already rejected them — so the reference now agrees with the ports
instead of eight languages reproducing the accident.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sql-store): store a global bigint in an order-preserving key

`v.bigint()` on a `.global()` table was stored as plain decimal text, so every
range filter, `ORDER BY`, page cursor and `MAX` over it compared
lexicographically. `where: { cents: { gt: 9n } }` returned ZERO rows while 10n
and 100n sat in the table, and `max` answered 9 for a set whose maximum was 100.
`=` stayed exact under both encodings, which is why nothing ever surfaced
loudly and five audit rounds went past it.

The shard plane solved this and says so in its own comment: "Plain decimal text
(`"10"`) is exact for `=` but sorts `"9"` after `"10"`, so ranges and `ORDER BY`
would silently return the wrong rows instead." Same schema, `.shardBy()`
correct, `.global()` wrong. That encoder is now exported and imported rather
than restated — a second copy of an order-preserving encoding is the thing that
drifts, and a cross-plane parity test compares the two answers row for row.

A backfill ships with it, because read-tolerance alone would be a NEW silent
break: with the format changed, `eq: 10n` binds the key and stops matching a row
written as `"10"`. The rewrite is keyset-paged and in-place, self-terminating
(its probe matches nothing on a converted table), and the decoder still reads
plain decimal text so no row is garbage mid-conversion. Reductions over a padded
key are refused with a typed error naming the aggregate index that answers them,
where `sum` past 2^53 previously escaped as a raw driver `RangeError`.

MySQL `.global()` tables inherited `utf8mb4_0900_ai_ci`, folding distinct values
together: `count` for tenant "Acme" answered 3 where two rows were "Acme" and
one "acme", `.unique()` rejected `alice@` against `Alice@`, and `rankPage`
partitioned by tenant returned another tenant's row. Every character column now
declares `utf8mb4_0900_bin` — column-level because a column's own collation
beats the connection's on every `column = 'literal'` comparison, and the `0900`
variant because `utf8mb4_bin` is PAD SPACE and would still disagree with SQLite
and Postgres on trailing whitespace. Pre-existing tables keep their collation;
`CREATE TABLE IF NOT EXISTS` cannot reshape one, so that is an operator `ALTER`,
documented in the dialect.

Three more: adding a field to an existing global table provisioned nothing and
every later insert died on `table p has no column named slug` — an untyped
driver message that never mentioned `lunora migrate` — while two siblings in the
same package already ALTER their own tables; `patch`/`replace`/`delete` ran
their compare-and-swap through `all`, which had no `onBookmark`, so D1's session
bookmark never advanced and read-your-writes was lost for exactly the write path
it exists for; and the admin import iterated only declared columns, so a field
renamed since the snapshot was dropped and reported as a clean success, where
the shard twin refuses the identical row.
* `v.bigint()` columns on `.global()` tables are re-encoded once,
automatically and in place, on the next migration. Values past 39 digits are now
refused with a typed `BAD_REQUEST` rather than mis-sorted. Existing MySQL tables
need `ALTER TABLE <t> CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
to pick up the collation fix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent): bound what a delegated run, a voice session and a retry can spend

An unauthenticated caller could start a run on another user's owned thread: both
owner guards read `owner !== undefined`, so a named stranger was refused and the
identity-less caller was not. That admits second-order prompt injection — the
injected row persists and is read into the model context on the victim's NEXT
turn, with the victim's tools — plus victim-billed inference and, under
`onConcurrentRun: "replace"`, termination of their in-flight run. The docblock
asserted the opposite ("the owner is immutable"), and the test that covered it
blessed the gap in its comment. The match is exact in both directions now: no
owner is an identity that owns nothing, not a wildcard.

`agent.asTool` had no depth bound. Each child gets a distinct thread key, so the
per-thread run-queue cap never applied across a delegation chain, and a
timed-out parent did not terminate its child — it reported "did not finish"
while the subtree kept growing and billing. Depth rides the run input; the
refusal is returned as the tool's answer rather than thrown, so the parent's
model answers with what it has instead of failing and retrying its durable step.

A voice session had no bound of any kind — no turn cap, no text-frame cap, and
an audio overflow that reset its own counter, so the utterance limit bounded
peak memory rather than throughput and never closed the socket. Voice turns also
ignored the agent's `compaction` config while text turns honoured it, on a
thread the two share, and the greeting was re-synthesised on every reconnect.
Turns, text length and audio are capped; wall-clock is not, deliberately — a
hibernating socket is not billed for time, and every paid action now is.

The scheduler's `recordRetry` wrote the time index while skipping every guard
`handleSchedule` enforces on the same value, two hundred lines below a comment
explaining that anything past 15 digits breaks the index's lexical ordering and
anything at 1e21 "would corrupt the index outright". A raised `maxAttempts`
walked the backoff ladder past both: the job sorted above every alarm bound and
was never dispatched again, then `parseInt` on the exponential form armed the
alarm at epoch millisecond 8 — permanently in the past, so the object re-woke
forever. Over-cap retries dead-letter now rather than firing at the cap, which
would park the job in year 33658 with no `/dead` row and nothing to act on.

A leaked workpool slot had no reset path in any shipped surface: `/status`
diagnosed the wedge perfectly and offered no way out. An admin release route
proxies the DO's existing `/complete`; a lease was the wrong shape, since it
would steal the slot of a job that is legitimately running long.

Also: `/list` and `/dead` are cursored and their clients walk every page, so a
dedupe check past 100 pending jobs stops silently scheduling duplicates and the
dead-letter panel stops hiding the backlog it exists to show; a cron trigger
that matches no registered key warns instead of reporting success; and a queue
message is only recorded as dead-lettered when a dead-letter queue exists.

One bad subscription used to abort an entire client reconnect — nothing
resubscribed, offline mutations never flushed, streams never resumed — while the
status still read `connected`. Args are encoded once at subscribe time, the way
the shape path already did it, and a decode failure reaches the subscription's
`onError` instead of escaping the socket listener. Subscribers are no longer
deduped by callback identity, so two consumers sharing one function reference
get two registrations rather than the first unsubscribe silently killing the
second.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(auth): key the rate limiter on a header the client cannot write

better-auth reads only `x-forwarded-for`, which Cloudflare does not set and any
client can send, and nothing in the repo configured otherwise. Every request
whose XFF was not exactly one bare IP collapsed onto a single shared bucket, so
three clients behind any proxy chain exhausted it and a fourth was denied
sign-in on its first attempt — at 3 requests per 10 seconds, app-wide. The same
package already refuses that header elsewhere as "attacker-chosen" and reads
`cf-connecting-ip` instead; the limiter now expresses that same policy through
better-auth's own configuration rather than a second one beside it.

Reading a header the client cannot write closes both directions of the hazard,
which matters because it was not possible to verify whether the edge appends to
a client-supplied XFF (shared-bucket denial of service) or replaces it (limiter
bypass). When no trustworthy IP resolves at all, a catch-all rule applies a
coarse global flood cap instead — a shared bucket cannot be sized for one
client, and dropping the limit discards the protection entirely.

A `javascript:` OAuth `redirectURI` reached `location.assign` in the auth app's
origin. The surrounding docblock argues correctly that the value is
authorization-server-vetted against registered redirect URIs — a claim about
HOST trust that says nothing about scheme.

A storage-rule table and a shape both gained a registration-time refusal rather
than a silent wrong answer. A `defineShape` over a `.memory()` table seeded once
and then never updated: the poke path replicates from the changelog and a memory
table is deliberately never appended to it, so the diff could not move. Making
memory tables pokeable is not implementable correctly — without the log nothing
records which keys LEFT, so a presence row for a departed user would survive on
the client forever — and the same root cause let the resume path vouch for a
table it has no record of, so a reconnecting client kept its pre-disconnect
state indefinitely. Both refuse now, and the docs page that promised live
queries "work exactly as they do on a durable one" says what is true.

A hard delete followed by a re-insert of the same id in one poke window emitted
no delta, because the changelog reports only the latest op per id and the
diff's never-replicated exemption assumed a sole op.

The remaining half is coverage for controls that had none. Deleting the RLS
filter from the legacy reader, or the masking from `.filter()`/`.first()`, left
the entire server suite green; so did removing the bulk-insert methods from the
writer guard's gated list. Those gaps are closed with tests proven RED by
mutation, and the gated-method list is now a `Record` over the writer interface,
so a new table-first method fails to compile until it is classified. The DO
admin read dispatch table was reachable but never driven by a test, leaving its
prototype-pollution guard with a permanently-dead branch. And the playground's
tests, excluded from CI as a hang, were a 15-second cold codegen against a
10-second local timeout — they run now.
* a `defineShape` over a `.memory()` table is refused at
subscribe with `SHAPE_MEMORY_TABLE`, and a read of a memory table marks its
subscription un-resumable. Both were previously silent wrong answers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(cli): keep the provisioned config in scope for the artifacts built from it

`lunora build --emit-bindings` handed an IaC deployer a manifest describing the
UN-provisioned config — the exact failure the function's own docblock says it
exists to prevent ("reading it earlier would describe the requirements the
project happened to have written down, not the ones the bundle actually has").
The dry-run rollback added last round restored the file before the artifact
steps ran, so a project with a declared nightly cron emitted `"crons": []` for
Terraform and the deployed worker never fired it. Two fixes in one branch
cancelled out. The rollback now belongs to whoever produces the last artifact,
so the manifest and the wrangler bundle are both built inside the provisioned
window.

`lunora add --from <dir>` skipped the untrusted-source confirmation that
`--source` triggers, and the same predicate was duplicated one file over, so
fixing only the reported site would still have written a files-only item
silently. One shared check covers both.

Registry output stripped C0/C1 controls but not the Unicode bidirectional
overrides that are the actual terminal-spoofing vector, and `JSON.stringify`
carried them through binding and env-var values regardless. There were also two
subtly different strippers in one directory, one citing the other; there is one
now, at the render boundary — deliberately not at parse time, because that
layer's output is WRITTEN to the user's manifests and it validates by rejection
rather than silent mutation.

Also: an export whose atomic rename failed left the complete plaintext dump in
its staging file; the `d1-to-hyperdrive` self-migration guard compared raw URLs,
so a trailing slash walked past it while both legs resolved to one worker; and
`lunora verify --format json` reported only the first platform diagnostic from
the documented CI gate.

A signed image URL decoded to a transform the signer never authorised: values
were not escaped, so a user-influenced `background` spliced new keys under a
valid signature. The sibling builder in the same directory already guarded this.
Escaping the separators fixes it without rejecting the legitimate overlay URLs
that guard would have refused.

Every live studio panel stopped streaming after an admin-token change: the
subscription effect omitted `client` from its deps under a comment claiming it
was provider-stable, while a docblock in the same file said the opposite. And
`vite build` continued after codegen threw, bundling the previous run's
generated output — the plugin failed the build on the softer signal (an ERROR
advisory) while the hard one was log-only.

Also in the studio: "Delete N matching" could send a predicate-free request
during the search debounce, because the button read the raw search box while the
request sent the debounced one — and the server accepted it as a full-table
delete, indistinguishable from `clearTable`. Both halves are closed. The
operation tape now names what a truncate or a restore actually targeted, the
"Apply index" button says Copy because that is what it does, and the flags
documented as making the studio "read-only" now say they hide controls, which is
all they ever did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: auto-review pull requests stacked on the audit branch

CodeRabbit only auto-reviews a pull request whose base branch is listed in
`reviews.auto_review.base_branches`; every other base gets a "Review skipped"
notice and a manual `@coderabbitai review` runs against an empty file set. The
audit fixes ship as one pull request per subsystem stacked on
`fix/audit-round-5` so each is a bounded, reviewable diff, which means that
branch has to be on the list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix: close the review findings on rounds 5-6

Sixteen review threads plus the two the description left open, each with a
regression test verified RED against the unfixed code.

The two open ones:

`.meta()` cleared the unbounded-string lint and enforces nothing. The
predicate matched source TEXT, so `.meta({ schema: { maxLength: 200 } })`
cleared it — and so did the bare substrings `length`/`max` anywhere in the
initializer: a comment, a nested field NAME, a default string. Detection is
now an AST walk over the validator chain, and the 132 call sites across
examples, templates and the registry that believed they were bounded now use
`.max(n)`, which emits the same JSON Schema fragment AND enforces it.
`v.string().max(<literal>)` is modelled in the AOT args compiler rather than
declining the node, so adding the bound the advisor asks for does not cost
the function its fast path; a repeated bound keeps the tighter one.

`describeObject` skipped the truncation every sibling branch applies. A JSON
body carrying its own `constructor` property is a plain object whose OWN
`constructor.name` is whatever was sent, so a client sized the validation
error it got back, and that lands in logs.

Also fixed:

- The staged export wrote at 0666-before-umask and was world-readable for the
  length of the dump.
- The registry display sanitiser passed LF through, so a manifest value could
  forge its own CLI output lines.
- The custom-source confirmation named `--source` when the resolver reads
  `--from`, asking the operator to confirm a place nothing read from.
- A voice control frame was JSON-parsed in full before its size was checked,
  so a 32MiB message was parsed once per frame on the DO's single thread.
- `cf-connecting-ip` was trusted off Cloudflare, where nothing sets it:
  rotate the header, get a fresh rate-limit bucket. Gated on the runtime;
  declared proxies still get `x-forwarded-for`.
- Import validation used `key in shape`, so a snapshot key named
  `constructor` read as declared and reached the writer unvalidated.
- A dead-letter park that got its row durable and then failed to clear the
  pending rows had its time-index claim restored, re-dispatching a job the
  dead-letter says is finished.
- A shape joining a `.memory()` relation target froze the same way a
  memory-backed shape table does; the walk now rejects both.
- A `staged: true` search index over an empty table refused every query
  forever, because nothing ever wrote its progress row.
- The bigint re-encoding pass scanned the whole table on every ctx-db — per
  request on a Hyperdrive binding — because completion was never recorded,
  and its length-only predicate skipped every negative 39-digit value,
  leaving one stored as decimal text that `eq` no longer matches.
- Studio's advisory-index metadata accepted `[null]`/`[42]` as fields, and
  its operation tape threw on a null import row before the RPC could
  validate it.
- Two docblocks in `value-codec.ts` described symbols that had moved out, so
  IDE hover attributed them to `sqliteEncode`.
- The `__agg_` companion is a DOUBLE, so it is exact per contribution, not
  per total; the aggregate refusal said otherwise.
- The CodeQL suppression named `js/unsafe-code-construction`; the alert is
  `js/bad-code-sanitization`.

`__lunora_*` tables are excluded from the studio table browser, and a
pre-existing `lint:types` failure in `@lunora/client`'s test is fixed.
* a `v.string().meta({ schema: { maxLength: n } })` never
bounded anything at runtime and now reads as unbounded to the
`unbounded_string_arg` lint. Replace it with `.max(n)`, which emits the same
schema fragment and enforces the length.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019dhrsvdiJJuDAMjmiKVrae

* test(client): type the dead-jobs fetch mock's request input

`fetch`'s input is `string | URL | Request`; the mock narrowed only the `URL`
case and called `.includes` on the rest, which fails `tsc` on the `Request`
member. Only a URL string can be substring-matched for the cursor.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: list every audit chain branch as a CodeRabbit base

Each audit-round group PR is based on the previous group's branch so the
reviewer sees one bounded diff; CodeRabbit auto-reviews only the bases on
this list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: run the lint, test and scan workflows for PRs based on fix branches

The audit fixes ship as a chain of pull requests, each based on the previous
`fix/*` branch so a reviewer sees one bounded diff. The lint, test, CodeQL and
dependency-review workflows only triggered for pull requests targeting the
release branches, so every PR in the chain was green with nothing but the
metadata checks. A `fix/**` base pattern runs the real gates for them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: run an app's codegen before its tests

The vis `test` and `test:coverage` targets depended only on upstream builds,
while the lint targets also depend on the app's own `codegen`. The playground's
`lunora/_generated` is gitignored, so a fresh CI checkout had none of it and
its tests failed on a missing module while passing locally, where the directory
already existed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: match any audit-chain branch as a CodeRabbit base

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* rounds 5-6 — session expiry, global bigint ordering, MySQL collation, agent bounds, CLI safety, SDK parity ([#544](https://github.com/anolilab/lunora/issues/544)) ([811de77](https://github.com/anolilab/lunora/commit/811de77004306ce4556a63b045628a9de2244202)), closes [#545](https://github.com/anolilab/lunora/issues/545)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/platform:** upgraded to 1.0.0-alpha.24
* **@lunora/bindings:** upgraded to 1.0.0-alpha.46

## @lunora/shard-engine [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.50...@lunora/shard-engine@1.0.0-alpha.51) (2026-09-01)

### ⚠ BREAKING CHANGES

* `AuthLike.roles`, `TestIdentity.roles` and
`ShapeReadWhereRequest.roles` are removed. Roles come from the identity's
`roles` claim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(codegen): compare validator interiors in the schema drift gate

`FieldSnapshot` recorded only `kind` and `optional`, so the drift gate was
blind inside a validator. Repointing a foreign key from `v.id("users")` to
`v.id("orgs")`, swapping a union member, changing an array's element type,
adding `.unique()` or removing `.nullable()` all produced a byte-identical
snapshot: zero drift, same hash, and a deploy that proceeded onto data the
new schema rejects.

The snapshot now records `ref`, `literal`, `of`, `key`, `fields`, `members`,
`unique`, `nullable` and `refined`, and the classifier walks them recursively.
Changes are graded rather than blanket-breaking: `changedFieldShape` and
`addedFieldConstraint` are breaking and want a backfill, while widening a
type or relaxing a constraint is safe.

Union members are ordered canonically, so `v.union(a, b)` and `v.union(b, a)`
stay the same snapshot. Top-level `fields`, `indexes` and `relations` keys are
sorted too: declaration order was load-bearing on a hashed, ledger-recorded
file, so moving a field up a line reported drift and burned a schema history
slot for an edit that changed nothing.

Deepening the snapshot changes every existing schema's hash. Each shard
appends one history row on its next cold start, whose diff against its
predecessor is empty. `SCHEMA_SNAPSHOT_VERSION` is deliberately NOT bumped —
every new field is optional, so old baselines still parse, where a bump would
hard-reject every stored snapshot with no upgrade path. To stop an upgrade
drift-storm, each new dimension is only compared when the BASELINE recorded
it, so a pre-deepening baseline reports exactly the drift it did before and
one successful deploy re-blesses it.

The studio's schema-diff view had the same shallow comparison and rendered all
of the above as unchanged while the gate blocked them. It now routes each
field through the shared differ rather than holding a second opinion, and
renders column types via `describeShape`, so a repointed key no longer shows
`id` on both sides of a row flagged as changed. Its `CHANGE_SHAPE` map was
also missing the new change types — already a `tsc` failure, and at runtime a
throw that blanked the entire change list, so a migration containing one of
these showed the operator nothing at all.

`emit.ts` and the golden fixtures move together here: the emitted `resolveShape`
drops the `roles` field that the RLS change removed, and the fixtures capture
both that and the deeper snapshot, so splitting them would leave a commit whose
fixture tests fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* perf(shard-engine): index the default sort and bound keyset seeks

Every declared index was created over its fields alone, and no index existed
for the default `_creationTime` order at all. So the common reads sorted their
whole match set into a temp B-tree to return one page: an unfiltered page cost
a full table sort (3593.8us -> 15.9us with a `(_creationTime, id)` index, 226x
at 50k rows), and a filtered-and-ordered read over a declared index cost the
same over every row sharing the key. Declared indexes now carry
`(<fields>, _creationTime, id)`; unique indexes deliberately do not, since the
sort keys would change what the constraint constrains.

The ORDER BY omitted `_creationTime` between the declared fields and the `id`
tiebreak, which skips the index's middle column and defeats the index that now
exists. Fixed in `normalizeOrderKeys` rather than in the two ORDER BY builders,
because that is the single place both builders AND `buildSeek` read their key
list from — fixing only the builders would give the seek a different total
order than the sort it pages, which skips or repeats rows across a page
boundary.

SQLite will not drop an equality-pinned EXPRESSION from an ORDER BY, so an
index-aligned sort still built a temp B-tree even though the index is built in
exactly that order. Reads now drop the leading run of index fields their range
pins with `.eq()` — only the leading run, since a two-field index with one
field pinned still has to order by the second (32622.9us -> 57.4us, 568x).

The keyset seek's lexicographic OR gave the planner no range on any single
column, so it walked the index testing every row. A redundant leading-column
bound, ANDed on, hands the range back and the walk becomes a seek. It is gated
on a non-nullable leading key with a non-null pivot — exactly when the seek
emits a bare comparator — because the `OR col IS NULL` arm turns the conjunct
into a second disjunction and the planner drops the range again. Row-value
comparison is no help: SQLite does not apply its range optimisation to an
expression index, and every shard index is on `json_extract(...)`.

`buildSeek` is now nested rather than flattened. The flat expansion repeats the
prefix equalities in every disjunct and binds `k(k+1)/2` parameters; a bounded
page ANDs two seeks, so ten columns bound 110 against Workerd's per-statement
cap of 100 and the statement failed to prepare. Factoring the shared prefix out
is the same predicate at `2k-1`: 40 instead of 112. The `where` compiler's list
budget also now subtracts what the rest of the tree already spent, instead of
assuming a list is the only thing binding parameters.

`with: { rel: { limit: n } }` bounded the result but not the fetch: a page of
100 parents asking for 5 children each read every child of all 100 and threw
the rest away. A capped relation now fans out one bounded read per parent
(50,000 rows -> 600). That costs one read per parent, and on a D1-backed
fetcher each is a Workers subrequest against a hard per-request cap, so past 32
parents it falls back to the single batched read and slices. Both branches
return the same rows.

sql-store gets the sort keys too, except on MySQL: `id` is `VARCHAR(768)` there,
which is 3072 bytes — InnoDB's entire index key limit — so appending it to any
other column fails `CREATE INDEX` and takes the migration down. A prefix would
create but buy nothing, since MySQL cannot satisfy an ORDER BY from a prefixed
column. An existing SQLite database is re-provisioned when an index's shape
changes, since `CREATE INDEX IF NOT EXISTS` would otherwise no-op and leave the
fix inert on every deployment that already ran.
* the pagination cursor prefix moves from `~2` to `~3` and
in-flight cursors are rejected with a 400. Dropping `.eq()`-pinned fields
changes a `.withIndex(q => q.eq(f, v)).paginate()` cursor from `[v, id]` to
`[creationTime, id]` — the same length, so the seek's arity check cannot catch
it and the old payload would page against a `_creationTime` pivot holding a
channel id, silently and shaped like a correct page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): stop search answering from a half-built index

Two ways a search index served a confident, correctly-shaped, wrong answer.

An analyzer-profile change made `backfillSearchIndexPage` DELETE the whole FTS
companion before re-walking it, so the index was EMPTY for the entire duration
of the rebuild and every search over that table returned nothing. The re-walk
is DELETE-then-INSERT per row, so it converges in place instead: stale analysis
on a shrinking suffix beats no rows at all.

The sibling case is a NEWLY declared index over a table that already holds
rows. It covers a growing prefix (`id ASC`) while its backfill walks, and the
read queried the companion regardless — so a matching document past the cursor
was simply missing from a result set that looked complete. Reads now consult
`isSearchIndexComplete` and refuse.

Refusing rather than falling back to the LIKE scan is deliberate. That path has
no relevance index: it takes the newest `MAX_SEARCH_SCAN` candidate rows and
scores those, dropping older matches with no signal, and its own comment
justifies the approximation on the grounds that it never runs in a Durable
Object. The two partial answers are complementary — the backfill covers the
oldest prefix, the scan window the newest 1024 — so falling back would swap one
silent wrong answer for another on exactly the large tables the backfill is
paged for.

The refusal carries a new `SEARCH_INDEX_BUILDING` code rather than
`SERVICE_UNAVAILABLE`, whose catalog entry documents it as an upstream
dependency failing to respond. Nothing is down: one index on one table is
warming, and the backfill advances on every read, so a caller that retries
makes progress where a generic outage code invites it to back off.

One `__lunora_search_state` primary-key read per search call, placed after the
backfill page so it observes the progress that read just made, and never asked
per row or per hit. A table small enough to index in one page is complete from
its first migration and never reaches the branch.

Three existing tests asserted the partial behaviour, all on a `staged` index.
`staged` is an opt-in to ENTER the partial state; it does not make a partial
answer correct, and a staged index stopped mid-`maxPages` is the identical hole.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): keep data migrations and export round-trips truthful

A mid-batch failure re-applied the transform. The runner persisted the
page-start cursor, so a resume re-walked every row of the failed batch and ran
a non-idempotent transform (the `version + 1` shape) again over rows it had
already rewritten. The cursor now advances per row, and the counters increment
only once a row is fully handled, so the persisted state names the last
completed row rather than the last page.

The rewrite also lost concurrent writes. It ran off the page document, read up
to a whole batch of `await`s earlier, while `replace` compare-and-swaps only on
the snapshot it reads inside its own call — so a user mutation landing in that
gap was overwritten with the pre-mutation value, with no conflict and no error.
Each row is now re-read between the transform and the write, and the transform
re-applied against the fresh row up to three attempts before giving up. Failing
immediately would let one hot row abort a shard's run; skipping would leave
rows silently unmigrated.

A paused run could also never resume across the cursor prefix bump. The runner
mints its own cursor from a fixed key list that did not change, so the stored
payload is still valid and only its prefix is stale — but there is no reset
path, so every retry decoded the same dead cursor and failed again, with the
only escape being a full run in the opposite direction. The stale prefix is
restamped on the resume read alone, justified there by that key list being a
constant; the decoder itself stays strict, since a same-length page cursor is
exactly what it cannot afford to accept.

Export/import did not round-trip. `_commitSeq` rode into the import and was
rejected as an unexpected field; it is a per-shard counter, so replaying one
shard's numbering would break the monotonicity readers page on, and it is now
stripped so `insert` re-allocates it. An unset optional column also came back
as `null` instead of absent, contradicting its own declared type — fixed where
the row is decoded rather than at the import site, so every reader agrees, with
the import additionally normalising `null` so snapshots taken before this
restore.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(do): tear down socket state on error and bound what grows per shard

A Durable Object dispatches exactly ONE termination event per socket. On a
terminating exception it dispatches an error event, not a close one — so a
protocol error, an event timeout, or a `webSocketMessage` handler that threw
got `webSocketError` and never got `webSocketClose`. That handler rethrew and
tore nothing down, so the socket's shape-poke cursor row survived at its last
value and pinned op-log retention for the whole shard, permanently. It now
delegates to the close path with the 1006 shape the runtime synthesizes for
the disconnect half of the same branch, and logs rather than throws.

Relayed shape registrations were never released. A relay only detaches when it
loses its LAST socket, so every retired connection on a busy relay left a row
behind that kept the retention floor pinned at its cursor. Unsubscribing and
closing now release per socket, which covers the common case the detach never
reached. Cohort rows are deliberately untouched: they are keyed per shape, not
per socket, so no single connection may retire one.

`functionStats` grew without limit — one entry per distinct function path, on a
map that never evicted, so a shard accumulated them for its whole lifetime.
New paths are refused past a cap rather than evicting incumbents, matching the
argument the durable side already makes; the doc comment claiming a bound is
now true. The dedup GC's throttle stamp was written after the sweep it guards,
so a sweep that threw re-ran on every subsequent mutation instead of backing
off. Durable-stream runs now sweep expired state in a `finally`, so every
branch sweeps after its own work — sweeping first eats the transcript an
expired-but-replayable resume is about to read.

Sixteen unguarded `ws.send` calls under `webSocketMessage` threw on a socket
that had gone away mid-handler, and a throw there is fatal to the channel; they
now go through the guarded send. The stream loop's own sends are left alone,
since their throw is the loop-abort signal the enclosing catch consumes.

A queue message dropped for exceeding its retries vanished silently unless a
capture hook was configured, which is not the production shape; it is now
always logged with its id, queue and error. `restampIdentity` reported a
failure under the wrong operation and could lose the record entirely — it now
reports the operation that actually failed and re-appends under the original
stamp, making the docblock's claim true rather than aspirational.

The log and span ring buffers dropped entries with no signal, so a shard under
load showed a plausible-looking window with no indication anything was missing;
both now count drops and surface it on the admin reads. The OTLP batcher's
drop-oldest loop was audited for the same defect and is unreachable — it drains
at exactly its cap and reassigns synchronously before its first await — so it
keeps a comment saying it is a backstop and a test pinning that nothing is
dropped, rather than a counter that can only ever read zero.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: cover shared/ in the generated-files filter

The `generated-files` job only runs when `files-changed` reports a match, and
the filter listed `packages/codegen/**` but nothing under `shared/`. Those files
are not a package — they are inlined into each consumer's bundle — so a change
confined to `shared/schema-snapshot.ts` reaches the `LUNORA_SCHEMA_SNAPSHOT`
literal in all 13 examples' generated output while the job is skipped and its
required check stays green. That is the same failure mode the filter's own
comment already describes one level up.

Also ignore `.netlify` for Prettier: it is a gitignored build output, so it only
exists in a checkout where the docs have been built, and then `lint:prettier`
fails on a bundle nobody wrote.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* chore(codegen): regenerate example generated files

Deepening `FieldSnapshot` changes every schema's hash, so all 13 committed
`lunora/_generated/shard.ts` trees carry a stale `LUNORA_SCHEMA_SNAPSHOT`.
One line each, from `pnpm run lint:generated`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(server): restore middleware-contributed roles and read the singular claim

Deriving `auth.roles` from the identity claim alone silently disabled
`@lunora/cloudflare-access`. The Access envelope carries `groups`, never
`roles`, and `accessRoles()` exists precisely to map verified groups onto role
labels by setting `ctx.auth.roles` — which the claim-only path ignored. There
was no compile-time signal either, because that middleware declares its own
context type. A role-gated ALLOW branch stopped firing and Access users lost
rows they should see; a role-gated DENY branch stopped firing and rows LEAKED,
which is the defect the roles work set out to fix.

`AuthLike.roles` is back and the effective list is the union of the two
sources. What stays removed is the same field on the TEST harness: a middleware
setting `ctx.auth.roles` is a real request-path producer, while a test setting
it directly is a world with no producer at all, and that difference is the
whole point.

The claim reader also missed the shape the framework's own stack produces.
`@lunora/auth` mirrors better-auth's `admin()` plugin, which stores a multi-role
value comma-joined in a SINGULAR `role` column, so an app forwarding its user
record verbatim had a `role` claim and no `roles` claim. Both names are read
now. The emitted `resolveIdentity` returned `{ userId }` and nothing else, so
`.auth()` plus `rls(policies, { roles })` resolved to an empty list for every
app and all 13 examples while the docs said otherwise; it forwards `role` too.

The shape-read path is documented rather than changed. It has no middleware to
union with by construction, so an app deriving roles in middleware has them on
queries and not on live shapes. Closing that means moving the mapping onto the
identity, not adding a field the shape request has no producer for — and the
comment there claimed "same single source as the request path", which the union
makes false.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(server): guard every table's facade, not only the masked and policy ones

The mask where-scope guard and the RLS relation filter were both installed on
the wrapped writer, but each middleware re-bound only the tables it had a
policy for. The idiomatic per-table form therefore skipped both.

For masking: `mask({ users: { ssn } })` with a read on the UNMASKED `posts`
left `ctx.db.posts` on its raw binding, so `ctx.db.posts.findMany({ with: {
author: { where: { ssn } } } })` was served — the value oracle the guard was
written to close — and `relationMask` was absent too, so the masked column came
back in the clear. Every one of the guard's own tests used the flat
`ctx.db.findMany("posts", …)` form, which was guarded, so none of them could see
it.

For RLS the same narrow loop leaks rows rather than values: every wrapped read
threads `relationBaseWhere`, which is what applies a policy to `with`-hydrated
children, so `ctx.db.<nonPolicyTable>.findMany({ with: { <policyTable>: true }
})` reached the unwrapped writer with no relation filter and returned child
rows the policy exists to hide.

Both loops justified the exemption on the grounds that a `.global()` table's
facade entry is bound to the D1 writer and re-binding it would query the wrong
backend. That premise is false: codegen binds every table's entry through the
one shard ctx-db, `.global()` included, and says why — `createShardCtxDb` routes
global ops to D1 internally and stamps the subscription hooks, so binding a
global facade straight to `globalDb` would skip both. The exemption bought
nothing and cost a guard.

The two tests that pinned the old binding behaviour are rewritten, not deleted,
with the reason the previous expectation was wrong.

Also collapses the read guard, which was copy-pasted at three call sites, into
one helper — and states there why `count`/`aggregate`/`groupBy` deliberately get
less (none accepts an `orderBy` or a `with`, so there is no sort oracle and no
hop to walk), so the narrower scalar guard reads as a choice rather than an
omission.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* refactor: give the shared invariants one home each

Four places had grown a local copy of something that already had a canonical
owner, and the copies were not equivalent in consequence.

The relation-operator name set had four encodings, the newest of them inside a
security guard. That guard uses it to decide whether to DESCEND into a `where`
node, so an operator it does not know is a node it walks straight past — which
reopens the value oracle it exists to close, silently, on the new operator only,
with every existing test still green. The names now live in
`shared/relation-operators.ts`, which both `@lunora/server` guards and the
engine read; the engine's per-operator metadata is keyed by that union, so a
sixth name added on one side fails to compile rather than diverging.

The relay proxy key was built by hand at three sites — the write and two
reclamation paths, in two modules — with nothing enforcing that they agree. A
registration that is never reclaimed is exactly what pins op-log retention
forever, so a changed separator would reintroduce the leak the release path was
added to fix. One `relayProxyKey` now, beside the `shapeRoutingKey` whose
docblock already makes this argument.

`shapeForm` enumerated the interior keys it compares, so a dimension added to
`FieldSnapshot` and to the builder but forgotten there would be recorded and
never compared — a byte-identical diff over a changed shape, the exact bug the
snapshot deepening exists to catch, reintroduced one key at a time. It now
destructures the flags and compares the rest, which fails safe: a new interior
key is compared automatically, and a new flag over-reports until it is named.

The studio synthesised a one-field snapshot and ran the whole schema differ over
it, per field, to answer a boolean. `diffExistingField` is exported instead.

Also documents the invariant the relay release actually depends on — `subId`
unique per connection — rather than versioning the registration: clients mint
these monotonically and the key is scoped by connection, so a reused id is a
protocol violation whose blast radius is the offending client's own
subscription, and an incarnation field would have to reach every SDK's wire
format to buy a conforming client nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): make the fan-out budget a total, not a per-level cap

The capped-relation fan-out was bounded at 32 parents per level, with a comment
claiming that also contained the nesting — that a level-2 fan-out would see
`MAX_FANOUT_READS * cap` parents and so fall back to one batched read.

It does not. Each level-1 read resolves its own nested `with` inside its own
`fetcher` call, seeing only its own `cap` parents, comfortably under any
per-level threshold. So the levels multiply instead of falling back:
`with: { a: { limit: 5, with: { b: { limit: 5 } } } }` over 32 parents costs
32 + 160 reads, and a third level another 800 — against a Workers subrequest cap
of 1000 paid and 50 free, where exceeding it is a hard request failure rather
than a slow page. A per-level bound is exactly the shape that looks safe and
multiplies anyway.

The allowance is now carried in a `FanOutBudget` shared by every level of one
read, threaded the way `relationBaseWhere` already is and for the same stated
reason. Measured with the old bound in place, the two-level case above spends 60
reads where the budget holds it to 32.

`buildOrderClause` also stopped restating the tiebreak rule and reads it from
`normalizeOrderKeys` instead. That was the one place the "single source" claim
was untrue, and the two had already drifted: the hand-rolled version took the
tiebreak direction from the stage while `normalizeOrderKeys` derives it from
`tiebreakDirectionFor`, which agree only because a staged read happens to have a
uniform direction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): serve a rebuilding search index instead of refusing it

The search refusal conflated two states that deserve opposite answers, and in
doing so cancelled out the fix it shipped alongside.

Not wiping the companion on an analyzer-profile change was justified as "stale
analysis on a shrinking suffix beats no rows at all" — but completeness was
`planSearchBackfillPass(...).finished`, which is false for the WHOLE rebuild, so
the preserved rows were unreadable and every search 503'd until the re-walk
finished. On a large table that is thousands of reads' worth of refusals, and an
`ANALYZER_VERSION` bump became a fleet-wide search outage.

A NEW index covers a growing prefix, so a search over it returns a confidently
wrong subset and refusing is right. A REBUILDING index holds every row, just
some under the old analysis, and serving it is strictly better than a 503.

The two are only distinguishable at the instant of the profile flip: from the
rebuild's second page the state row is byte-identical to a new index mid-walk,
and keeping `done` set would make the plan report finished and stop the re-walk
half-analysed. So coverage is latched in the row that already exists — a
`covered` column written as `MAX(existing, done)`, seeded once from the rows
already completed, which is the upgrade path for indexes built before this
change. `planSearchBackfillPass` is untouched: sql-store DOES wipe on a profile
change, so an encoding that made a rebuild resumable cross-engine would make it
re-walk forever or serve an emptied index.

`staged` also refused forever on a table that had no rows to walk — the write
path had covered it from row one, so the operator backfill it directed you to
had nothing to do. Staged now skips only when there is something to skip.

The docs said a staged index makes a table "searchable progressively" and "only
finds documents written after the deploy". Both were false; they now state the
real contract and how an operator makes the index usable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(client): stop a throwing handler, a raw error and a close from losing state

Four separate ways a failure path made things worse than the failure.

`reportPersistenceError` called the app-supplied handler unguarded, and every
one of its call sites is either a `.catch()` on a floating promise or a
compensating cleanup whose remaining steps get skipped. In `rewriteStamp` that
costs data outright: the remove has already succeeded, so a handler that throws
skips the re-append and a reload before the next flush loses the mutation — the
exact window that function was added to close. Guarded at the definition, since
all eight callers share the exposure, falling through to the same warning so the
failure it was reporting stays visible.

The queue's drop log wrote the raw handler error to the Workers log. The reach
is narrower than it looks — the error is always branded — but `toDispatchError`
turns a non-envelope 4xx into an `INTERNAL` carrying the upstream's raw response
text, which is how a token in an upstream body reaches stdout. Routed through
the same redaction every other error-to-output path uses. Its wording was also
checked against the code rather than against the commit that described it: only
a deterministic 4xx reaches that line, retry exhaustion never does, so the
message now says so instead of sending an operator to a dead-letter queue the
message never entered.

`webSocketClose` rethrew a failed relay post. That post is documented
fire-and-forget, recoverable by the coarser detach and full-drain reclamation,
while a rejection out of a Durable Object close handler breaks the actor and
takes every other live socket on the shard with it — and there is nobody to hand
it to, since the socket is already gone and nothing retries a close. Both relay
posts log and swallow now, matching the `webSocketMessage` sibling and the
branch that already downgraded a relay failure to a log when a dispatch error
won.

The log and span ring buffers accepted any capacity above zero, so a fractional
one truncated to a ring of zero that evicted everything handed to it, and
`Infinity` removed the memory bound on a buffer that lives as long as the DO.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): never drop a unique index it cannot re-create

Re-declaring a UNIQUE index over different columns dropped the old one so the
new one could be created. If the table already held rows that are duplicates
under the NEW column list, the create then failed — after the drop — leaving the
table with no unique constraint at all. The failed migration re-runs on every
wake and fails the same way, so nothing closes the gap on its own.

Both engines now probe for those duplicates first and refuse, naming what has to
be de-duplicated, with the previous index left in force. There is a TOCTOU
window between the probe and the create; it is acceptable, because this runs at
provisioning time only when an index's declared fields actually changed, and
losing the race costs a failed migration rather than a silently unprotected
table.

Applied to both twins deliberately. They already carry the same catalog-parsing
logic, and a guard on one destructive DDL path but not the other is worse than
the duplication it avoids.

Also removes a docblock that was committed twice in `schema-drift.ts`, the first
copy orphaned above the second.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): keep the fan-out budget internal and unspent by empty reads

Three follow-ups on the budget and the search-coverage migration.

The budget was a field on `QueryArgs`, which is the caller's own query surface.
It is internal accounting that happens to need to cross the injected `fetcher`
boundary — as a public argument it reads as a knob, and its obvious value
(`{ remaining: Infinity }`) disables the subrequest bound and turns a slow read
into a failed one. It travels under a `Symbol.for` key now: unnameable in the
public type, absent from the API surface, and still able to ride the args object
to the next level. `Symbol.for` rather than `Symbol()` because a package can
appear twice in a dependency graph and `shared/` is inlined per bundle, so a
module-local symbol could be written by one copy and read by another.

A `limit: 0` relation charged the budget for reads it never issued: it is
answered without touching the database, but still subtracted one unit per parent
key, so a zero-limit relation could exhaust the allowance and push a LATER
capped relation onto the unbounded batched path — the over-fetch the budget
exists to bound. It now short-circuits before the accounting.

The `covered` backfill ran inside the same `try` as the `ALTER TABLE` that adds
the column, so it executed only on the single call that added it. If the process
stopped in between, or the update itself failed, every later call took the
ALTER's catch and skipped the backfill forever — leaving an index completed
before this build permanently marked uncovered, refusing every search for the
length of its next rebuild. The two are separate statements now, with the update
scoped `AND covered = 0` so it is a matchless no-op after the first pass rather
than a write on every migration call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* round 4 — RLS roles, mask oracle, schema drift depth, pagination indexes ([#542](https://github.com/anolilab/lunora/issues/542)) ([61c28eb](https://github.com/anolilab/lunora/commit/61c28eb650d97cdd9d427690fd275f5b0f011df7))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/bindings:** upgraded to 1.0.0-alpha.45

## @lunora/shard-engine [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.49...@lunora/shard-engine@1.0.0-alpha.50) (2026-09-01)

### ⚠ BREAKING CHANGES

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests (#541)

### Bug Fixes

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests ([#541](https://github.com/anolilab/lunora/issues/541)) ([dfc2d4d](https://github.com/anolilab/lunora/commit/dfc2d4d07bf8f67214122dc7f14d83a9b1533d07))

## @lunora/shard-engine [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.48...@lunora/shard-engine@1.0.0-alpha.49) (2026-09-01)

### ⚠ BREAKING CHANGES

* `ctx.scheduler.runAfter` and `runAt` resolve the bare job id
instead of `{ id, scheduledFor }`. Four gates — the type, the docs, the
platform contract and the generated surface — already said `Promise<string>`;
only `@lunora/scheduler` resolved an object, and the install is a cast, so
nothing caught the disagreement. `scheduler-host.ts` assembles the platform
contract's `ScheduledJob` from the instant it already computed, so no
information is lost. The one in-repo call site is updated.

`@lunora/ai`'s default model and embedding model were settable only through
options codegen does not thread, so an app could not change either. Both now
read `LUNORA_AI_DEFAULT_MODEL` / `LUNORA_AI_DEFAULT_EMBEDDING_MODEL` from
`env`, the seam codegen does thread, mirroring the existing
`LUNORA_AI_GATEWAY_*` convention; explicit options still win.

`SocketHost.idFor` is kept but its doc no longer claims the engine uses it to
reassociate a rehydrated socket — per-socket state is keyed on the handle
object and durable identity is the engine's own `connectionId`. It is the
conformance suite's identity oracle in 8 legs, which is a real consumer.

* fix(codegen): scan the worker entry so the security lints can fire

Five ERROR-level advisor lints could never fire. `listLunoraSourceFiles`
recurses only `lunora/`, but `createBrowser`, `createPayment` and
`createInboundEmailHandler` are called from the worker entry under `src/`,
so `discoverConfigCalls` found nothing and every lint keyed on it returned
clean regardless of the code. `mail_inbound_dispatch_without_verify`,
`payment_create_without_authorize`, `browser_allow_private_targets`,
`export_sink_misconfigured` and `browser_user_url_without_allowlist`'s
suppression arm are now live.

The fix is a second, explicitly-scoped walk rather than widening the
existing one: `listLunoraSourceFiles` also feeds `refreshCodegenProject`'s
add/remove reconciliation, which drops Project files under `lunoraDirectory`
that vanished from disk, so widening it globally would have changed that set
too. Only `config-calls.ts` and `export-sinks.ts` are switched over.

`apps/playground`'s inbound email handler declares no `verify`, so it now
produces a real ERROR advisory — which is the point, but it will surprise a
gate until it is fixed.

Also inert: the umbrella's `lunorash/flags/flagship` specifier was not in the
flagship provider set, so an app importing through the umbrella got no
binding inference; and `fsTool` never registered the sandbox dispatcher, so
declaring it produced an app whose tool had nothing to dispatch to.

`constraint_validator` is kept — `runAdvisor`, the lint and
`AdvisorTableSample` are all public API and the README's example is a caller
passing its own samples. What was false was the claim that the studio feeds
it: `LintContext.tableSamples` said the studio "reads up to the configured
row cap from each table via readTablePage", which nothing does. Building a
feeder needs a bounded-sample admin read that does not exist, so the docs now
state there is no shipped feeder rather than implying one.

The generated Drizzle schemas were documented nowhere despite
`@lunora/server/drizzle` existing as a published subpath whose own docs point
at them; they now have a section explaining the global/shard split.

* fix(templates): stop scaffolding insecure cookies and a shared rate-limit bucket

`templates/expo` set `AUTH_URL: "http://localhost:8787"` in wrangler's
`vars`, which is baked into the deployed Worker. better-auth derives
`useSecureCookies` from that URL, so every project scaffolded from this
template shipped session cookies without `Secure` in production. The value
moved to `.dev.vars.example`; unset, better-auth resolves per request and the
weak-secret guard throws. The README was actively instructing users to put it
in `vars`.

All 12 non-expo templates keyed their rate limiter
`(ctx) => ctx.auth.userId ?? "anon"`, so every unauthenticated caller shared
one bucket — one client could exhaust it for all of them. Now
`ctx.auth.userId ?? ctx.ip ?? "anon"`, verbatim from the advisor lint that
prescribes it. The hand-rolled inline limiter is replaced by the copy-in
`lunora/ratelimit/schema.ts`, whose `limits` map was previously dead config:
its only key was never read, so tuning it did nothing.

`templates/expo` had no `imports` map, so `lunora registry add` produced
files importing `#lunora/_generated/server.js` that could not resolve.

In examples: `auth-playground`'s document list claimed membership isolation
in a comment while reading every row for an organization the caller merely
named; the index now pins the equality prefix to the session's own ownerId.
A procedure context deliberately carries no raw Headers, so `getActiveMember`
is unreachable from a query — the doc says so and points at the httpAction
recipe rather than implying a check that cannot happen.

`blog`'s cron was documented but never wired: no `crons.ts`, no trigger, and
`scheduled()` was never exported, so it would have fired into nothing even
once declared. Its `drafts.save` patched any id the client sent, which is an
IDOR; it now re-reads and checks the author, returning an indistinguishable
NOT_FOUND. Its bare `Error` throws were becoming redacted 500s rather than
the 401s they read as. The unused `users` table carrying a `passwordHash`
column is gone — shipping a second, empty credential store teaches worse
than losing the `.global()` demo, and the README now points at `team-chat`
for that.

* fix(playground): take the message author from the verified identity

`lunora/mutators.ts` accepted `userId` as an argument and wrote it verbatim
as the author, so any caller could post as any user. It is publicly
dispatchable — codegen registers `mutators:sendMessage` and exposes it on the
`api` proxy — so this was not a local-only path. Fixed with the framework's
existing control, `owner: "userId"` on `defineMutator`, which requires a
verified identity, rejects a mismatched argument, and overwrites the column
before the authoritative impl runs.

The same path also bypassed `messages.send`'s rate limit and its 4096-char
cap by pushing an identical row through a second entry point; both now match.

`apps/studio` read `VITE_LUNORA_ADMIN_TOKEN` unconditionally, so a production
build inlined an admin bearer token into a shipped bundle. The neighbouring
`baseUrl` was already gated on `import.meta.env.PROD`; the token now sits
behind `import.meta.env.DEV`, which is statically false in a production
build, so the variable is never read and cannot be inlined.

The signed-upload content-type check ran only when the URL had pinned one,
so an unpinned URL accepted any content type — the guard is unconditional
now, and the e2e helper forwards `contentType` so it can still mint a usable
pinned PUT.

`seedKv` stays a public action deliberately. Making it internal was
considered and would have stranded it with no caller at all: the internal
gate reads `x-lunora-system`, set only by scheduler/cron/queue dispatch,
while the Studio runner and `lunora run --as` both re-enter through the
ordinary RPC path. It takes no caller input — fixed values at six fixed keys
— so the exposure is resetting demo data. The docstring records why, and
warns that a seeder writing caller-supplied keys must not copy the shape.

Deletes a 443-line throwaway spike the file itself labelled as such.

* docs: make the non-callable examples callable and correct the wrong claims

Nineteen snippets across the concept docs used the object form
`query({ args, handler })`, which is not callable — the same page set's
migration guide says so explicitly. Every one is now the chainable builder
form the code actually exposes.

The Hyperdrive recipes assigned `ctx.sql = …`, which does not work: the
facade is wired by codegen from the app's config, not assigned in a handler.
The caching page hand-rolled 110 lines of cache bookkeeping that
`defineActionCache` does in three.

Corrections where the prose was simply false: the payment integration
claimed 12 tables where it creates 5; the read-replica page described
fallback behaviour the implementation does not have; and the offline-first
page contradicted the `.meta()` documentation this round introduced.

`packages/hyperdrive`'s README documented "Tagged-template queries" and
"Unsafe / raw queries" sections for APIs that do not exist —
`fromPostgresJs()` returns a `SqlClient` whose only member is `query(text,
params)`; `.unsafe()` belongs to the raw postgres.js client it wraps.

`sdks/python`'s `stable_stringify` docstring was the last copy of the
"code-point order" claim; the sort is UTF-16 code-unit order, which its own
`_utf16_sort_key` already implemented correctly.

* fix(examples): sort the expo manifest after adding the imports map

The `imports` map that lets `lunora registry add` resolve
`#lunora/_generated/server.js` was inserted in the wrong position.
Key order is enforced by one CI job that nothing else covers.

* style(client): satisfy the lint rules the new code tripped

Mostly mechanical, but two are real changes rather than suppressions.

The deferred-close WebSocket double added for the teardown regression test
duplicated the shared one except for a single method, which sonarjs
correctly flagged twice. The shared double now takes a `deferClose` flag and
the copy is gone. Verified the test still fails with the teardown fix
reverted, so the consolidation kept its diagnostic power.

The offline-flush barrier chained off `.then()` without returning a value.
It is a sequencing barrier with nothing to pass along, so it is an async
IIFE now — no rule to satisfy, and it reads as what it is.

The stream drain discarded its chunks into an unused binding; it collects
them and asserts the torn-down stream yielded none, which is the property
the test is actually about.

The remaining jsdoc/no-secrets disables follow the convention already used
in `@lunora/advisor` and `@lunora/codegen`: intentional bullet lists, and
back-ticked identifiers in prose that the entropy heuristic reads as
credentials.

* docs(scheduler): correct the three places still destructuring the old return

`runAfter`/`runAt` resolve the bare job id now, so `const { id } = await
ctx.scheduler.runAfter(...)` binds `undefined`. The package README and the
`lunora-setup-scheduler` CLI skill both taught exactly that, and the skill
also stated the old `{ id, scheduledFor }` shape in prose.

These are the siblings of the call site that was already fixed —
`docs/index.mdx` was updated with the signature change and its neighbours
were not.

* style(server): drop the now-redundant casts on the middleware context

`validateArgs` already returns `Record<string, unknown>`, so the two
`parsed as Record<string, unknown>` assertions at the `withCallContext`
call sites became unnecessary once it took `parsed` directly.

* fix(client): model the browser's asynchronous close in the shared socket double

The double dispatched `close` synchronously inside `close()`, which no browser
does. That hid a whole class of teardown-ordering bug from all 148 tests using
it: `teardownConnection` clears `conn.socket` AFTER calling `close()`, so a
same-tick event still found the identity guard satisfied and reached
`handleDisconnect`. The teardown regression test added earlier in this branch
had to opt into deferred close to see its own bug — which left the unfaithful
behaviour as the default for everything else.

Deferred close is now the only behaviour. Flipping it turned four tests red,
and all four were the double's fault rather than the code's: `readyState` must
flip synchronously (a browser sets it before returning from `close()`) while
only the EVENT is deferred. Fixed there; 783 pass.

Verified the teardown regression test still fails with its fix reverted, so
consolidating on one double did not cost it its teeth.

Also from review:

- `resolveRunnableTargetOrThrow` was written twice — once in the CLI, once in
  the Vite plugin — with two hand-written messages that would drift. The
  predicate is a property of the driver registry, not of either tool, so
  `isRunnableTarget`/`runnableTargetIds` now live in `@lunora/config` beside
  `resolveTargetOrThrow`, whose own docblock already argued the Vite plugin
  needs the same guard. Both callers keep their own wording; neither keeps its
  own logic.

- `check-project-json-targets.js` floored only its TOTAL count, so a declared
  workspace group that exists but holds no members passed vacuously while its
  two sibling checks failed. Floored per group, on member directories rather
  than on `project.json` files — not every member has one, by design.

- `WORKER_ENTRY_ROOTS` claimed to mirror `@lunora/config`'s
  `WORKER_ENTRY_FALLBACKS` and does not. Kept separate deliberately — one picks
  THE entry file, the other decides what a security lint may see, and equal
  lists would be wrong for one of the two jobs — but the comment now says that
  instead of inviting the reader to assume equality.

- Two `{@link}` targets are qualified, which removes the need for the
  `jsdoc/no-undefined-types` half of a suppression.

* fix(client): restore follower subscribe, and reset backoff on a frame-less socket

Two regressions this branch introduced, both found by review.

**`crossTabSync` was broken for every follower tab.** `subscribe()` was added
to the leader-only guard on the reasoning that a follower's subscribe "reached
the server only when the leader happened to hold the same
`(fn, args, shardKey)`". That is not an accident — it is the mechanism. The
follower's registration is what puts a `SubscriptionState` in
`this.subscriptions`, and `onSubscriptionData` drops any broadcast whose key it
cannot find there. Guarding it did not make a silent failure loud; it made the
leader's entire broadcast path dead code and threw `NOT_IMPLEMENTED`
synchronously out of every `useQuery`, `useInfiniteQuery`, `@lunora/db`
collection and svelte `query` in every non-leader tab.

`subscribeShape`, `whisper*`, `setConnectionContext` and
`acquireConnectionContext` genuinely have no relay path and keep their throws.

The existing follower tests could not catch this: each calls `subscribe()`
without any other tab announcing leadership, so the client is still inside its
startup claim window and the guard never fires. The new test establishes the
leader FIRST, then subscribes, then asserts the broadcast is delivered —
re-adding the guard turns it red.

**A socket that receives no JSON frame never reset its reconnect backoff.**
Moving the reset off `onOpen` was right (an upgrade is accepted before the
credential is read, so resetting there turns a lapsed token into a storm), but
"first non-error frame" is unreachable for some clients: the server sends no ack
for the `connect` envelope, and the keepalive pong is a plain string answered by
the runtime without waking the DO, so `JSON.parse` rejects it before the reset.
A whisper sender, a presence-only client, or any `ensureSocket` warm-up with no
active subscription therefore doubled its delay on every blip with nothing ever
resetting it, parking a healthy connection at the 30s cap.

Surviving a 5s window is now the second proof of acceptance — a rejected
credential closes 4001 well inside it, and that path clears the timer. The test
covers both directions: a socket held open past the window reconnects at the
initial delay again, and one closed at 100ms does not.

**`apps/playground` could not build.** The worker-entry scan added earlier in
this branch makes `mail_inbound_dispatch_without_verify` fire on an inbound
handler that really does dispatch spoofable mail into a function running with
the admin bearer and RLS off. `vite build` fails unconditionally on an
ERROR-level advisory, and `lint:types` fails under CI only — which is why the
pre-flight gate run reported green. Added the `verify` gate the lint asks for:
DMARC pass, or SPF and DKIM both passing. Fails closed, since a `null` verdict
means the receiving MX stamped no `Authentication-Results` header at all.

* fix(codegen): type the emitted scheduler config so the compiler guards the install

The scheduler return type had drifted from `Promise<string>` across four gates
with nothing failing, and the fix earlier in this branch corrected the type
while leaving the mechanism intact: the emitted config field was
`(env) => unknown`, which forced `as SchedulerLike` at all four use sites and
made the compiler blind to exactly this class of drift. The field now carries
`SchedulerLike`, the casts are gone, and the next disagreement is a build
error. Golden fixtures and all 13 example `_generated` trees regenerated.

Also from review:

- The registry's new auth and target guards threw bare `Error`, which the
  templates commit in this same branch identified as becoming a redacted 500.
  An unauthenticated caller was told the server had faulted. They are coded
  now: `UNAUTHORIZED` for the auth gate, `BAD_REQUEST` for a malformed or
  non-`https:` URL, `FORBIDDEN` for a host outside the allowlist. The
  missing-binding throws stay bare — a misconfigured deployment IS a 500.

- `@lunora/container` telemetry is batched now, so nothing leaves the process
  until a timer elapses or `flush()` drains it. Every emit used to be its own
  POST, so an existing job that exits promptly without flushing went from
  reporting everything to reporting nothing. `flush()` is documented as
  required rather than as an optimisation, including the oldest-first drop at
  the item cap.

- `examples/auth-playground` memoised the init PROMISE, so one failed
  cold-start migration was replayed to every later request for the isolate's
  life with no path back. Cleared on failure so the next request retries.

- The SDK port-discovery gates treated every directory under `sdks/` except
  `smoke` as a port, so a stray `node_modules` or `.venv` would have failed
  both permanently on a difference that is not a missing port. Anchored on the
  README every real port ships. Demonstrated both ways: a stray directory no
  longer trips it, a genuine new port still does.

- `discoverSandboxUsage` drove its scan from `TOOL_FLAGS` but kept a
  hand-written conjunction for the early break; that is the third flag waiting
  to be forgotten, so it reads the table too.

- `registry/tsconfig.json`'s exclusion rationale had grown to a ~1,100-character
  JSON string — unwrappable, unreadable in review, unlintable. Moved to
  `registry/TYPECHECK.md` with a pointer left behind.

- Noted in `withCallContext`'s JSDoc that every builder procedure now receives a
  cloned context, not only those declaring `.meta()`.

* revert(codegen): keep the scheduler config field untyped, and record why

Typing the emitted `scheduler?: (env) => …` field as `SchedulerLike` — so the
compiler would guard the seam the `Promise<string>` drift slipped through —
does not compile. `@lunora/scheduler`'s public `Scheduler.runAfter`/`runAt` are
generic with a REQUIRED `args`, while `SchedulerLike` takes it optional, so a
function needing three parameters is not assignable to one callable with two.
Every app that calls `createScheduler` directly fails, `apps/playground` and
`examples/blog` among them.

So the `as SchedulerLike` cast was not a loose annotation over two agreeing
shapes; it was hiding a real incompatibility between the scheduler package's
public type and what the DO accepts. Reconciling those two signatures is the
fix, and it is an API change to `@lunora/scheduler` rather than a cast removal.

Reverted to `unknown`, with the exact cause written at the field so the next
reader learns why the cast is there instead of rediscovering it. The
`Promise<string>` correction itself stands — that was the actual defect.

Adds `isRunnableTarget` / `runnableTargetIds` to the `@lunora/config` snapshot.

* fix(client): keep the framework-called follower surfaces inert instead of throwing

A second review pass over the fixes the first one prompted. Its highest finding
is the same shape the branch keeps producing: the earlier commit un-guarded
`subscribe` because a follower's registration is what the leader's broadcast is
matched against, and stopped there. `acquireConnectionContext` and
`subscribeShape` are not app-level calls — all five `usePresence` adapters
(react, vue, svelte, solid, angular) call the first from a component effect, and
`@lunora/db`'s shape-backed `createCollection` calls the second from its sync
path. Neither is something an app can opt out of, so the guard threw
`NOT_IMPLEMENTED` out of an effect and unwound the entire tab to an error
boundary. Before this branch presence merely failed to update.

Both are inert on a follower now. The loud throw is kept for `whisper`,
`whisperSubscribe` and `setConnectionContext`, which no first-party package
calls — those are app code, which can handle a failure.

`@lunora/agent`'s inbound handler had the same call-site-vs-layer problem with
a security edge: it built `createInboundEmailHandler` with no `verify` and
`AgentEmailTarget` gave apps no way to add one, while its own header instructs
mappers not to trust `email.from`. A claimed message starts a durable run whose
tools execute RLS-bypassed, so the gate now runs before any mapper — the same
fail-closed DKIM/SPF/DMARC check the playground got. The advisor lint could
never have caught this: it scans user projects, not this repo's sources.

Also from the pass:

- `runnableTargetIds` repeated the predicate `isRunnableTarget` defines, five
  lines below it, in the commit whose purpose was removing that duplication.
  Both moved to `driver-registry.ts`, beside the registry they query rather than
  in the module that reads `lunora.json`, and `isRunnableTarget` answers `false`
  for an unregistered id instead of throwing.
- Three registry JSON files had every em dash rewritten to `—` and their
  arrays exploded by a serializer that was not the repo's Prettier, mangling
  user-facing `description` copy. Restored.
- The emitted `scheduler?:` docblock carried a ~600-character maintainer
  post-mortem into every user's `_generated/shard.ts`. One sentence there now;
  the explanation lives in `emit.ts` where maintainers read it.
- The SDK README marker added last round NARROWED the gate it was meant to
  protect: a new port shipping without a README was invisible to discovery AND
  absent from the list, so no drift fired. Replaced with an explicit ignore
  list — a non-port directory costs one deliberate line, anything else fails.
- `examples/auth-playground` still memoised a rejected promise if `buildAuth`
  threw, one line above the fix for exactly that.
- The browser item echoed the rejected hostname back to the caller, letting an
  authenticated caller enumerate `ALLOWED_RENDER_HOSTS` by probing. Logged
  server-side, generic to the client.
- `clearConnectionTimers` replaces three copies of the same clear block across
  two teardown paths, so a fourth timer cannot be half-remembered.
- Comment trimming where the prior review's "rationale as changelog" note
  applied again, and a `jsdoc/check-indentation` suppression deleted by removing
  the list that needed it.

* perf(server): skip the per-call context clone when no middleware can read it

CodSpeed flagged 15 regressed benchmarks on this branch, all in
`packages/server`, with `N=0: no .use (dispatch floor)` down 21.5% — a
procedure with no middleware at all. That is the tell: `withCallContext`
was cloning the dispatch context on every call, where the previous
`withMeta` cloned only when `.meta()` was declared.

`ctx.args` and `ctx.meta` exist for `.use()` steps to read; a handler already
receives `args` as its own parameter. So a procedure with no middleware and no
meta is handed the dispatch context unchanged.

Measured locally rather than inferred from the instruction-count delta:

  N=0 dispatch floor   3.06M -> 4.37M ops/s   (1.43x)
  empty args           3.06M -> 4.43M ops/s   (1.44x)
  single id arg        2.71M -> 4.04M ops/s   (1.49x)

Procedures that DO declare middleware still pay the clone, and that cost is
real — it is what makes `ctx.args` reach a `.use()` step, which is what fixed
`emailGateMiddleware` and `verifyTurnstileMiddleware` throwing FORBIDDEN on
every call. Prototype delegation would avoid the property copy, but
`@lunora/auth`'s own docs teach `next({ ctx: { ...ctx, … } })`, and a spread
drops inherited properties — so the full clone is required for correctness.

* test(vite): cover the runnable-target guard

Codecov put `packages/vite/src/index.ts` at 66% patch coverage: the guard
that stops `vite build --target node` running the Cloudflare pipeline had no
test at all. Verified the two positive cases fail with the guard reverted.

* ci: keep CodeRabbit under its file cap so it reviews the code at all

CodeRabbit skipped this PR entirely — "116 files, 16 over the limit of 100" —
so a change touching every package got no automated review. The cap counts
files that survive `path_filters`, and 44 of those were markdown.

Excluded two kinds that cost review budget without earning it:

- `**/CHANGELOG.md` — semantic-release writes them; reviewing generated
  release notes is noise.
- `**/docs/**` — the long-form prose docs under `packages/*/docs/` and
  `apps/docs/src/content/`.

That brings the reviewable set to 92. READMEs stay in deliberately: they are
what a user reads first, and a wrong snippet there costs the most — this
branch fixed several.

The trade is explicit. Prose review is worth less than code review, and the
previous setting bought neither: over the cap, CodeRabbit reviews nothing.
* `useFlag`, `useFlags`, `createFlag`, `createFlags` and `flag`/
`flags` no longer take a targeting `context`, and `FlagContext` is no longer
exported. Any call passing one was passing a value the server discarded.

`react-native.api.md` drifts too: it re-exports `@lunora/react` wholesale, so it
carried a `FlagContext` row nothing would think to look for.

* refactor(runtime): stop exporting four symbols nothing outside them uses

Audited as "dead exports". Only one was dead code; the other three have live
in-file callers, so it was the EXPORT that was unused, not the function — and
deleting them would have broken working paths. `readShardKey` is the only thing
that reads `?shardKey=` / `x-lunora-shard-key` for REST dispatch;
`exportShardTable` is what `exportShardRows` delegates to per table;
`hydrateDocsById` is the `IN (...)` hydration that keeps `computeRankPage` off
an N+1. All three are now module-private.

`DEFAULT_LOG_LIMIT` was genuinely dead: a public alias of the module-private
`DEFAULT_LIMIT = 500` that nothing read except one `{@link}`. Deleted, and the
`PipelineLogQuery.limit` doc states the default literally instead of linking a
symbol that no longer exists.

Also removes an unreachable diagnostic in the advisor command. It printed
"advisor evidence unavailable — codegen ran with linting disabled" when
`advisorContext` was undefined, which requires `CodegenOptions.lint` to be set —
and that option is set at 47 call sites, every one of them inside codegen's own
tests. No production caller passes it, so the branch could not run. Deleted
rather than given a `--no-lint` flag to justify it: a user running `lunora
advisor` wants the advisor evidence by definition. The option stays for library
callers.

* fix(codegen): gate `.commitOrdered()` against the target's capability matrix

`commitOrderedTables` was rated in every platform capability matrix and read by
nothing. A host rating it `unsupported` emitted the full `.commitOrdered()`
surface with no diagnostic and silently dropped the ordering guarantee — which
is the only thing that feature is.

Promoted to a real `PlatformSignals` entry, read off the same IR that already
feeds `globalTables`, so an unsupported rating now emits
`platform_unsupported_feature` at codegen time. The test fails without the
signal key wired in.

`@lunora/platform`'s docblock called this "the outstanding case"; it now records
that it was promoted, and that `memoryTables`, `objectStorageBackups` and
`objectStorageCdcArchive` remain unpromoted instances of the same shape — rated
in every matrix, consulted by nothing.

* fix(examples): re-bless the five schema baselines that reported deploy drift

`feedback-board`, `team-chat`, `kanban-board`, `chess` and `tanstack-start` all
call `.extend(ratelimit.extension)` but their committed
`lunora/.lunora-schema.json` had no `ratelimit_buckets`, so `lunora deploy`
reported drift on each. Refreshed through the documented path.

Two of them carried more than the ratelimit drift, and re-blessing accepts it:
`kanban-board` had a required `tasks.status`, `chess` had `games.drawOfferedBy`
and `lobbies.guestId` widening `string -> union`. Both were pre-existing and
breaking; naming them here beats letting them ride in silently.

`--update-schema-baseline` was reported as crashing with "Cannot read properties
of undefined (reading 'filter')". It does not, under any condition that could be
constructed — a refactor wrapped every reconcile step in try/catch, so a
TypeError there now surfaces as a warning rather than killing the command, and
the likely original home (`DeployDriver.provision`) is dead code no CLI path
calls. No speculative fix. What the path did lack was any coverage at all, so it
now has an end-to-end test: capture a baseline, age it into breaking drift,
assert `prepare` blocks, assert the flag re-blesses it. Neutering the flag turns
it red.

The rate-limit copy-in paths taught two names for one thing: `registry/ratelimit`
called its only bucket `default` while all 13 templates and all 9 example
schemas use operation-shaped names. Reconciled on `send`. `lunora init`'s overlay
was a third copy — and was internally inconsistent, emitting `default` while the
`LUNORA_MESSAGES` it writes alongside declared `send`.

`.lunora-schema.json` is now Prettier-ignored. `serializeSchemaSnapshot` writes
2-space and Prettier rewrites it to 4, so every re-bless produced a file that
failed `lint:prettier` until someone ran `--write`. The serializer owns that
format and cannot change: its exact output is the input to `hashSchemaSnapshot`,
which is a schema version's identity in the DO's `__lunora_schema_history`
ledger. Ignoring is safe because that hash is taken from the re-serialized
object, never from the file's bytes.

Docs: `plans/README.md` described a deleted playground prototype as a live spike
deliverable, and `protocol/README.md` documented the wire grammar without the
two fixture-schema additions that now drive all eight SDK suites — `reencoded`
(for shapes that are legitimately not fixed points of `encode(decode(x)) == x`)
and `rejected[]`. Two claims those additions falsified are corrected with them.

### Features

* **studio:** set a column across matching rows ([#538](https://github.com/anolilab/lunora/issues/538)) ([2a2c9f2](https://github.com/anolilab/lunora/commit/2a2c9f229fe7affc314e9967f4c649b93c1b3559))

### Bug Fixes

* close the round-2 package audit findings across registry, protocol, client and CI ([#539](https://github.com/anolilab/lunora/issues/539)) ([e3dd702](https://github.com/anolilab/lunora/commit/e3dd70282af1aff606fe03a4ebd29c33d0029ce5)), closes [#540](https://github.com/anolilab/lunora/issues/540)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/platform:** upgraded to 1.0.0-alpha.23
* **@lunora/bindings:** upgraded to 1.0.0-alpha.44

## @lunora/shard-engine [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.47...@lunora/shard-engine@1.0.0-alpha.48) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.22
* **@lunora/bindings:** upgraded to 1.0.0-alpha.43

## @lunora/shard-engine [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.46...@lunora/shard-engine@1.0.0-alpha.47) (2026-08-29)

### ⚠ BREAKING CHANGES

* eleven packages now declare peerDependencies. Consumers that
relied on those packages resolving through hoisting must install them; the
alternative was shipping types that fail to resolve off this repo's node_modules.

`@lunora/workflow` is an optional peer of `@lunora/runtime`, so packem inlines
its types rather than importing them — the published `@lunora/runtime` carries no
`@lunora/workflow` dependency, as its source comments already promised.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

* fix: satisfy eslint and the template matrix after the packem gate

Two CI failures from making packem warnings fatal, each a gate that the local
packem sweep does not cover.

`@lunora/advisor` back to a real dependency on `@lunora/errors`. `ae-metrics.ts`
imports `LunoraError` as a VALUE, and import/no-extraneous-dependencies requires
that for anything under `src/` regardless of whether the module reaches the
bundle. packem cannot see it because that module's value exports are
quarantined — `src/index.ts` re-exports only its types — so the throwing code is
tree-shaken out. The two rules disagree by construction; the packem side is now a
commented `unused` exclusion that says which condition would end it.

`@lunora/workflow` becomes a REQUIRED peer of `@lunora/runtime`. As an optional
peer it was auto-installed anyway, and every one of the twelve templates then
resolved `@lunora/workflow` from the npm REGISTRY instead of this checkout — the
scaffold matrix builds its local-tarball map from required peers only, on the
assumption that optional ones are never pulled in. Forcing the type to inline
instead (`resolveExternals.exclude`) does not work: that option governs the JS
bundle, and the declaration build has its own resolver, so the import survived.
A required peer matches the other seven packages here and keeps the type
resolvable for consumers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

### Bug Fixes

* **docs,studio:** repair the .shardBy() migration path and surface storage headroom ([#525](https://github.com/anolilab/lunora/issues/525)) ([4ab9650](https://github.com/anolilab/lunora/commit/4ab96509847eff5e1aaa77f3ef22cfce214fe818))

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/platform:** upgraded to 1.0.0-alpha.21
* **@lunora/bindings:** upgraded to 1.0.0-alpha.42

## @lunora/shard-engine [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.45...@lunora/shard-engine@1.0.0-alpha.46) (2026-08-28)

### Bug Fixes

* close nine copied-helper divergences across eight packages ([#522](https://github.com/anolilab/lunora/issues/522)) ([a2455bb](https://github.com/anolilab/lunora/commit/a2455bb0f58b9873633504c3f1e9bfeb44a5870e))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/platform:** upgraded to 1.0.0-alpha.20
* **@lunora/bindings:** upgraded to 1.0.0-alpha.41

## @lunora/shard-engine [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.44...@lunora/shard-engine@1.0.0-alpha.45) (2026-08-28)

### Bug Fixes

* **codegen:** close eight silent-drop gaps in procedure discovery ([#513](https://github.com/anolilab/lunora/issues/513)) ([e393e49](https://github.com/anolilab/lunora/commit/e393e494c0145ad78e0f2b1e27798ed96e7039a3))

## @lunora/shard-engine [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.43...@lunora/shard-engine@1.0.0-alpha.44) (2026-08-27)

### Features

* **do:** archive trimmed changelog rows to R2 ([#507](https://github.com/anolilab/lunora/issues/507)) ([9daef2e](https://github.com/anolilab/lunora/commit/9daef2eb4b4fa2ec7163390e3155c32d5e814294))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.19
* **@lunora/bindings:** upgraded to 1.0.0-alpha.40

## @lunora/shard-engine [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.42...@lunora/shard-engine@1.0.0-alpha.43) (2026-08-27)

### Bug Fixes

* **shard-engine:** reject cursors minted before the tiebreak changed direction ([#503](https://github.com/anolilab/lunora/issues/503)) ([fdc58bc](https://github.com/anolilab/lunora/commit/fdc58bc6acc6c4f794da42e038c6953d2554c0fe))

## @lunora/shard-engine [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.41...@lunora/shard-engine@1.0.0-alpha.42) (2026-08-27)

### Performance Improvements

* **shard-engine:** sort the id tiebreak the way the key it breaks sorts ([#495](https://github.com/anolilab/lunora/issues/495)) ([8302b06](https://github.com/anolilab/lunora/commit/8302b06c8cbb81c4392c1ca1a3b1e520bdf03a6d))

## @lunora/shard-engine [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.40...@lunora/shard-engine@1.0.0-alpha.41) (2026-08-26)

### Performance Improvements

* **do:** index sort keys, wire-encode skip, batched poke writes, flat select ([#489](https://github.com/anolilab/lunora/issues/489)) ([910d218](https://github.com/anolilab/lunora/commit/910d218b6aa550ac96bc54b2acfe31922f5b29f6))
* **do:** render write statements once per table ([#488](https://github.com/anolilab/lunora/issues/488)) ([0cd7267](https://github.com/anolilab/lunora/commit/0cd72670f6d07b721e0c1c8ddfa1c5785a860df9))
* **shard-engine:** compile the DO's where clauses to text ([#490](https://github.com/anolilab/lunora/issues/490)) ([c3a9b63](https://github.com/anolilab/lunora/commit/c3a9b63e4bd4cd647407437f2f63a58940b0afd4)), closes [#491](https://github.com/anolilab/lunora/issues/491)

## @lunora/shard-engine [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.39...@lunora/shard-engine@1.0.0-alpha.40) (2026-08-26)

### Performance Improvements

* five profiled hot-path optimizations ([#487](https://github.com/anolilab/lunora/issues/487)) ([12e867c](https://github.com/anolilab/lunora/commit/12e867ceeeae59d364c4d7dc234febab187d0150))

## @lunora/shard-engine [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.38...@lunora/shard-engine@1.0.0-alpha.39) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/platform:** upgraded to 1.0.0-alpha.18
* **@lunora/bindings:** upgraded to 1.0.0-alpha.39

## @lunora/shard-engine [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.37...@lunora/shard-engine@1.0.0-alpha.38) (2026-08-26)

### ⚠ BREAKING CHANGES

* **do:** `trimCdcChanges` and `compactCdcDocs` take a per-pass row
bound. `minCdcDocSeq` is replaced by `minCdcReplayableSeq`, `countCdcChanges`
is removed, and `shapeProbeKey`/`shapeRangeKey` are no longer exported.
`ShapeDiffCache` is a class with methods instead of a record with public
mutable fields. `cdcChangedTables`, `readSqlCdcChangedTables` and
`readGlobalChangedTables` take a `cursorOnly` argument.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(shard-engine): let a failed cdc index build degrade rather than brick

`CREATE INDEX IF NOT EXISTS` is idempotent, not cheap. On a deployment
upgrading into the new `("table", seq)` index, the first cold start builds it
over everything the changelog accumulated while it had no retention —
synchronously, on the request path. A failure there aborted the whole table
migration, so every subsequent request restarted the build from scratch and
the shard was unbootable rather than slow.

The index build now fails alone. Reads fall back to the `seq` scan they used
before it existed, the retention sweep bounds the log over the following
minutes, and the next cold start retries against a smaller table.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* feat(sql-store): bound the .global() changelog with a leased retention sweep

The `.global()` `__cdc_log` had no retention at all, and could not simply
copy the shard-local sweep: that log has an owner, this one does not. Every
shard in every region writes it, so nothing knows a `seq` that is safe for
all of them, and left alone each would trim it at once.

The cross-shard floor turns out not to need a cursor registry. Its two
consumer classes want opposite things and each is served exactly:

Shape pollers hold in-memory cursors the store cannot see, so the read path
reports the retained floor and a poller below it treats the tick as no
visibility and re-reads every shape — the same self-healing path a changelog
error already takes. A trimmed poller is slow for one tick, never wrong, and
no assumption is made about how far behind a shard can be. The floor is read
only when retention is configured, so a deployment that never trims pays
nothing on a two-second poll.

Streaming-export consumers hold opaque cursors issued outside the
deployment. Nothing here can see them, so nothing guesses: retention is
opt-in (`LUNORA_GLOBAL_CDC_RETENTION_MS`), and `readSqlCdcChanges` refuses a
page below the floor with `CDC_LOG_TRIMMED` rather than serving the
surviving tail behind an advanced cursor.

The window is time, not rows. A row count is a memory bound on one object;
this log is shared, so it is not a bound any single consumer can reason
about, while "older than N" is exactly what they compare their lag against.

A one-row lease settles who sweeps: whoever wins the compare-and-set does,
everyone else returns, and the lease doubles as the interval so the sweep
rate is a property of the log rather than of the shard count. A per-isolate
throttle keeps the lease attempt off every changelog append.

The log this protects was also never written. `createSqlCtxDb` gates its
changelog on `options.cdc`, and codegen passed that flag to the three
shard-local writers and to neither global one — so the global `__cdc_log`
did not exist in any generated app, and the poll's changed-tables fast path
was unreachable while looking, from the shard side, exactly like a backend
with CDC disabled. The shard's own `cdc` config now threads through to both
global writers, so one switch governs both changelogs.
* **do:** `trimSqlCdcChanges` / `trimD1CdcChanges` are replaced by
`sweepSqlCdcRetention` / `sweepD1CdcRetention`, which take a time window
instead of a `seq` checkpoint no caller could compute. `cdcChangedTables`
and `readSqlCdcChangedTables` may now report a `floor`, and the `d1` /
`hyperdriveGlobal` config thunks accept `cdc` and `cdcRetentionMs`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(codegen): wire the .global() export, cdc-sync and apply worker options

Three worker options the runtime consumes were never set by codegen, and
each fails silently rather than loudly when absent.

`exportGlobals` is the worst of them: `export-stream.ts` guards on
`wantGlobals && exportGlobalsFunction`, so with no function the loop is
skipped, no row is written, and the response is a 200. `lunora export`,
`lunora backup create` and the scheduled R2 backup therefore emitted
shard-local rows only — while `importGlobals` WAS wired, so an
export/import round trip restored cleanly having lost every `.global()`
row. The docs describe the opposite.

`syncGlobals` and `applyGlobals` are the same shape on the admin CDC
endpoints: the sync endpoint returned shard-local changes at 200 and the
apply endpoint reported `globalApplied: 0`. `create-worker.ts` even
documents "wire it to @lunora/d1's readD1CdcChanges" — an instruction
nothing followed, which is why that reader had no production caller.

The emitted sync helper probes `sqlite_master` for `__cdc_log` and returns
an empty page when it is absent, matching `runShardCdcSync`, so an app that
has not enabled CDC reports "no changes" instead of throwing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(do): refuse resume for dependencies the changelog cannot speak for

`evaluateResume` reasoned entirely from `__cdc_log`, but the log records
shard-local table writes only. Anything else a query reads is invisible to
it, and the verdict was optimistic about all of them.

The concrete case is `.global()` tables: `onRead` stamps them into the
read-set, but `insertGlobal` and its twins write to D1 and broadcast — they
never reach `recordCdc`, so no CDC row exists for a global table from any
DO. `cdcTouchesTables` therefore answered `false` for a table that had just
changed, and the client kept a stale value until some shard-local table in
its read-set happened to move. The old `CDC_RESUME_SCAN_LIMIT` masked this
by re-snapshotting long-offline clients outright; removing that cap removed
the accidental safety net with it.

The fix is one rule rather than a case per source. `cdcCanVouchFor` defines
the vouchable set positively — a dependency is vouchable iff a table of that
name exists in this DO's SQLite, which is exactly the namespace `recordCdc`
appends for. `.global()` tables are never created locally, the flags/admin
wildcard `"*"` is not a table, and anything unrecognised falls to the same
default: cannot vouch, re-snapshot. The empty read-set becomes an instance
of the rule instead of its own branch, and the next capability added is safe
by construction rather than by remembering. The gate runs before the
at-the-high-watermark fast path, because a `.global()` write bumps no cursor
here — "already at the watermark" is precisely the state a client that
missed one arrives in.

A PITR restore reverts all of SQLite including the epoch row meant to detect
it, so the proactive bump is rolled back with the data. The one record the
restore cannot reach is the cursor each client cached, so the existing
per-client `sinceSeq > cursor` refusal now also re-mints the epoch
shard-wide: the first client to prove the rollback seals it for everyone who
reconnects later, after post-restore writes have climbed the cursor back
past their own and the per-client guard no longer fires.

That proof is client-supplied, and the epoch it must match rides on every
frame the client already holds — so any subscriber can forge it. The seal is
latched to once per wake: unbounded, each forged frame would cost a write
and invalidate every other subscriber's cached resume, turning one cheap
request into N full snapshots. One seal is all a real fork needs, so the cap
costs the genuine case nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(shard-engine): keep relayed shape subscribers recoverable

Two ways a relayed subscriber went permanently stale, both silent.

The cohort cursor advanced synchronously before a best-effort multicast
that swallows failures, so one failed POST to a relay left the frontier at
the new checkpoint while every socket on that relay still memoed the old
one. The relay gates delivery on `memo.cursor === poke.fromCursor`, so no
future poke ever matched again and those sockets sat on stale rows until
they happened to reconnect.

The owner now rewinds the frontier — in memory and durably, min-only — when
a leg fails, and the relay admits a poke whose range it has partly applied
(`memo.cursor >= fromCursor && memo.cursor < checkpoint`) instead of
demanding equality. Rewinding is safe because a shape diff is not a log
replay: `buildShapeDiff` ships each changed key's CURRENT membership and
value, so a wider range is the same answer plus redundant keys. The
synchronous advance stays, so an interleaving seed still cannot double-apply.
Recovery is now bounded by the next write rather than by a reconnect.

Second, the cohort registry and per-socket proxies were plain in-memory
Maps on the owner — and an owner in relay mode holds no sockets of its own,
so it is freely evictable between writes. After eviction the multicast
returned immediately on an empty registry and NO relayed subscriber
received anything again, for any write, until each reconnected. It also
blinded the retention floor: `minShapeCursor()` returned undefined at
exactly the moment the registry was lost, so the sweep was free to trim the
range those cohorts still needed. Both now live in
`__lunora_relay_shapes`, hydrated once per wake — one row per cohort, which
is cheaper per subscriber than the `__shape_poke_cursor` row the local path
already writes per socket. Proxy rows carry the forwarded identity, without
which a rehydrated proxy would resolve anonymously.

Reclamation stays deliberate: rows drop on relay detach and when the relay
set empties, and nothing else. A per-subscription staleness heuristic would
trade a bounded leak for a silent delete of a live subscriber's range.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(client): stop a full re-seed merging into the stale view it replaces

Four defects on the live-sync path, all silent.

A full shape re-seed was byte-identical on the wire to a delta poke, and
the client cleared its view only on a forked epoch or a diverged base — so
a seed was spliced onto whatever rows it already held. A seed emits only
inserts, so nothing the client kept could ever leave. `.global()` shapes
full-re-seed on every reconnect, and an op-log shape past retention does
too with the epoch unchanged, so both guards were inert. A row deleted
while a tab was away survived for the life of that tab. Pokes now carry a
per-shape `reset` flag, set at every full-seed site (local, global and
relayed), and a reset part clears before applying.

The delta path had none of the poke path's atomicity: `subscriptionFrames`
stamped the same cursor on every frame of a run and the client advanced on
each. A socket dying mid-run left a partly-applied value behind a fully
advanced cursor, and the next reconnect resumed on it — permanently wrong,
never re-snapshotted. The cursor now rides only the last frame of a run.

`pokeBuffers` was keyed by `pokeId` alone and is client-global, but
`pokeId` comes from a per-DO counter that also resets on eviction. Two
shards emitting `poke-1` interleaved: one applied with the other's epoch
and wiped its view, the other found no buffer and dropped its rows while
its cursor stood still. Keyed by `(connection, pokeId)` now.

`baseCheckpoint` was stamped on only one of six poke paths — the one where
a gap is least likely — so the divergence check was armed exactly where it
could not fire and disarmed on every path where a poke actually goes
missing. The live local path now stamps the last checkpoint that carried
rows, and the relayed path stamps `fromCursor`, which the delivery gate
already proves the socket holds.

Also: a cross-tab follower no longer replays a resume cursor with no value
behind it (it would resume into an empty view and hang), and a recognised
row delta that cannot merge re-subscribes for a snapshot instead of
replacing the query value with the raw delta object.

Every field is additive and optional, so a stale client or SDK against a
new server keeps today's behaviour rather than breaking; `protocol/` and
its fixtures record the new keys for the eight non-JS SDKs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(do): give staged search indexes the backfill their docs promise

`.searchIndex(..., { staged: true })` is documented as "skip the
migration-time backfill on this large table, run it out-of-band later", and
`backfillSearchIndexes` carries a docblock naming the out-of-band caller as
"a one-shot admin RPC, a migration step". No such caller existed on
Cloudflare — the only production caller anywhere was the experimental Node
host. So a staged index indexed rows written after the deploy and nothing
before it, permanently, with no supported repair. Non-staged indexes
self-heal a page per migration pass, which is why this stayed hidden.

Wired to the machinery that already exists rather than building more:
`backfillSearchIndexes` takes a page budget and reports progress, a
`backfillSearch` admin RPC drives it, and `lunora run` already forwards any
`__lunora_admin__:` path with the admin bearer — so there is no new CLI
surface. A finished index costs no budget, so a schema whose complete
indexes outnumber the budget still reaches the one that needs work.

Separately: `ctx.scheduler` threw inside every `.global()` table trigger.
`createSqlCtxDb` defaults an absent scheduler to `throwingScheduler`, and
codegen passed one to the shard writer and to neither global writer — while
the same generated object literal resolved the scheduler a few entries
below. A `defineTrigger` on a global table calling `runAfter` failed at
runtime in an app that had a scheduler configured, and nothing rejected it
at build time.

Known gap, documented rather than papered over: a staged index on a
`.global()` table is still stranded. The backfill needs a raw exec and the
DO holds only a writer, so closing it needs a new seam.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* docs(search): name the command that backfills a staged index

The page told readers to "run backfillSearchIndexes from a one-shot admin
path", which described the exact gap the previous commit closed: no such
path existed. It now names the real command, says the backfill is not
optional, and explains the page budget and its resumability — and is honest
that a `.global()` staged index still has no equivalent entry point.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(sql-store): the .global() retention sweep threw on every MySQL deployment

MySQL rejects a `LIMIT` inside an `IN (subquery)` outright — "This version of
MySQL doesn't yet support 'LIMIT & IN/ALL/ANY/SOME subquery'" — so the
bounded DELETE the sweep issues worked on SQLite and Postgres and threw on
every Hyperdrive-MySQL deployment. Materialising the bounded select through
a derived table is the one form all three accept; MySQL's own
`DELETE … ORDER BY … LIMIT` would need a dialect split, since Postgres has
no such syntax, and Postgres requires the alias so it is not optional.

The dialect split in the sweep lease had no test at all: the SQLite suite
only ever exercised `supportsReturning: true`, leaving the MySQL
affected-rows compare-and-set and its `ON DUPLICATE KEY UPDATE` seed to ship
unexecuted. Both engines now carry the sweep case against a real server —
pglite for Postgres, mysql-memory-server for MySQL — and it was the MySQL
one that found this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(sdks): honour pokePart.reset in all eight non-JS clients

A full shape (re)seed carries the shape's complete membership and is
inserts-only, so a client that splices it onto the view it already holds
keeps every row that left the shape while it was disconnected — for the life
of the client. `.global()` shapes full-reseed on every reconnect and an
op-log shape past changelog retention does too, so this is the common path,
not an edge case. The TypeScript client and the server were fixed with a
`pokePart.reset` flag; the eight ports still merged.

Each client now records the flag per shape while buffering a poke — sticky,
so a seed split across several parts still replaces — and clears that
shape's rows before applying at `pokeEnd`. Each carries a conformance case
driving `resetPokeSequence` to `resetExpectedRows` from the shared fixture,
and each was confirmed to fail without its fix.

The cursor-omission risk that came with the same server change (a delta
frame may now legitimately arrive with no `cursor`, since only the last
frame of a run carries one) turned out to be already handled in all eight:
every port narrows through a presence check into a nullable slot rather than
decoding into a primitive that would silently become 0 and drive the cursor
backwards. An existing manifest case already pins it.

The Dart suite was reporting PASS without running. Case 16 awaited
`StreamIterator.moveNext()` only after feeding the frame it consumes, but
`watch()` is a `Stream.multi` that registers on listen and a `StreamIterator`
listens on its first `moveNext` — so the frame reached no listener, the event
loop emptied, and the isolate exited 0 having run 16 of 70 cases and printed
nothing at all. The runner read that as a pass. Starting each `moveNext`
before its frame is what lets cases 17-70 run.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* test(sdks): require the reset case of every port, not just the eight that have it

`protocol/conformance-cases.json` is the list every SDK suite reads at run
time and fails against, so a name added there turns every language red until
it is covered — which is how the repo stops coverage drifting between ports.
The `reset` case was deliberately left off it while the eight fixes landed
one group at a time, since adding it early would have failed the ports that
had not been written yet.

All eight now assert it, so it becomes required. Verified the gate actually
bites by removing Go's `covers(...)` and watching the suite fail with the
missing name, rather than trusting that listing it was enough.

Rust and Swift dispatch by manifest name rather than declaring standalone
tests, so both drop the "plain test because the manifest would red the other
ports" comment along with the `#[test]` attribute — that reason has expired.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(client): an unseeded delta is not a merge failure

The unmergeable-delta guard treated "no cached base" and "a base the delta
will not splice into" as the same thing, and re-subscribed for both. The
first is the legacy `ShardDO.broadcastDelta` fan-out, which stamps no cursor
at all — its own comment says the path "has no diff baseline to protect" —
so handing the change to a subscriber that has not been seeded strands
nothing, and is what that path has always done. Collapsing the two turned
every broadcast to an unseeded subscriber into a re-subscribe, which the
workerd integration suite caught and no unit test did.

Only the second case is dangerous, and it stays guarded: wholesale
replacement there publishes the `{ key, op, table, row }` envelope over a
real query result, and a frame carrying a cursor advances it, so nothing
would ever reconcile it.

The regression got in because the fix was speculative — its author said
plainly they could not construct a path where the current server sends an
unmergeable delta. It shipped anyway and broke a demonstrable one. The new
unit test pins the distinction so the mocks suite catches it next time
rather than a real workerd.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* feat(codegen): let an app turn CDC on, and cover delta-sync in a fixture

`config.cdc` was permanently `undefined` for every `defineApp()` project —
and every template uses `defineApp()`. The builder never assigns it, no
capability row produces a `.cdc()` method, and `.extend()` merges
`WorkerOptions` rather than `ShardConfig`, so the emitted `createShardDO({…})`
call had no way to carry it.

That is wider than the `.global()` half already fixed. `runShardMigrations`
gates FIVE tables on the flag — `__cdc_log`, `__cdc_meta`,
`__client_watermark`, `__shape_poke_cursor`, `__lunora_relay_shapes` — and
`ShardDO.cdcEnabled()` probes `sqlite_master` for `__cdc_log`, which
`computeOpLogShapeSeed` requires to resume. So on the templated path even
SHARD-LOCAL shapes could never resume: every reconnect re-seeded full
membership, and custom mutators had no watermark table.

The builder gains `.cdc()`, defaulting OFF. Inferring it from
`hasShapes && hasGlobalTables` was the tempting alternative and is wrong:
one flag governs both changelogs, so a project declaring only a `.global()`
shape would silently start paying a changelog row on every shard write too.

The reason this survived a PR, two reviews and an audit is that nothing
exercised it: no example or fixture declared a shape, none set `cdc`, and
the codegen suite asserts substrings of emitted text without ever compiling
it. The new `delta-sync` fixture declares both a shard-local and a
`.global()` shape, commits its generated output, and is imported by its test
so `tsc` pulls the emitted `shard.ts` into the program and actually compiles
it. Verified by breaking the golden's types on purpose and watching tsc fail.

Verified the fixture earns its place: reverting the cdc threading fails
three tests naming exactly that change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* perf(shard-engine): memoize the table catalog the resume vouch reads

`cdcCanVouchFor` scanned `sqlite_master` on every resume evaluation, and that
question is asked on the hot path the two-stage read exists to keep flat.
Measured against a stubbed baseline on the `cdc-resume-probe` bench: 25.9k hz
with the scan against 31.5k without, so it cost ~18% of `evaluateResume` —
which is what CodSpeed flagged.

The catalog moves only when a migration runs, so it is memoized per `sql`
handle. That restores the baseline exactly (31.4k) with the correctness
intact.

Only POSITIVE answers are cached. A dep the memo does not know re-reads the
catalog once and retries, so a table created by a later migration is picked
up rather than refused forever — a stale negative would silently deny every
resume for it, which nothing else would notice. The reverse case, a table
dropped after being cached, would leave a stale vouch, but a query whose
dependency no longer exists cannot read it, so no live subscription can hold
one. The re-read path has its own test, confirmed to fail against a naive
cache.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(do): refuse resume for a query that read outside the changelog

`cdcCanVouchFor` can only judge dependencies that reach the read-set, and
`ctx.kv`, `ctx.storage`, `ctx.vectors`, `ctx.db.system` and `ctx.flags`
stamped nothing at all. So a query reading a local table AND one of them
arrived with a fully-vouchable read-set and resumed clean while the external
value had moved — the same silent-stale class as the `.global()` case, just
through a door the rule could not see.

Those reads now stamp `UNVOUCHABLE_DEP`, so the existing rule does the work
rather than a second mechanism appearing.

Stamped on CALL, not property access: `createShardCtxDb` probes
`typeof scheduler.list === "function"` while building the ctx, so an eager
`get` trap would mark every query in a scheduler-enabled app unresumable
before a handler read anything.

Deliberately NOT stamped, each for a reason: `ctx.storage.getUrl` /
`getSignedUrl` are pure URL construction with no I/O — and they are what real
handlers call, so stamping them would have made the common storage query
never-resumable for nothing; `ctx.secrets` cannot legitimately move a
subscriber's result; `ctx.analytics` / `ctx.notify` are write-only;
`ctx.env` is static; the action-only surfaces are never subscription-cached.

The sentinel is deliberately NOT `ADMIN_WILDCARD`. That value carries a
second meaning — `writeTouchesMemo` short-circuits on it, re-running the
query on every write-flush — so reusing it would have added a permanent
per-write tax. A distinct name can never appear in a written-table set, so
the live refresh path is bit-for-bit unchanged and a query that read KV
still re-runs exactly when one of its real tables moves.

It also must not escape: the delta frame picked its `table` from the
insertion-ordered read-set, so a query touching KV first would have put the
sentinel on the wire for every client and all eight SDK ports. The frame now
picks the first real dependency.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* test(do): pin the relay registry against real workerd eviction

The relay fixes were verified with a `RelayHost` double over `node:sqlite`,
with eviction simulated by constructing a second `OwnerRelay` over the same
storage. That is faithful to the mechanism but not to the transition, and
the registry-loss defect IS the transition: an owner in relay mode holds no
sockets of its own, so it is freely evictable between writes, and the
in-memory Maps went with it.

Two tests now drive `evictDurableObject` against a real owner+relay pair: a
relayed cohort still receives its poke after the owner is evicted, and
`minShapeCursor()` still reports a real floor rather than `undefined` — the
input `ShardDO.retentionFloor` folds in, so losing it lets the changelog
sweep trim the range those cohorts still need. Confirmed failing without the
hydration: `expected undefined to be 1` is the floor literally gone.

The floor is read through a test-only accessor rather than by driving the
sweep, which sits behind two env knobs and a 60s interval — a sweep-driven
test would prove the sweep works, not that the floor exists.

Deliberately NOT covered, and stated rather than faked: the failed-multicast
leg. `requestRelayMessage` yields one on exactly three conditions, and each
is closed under workerd — an unresolvable binding fails every leg and is
already caught by `canAddressSiblings()`, a same-namespace DO fetch throws
only on an uncaught callee exception with no fault injection available, and
every well-formed relay poke answers 204. Probed empirically rather than
read: a poke to a never-announced relay index, and one to an owner-role DO,
both return 204. So the rewind path stays covered by the double alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(sdks): bound the pending poke buffers, and say why pokeId needs no scoping

Went looking for the `(connection, pokeId)` requirement `protocol/README.md`
§5.3 imposes and found the eight ports already satisfy it by construction:
every one holds exactly one socket (`attach_socket` REPLACES the sender, no
`handleFrame` carries connection identity), and the frames carry no shard
identity to key on anyway. Two connections means two client instances with
their own buffers, so the collision is unreachable everywhere.

Adding a synthetic key would have fixed a tenth of an already-broken
configuration — routing two sockets into one client also orphans the first at
the second attach, and `resendSubscriptions` then sends every shard's
subscriptions down whichever attached last — while implying multi-socket
support that does not exist. Recorded in the SDK capability matrix instead,
and §5.3 now says the requirement binds a multiplexing client rather than
reading as blanket.

The reachable half of the same paragraph WAS failing. "A socket that drops
mid-poke discards the buffer" — but a buffer is released only at `pokeEnd`,
and an abandoned poke never sends one, so seven of eight accumulated buffers
for the client's lifetime: one per reconnect, unbounded against a peer that
opens pokes it never closes. Rust alone had a cap; the TS client caps at 256.
Classic manifest drift — one port hardened, seven not, every gate green.

It is worse than a leak. `pokeId` resets on DO eviction, so a stale buffer
can be reached by a later poke's `pokeEnd` and APPLY ITS ROWS. Confirmed by
deleting the eviction in the Python port: the ghost row reaches the view.

Rust's oldest-first eviction ported to the other seven. Go and Swift needed
an explicit order list, their maps being unordered, and prune it at `pokeEnd`.
Enforced fleet-wide by `pending_poke_buffers_are_bounded` in the manifest,
asserted black-box in all eight since an evicted buffer is indistinguishable
from one never opened. Gate confirmed to bite on both mechanisms — the
`covers()` call and the dispatcher arm.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* fix(do): keep the relay binding through an empty header and a cold alarm wake

Two ways `shardBinding` went missing, both taking the whole relay tier
silently dark — `siblingStub` resolves nothing, `canAddressSiblings()` is
false, and `onFlush` returns before the multicast.

An EMPTY header overwrote a known binding. A sibling POST stamps
`shardBinding() ?? ""`, so a peer that does not yet know its own binding
sends the empty string — and `headers.get` returns `""` rather than `null`,
so the `??` on the receiving side treated it as a value. `siblingStub` then
resolved `env[""]` to nothing, and the tier stayed dark until some later
request happened to carry a real value. Now an empty header is "not
supplied". The test asserts a relay detach still reaches its owner after one
arrives; without the fix it goes nowhere.

The binding also did not survive an alarm-only wake. An owner in relay mode
holds no sockets of its own, so it is evicted freely, and the TTL sweep and
external-source poll both end in `flushChangedTables` → `onFlush`. An alarm
carries no request, so the per-request binding is gone. No rows are lost —
the cohort cursor never advances, so the next flush that can address
siblings covers the widened range and `buildShapeDiff` ships current values
— but a shard whose subscribers all sit on relays and whose data changes
only on a timer generates no relay→owner traffic to re-supply it, so "until
the next request" can mean indefinitely. The owner now records the binding
when it learns one and reads it back at most once per wake.

The read deliberately does not create its table first: it sits behind the
`canAddressSiblings` guard that exists to keep a single-DO shard's flush off
SQLite entirely, so a missing table just means "nothing recorded".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* feat(advisor): warn when a query branches on a flag it cannot be invalidated by

Completes the flags decision. `ctx.flags` reads no longer force a
re-snapshot on reconnect — that converged only the reconnect moment while
leaving the query stale for as long as the client stayed connected, paying a
permanent cost for half the property.

Flags are an input the invalidation system does not model: flipping one
appends nothing to `__cdc_log`, so it re-runs no live subscription either.
The reactive path already exists and is correct — a `useFlag` subscription is
tagged `ADMIN_WILDCARD` and re-evaluated on every write-flush. Branching on a
flag inside a cached query is a point-in-time evaluation, and the right
answer is to say so, which is exactly how this repo already handles
`Date.now()` in a query.

WARN rather than the precedent's INFO half: that half exists because a
mutation genuinely has no hazard, running once. Here the hazard is real and
its failure mode is silence — a stale flag branch is indistinguishable from
a correct one client-side, and INFO is filtered out of most surfaces. It also
cannot flood a codebase the way the mutation half did: queries only, and only
on an explicit `ctx.flags` touch.

Known limit, pinned by its own test rather than left implicit: a destructured
receiver (`const { flags } = ctx`) is not detected. That matches
`receiverNameOf`, which misses `const { random } = Math` identically —
following the binding needs the type checker and would make this one lint
behave unlike its siblings.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JF7rdHhB5w99j85dT3sy3a

* test(codegen): recapture the delta-sync goldens after the rebase

The committed `lunora/_generated` goldens predate alpha's emitter work, so
the snapshot test failed once this branch was rebased onto it — the emitted
output now carries alpha's `lifecycle` hook manifest and prototype guard as
well as this branch's search-backfill override.

Regenerated with the repo's own `__tests__/capture-expected.ts` rather than
hand-merged, since the goldens are emitter output by definition. Codegen is
green again at 1343 tests.

* fix(shard-engine): close the delta-sync review findings

**The relay registry stored identity outside the wire codec.** `args` round-trip
through `encodeWire`/`decodeWire` because a value can be a `bigint`, `Date` or
`Uint8Array`; `identity` went through bare JSON on both legs. A `bigint` claim
therefore threw on the seed path, and — the quieter half — a `Date` claim came
back a string, so a rehydrated shape resolved RLS under a claim of a different
type than the live registry used. Not an error, a different answer. Both legs now
use the codec; two regression tests cover the throw and the silent retype, and
both fail against the previous code. The table is new in this branch, so there is
nothing stored to migrate.

**The membership cache did not collapse concurrent reads.** `rows()` awaited
`load()` before publishing its entry, so every caller arriving in that window
started its own backend read — the exact fan-out the cache exists to prevent, and
it inflated `readCount` while doing it. It now caches the in-flight promise and
drops the entry if the read rejects, so a failure is retried next tick rather
than served for the object's life.

**The schema-less backfill hook threw an internal code.** `INTERNAL` is
catalogued `internal`, so `errorToResponse` replaced "this shard was built
without a generated schema" with "internal error" and the caller got a bare 501.
`NOT_IMPLEMENTED` carries the same status and keeps the reason.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

* test(shard-engine): use the real SubscriptionIdentity shape

The round-trip test put claims at the top level, but `SubscriptionIdentity` is
`{ identity?: Record<string, unknown>; userId?: string }` — the claims live in
the nested `identity`, which is what the review's `Record<string, unknown>` note
was pointing at. `lint:types` failed with TS2353 on the invented keys.

Nesting them exercises the same defect: `JSON.stringify` still throws on a
nested bigint, and a nested `Date` still round-trips to a string. Re-verified
against `HEAD~1` — both cases fail there and pass with the codec fix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

* chore(shard-engine): refresh the api snapshot after the rebase

The rebase onto alpha left the committed snapshot behind this branch's own
surface, so `Lint (api surface)` failed. Regenerated off a fresh build.

Everything in the diff is this branch's work: the new delta-sync exports
(`GlobalPollTick`, `ShapeDiffCache`, `CdcChangeKey`, `ShapeProbeCounters`,
`ReadShapeCdcKeys`, `CDC_LOG_TABLE_SEQ_INDEX`, `SearchBackfillProgress`) plus
three signature changes its commits already describe — `backfillSearchIndexes`
takes `maxPages` and reports progress, `trimCdcChanges` takes the retention
bound, and `selectShapeMemberIds` became `selectShapeMembers` returning each
surviving row's document from the same SELECT that tests membership. No export
was dropped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

* fix(shard-engine): correct the review fixes the audit found overclaimed

A thermo pass over yesterday's three fixes found the code correct but two of
them justified by comments that are wrong about the call graph. Both reviewers
converged on the same three items independently.

**The single-flight cache guarded a race the design forbids.** `rows()` grew a
promise-publish-before-await, a try/catch and a rethrow to collapse concurrent
callers. There are none, and there deliberately cannot be: `tick.rows` has one
call site, reached through two serial loops that both carry `no-await-in-loop`
disables saying concurrency there is unwanted, and the tick is discarded at the
end of each poll. The catch's claim that a cached rejection would persist "for
the rest of the object's life" was wrong for the same reason. Simplified to the
five-line form, and the docblock now says what is true — the map holds the
in-flight promise so an entry exists from the moment a read starts, which keeps
serialization a property of the caller rather than a requirement here. Failure
recovery stays with `requestResync()`, which already owns it.

**The identity codec claim was overstated.** Routing `identity` through the wire
codec is right for consistency, but the authorization divergence the previous
message described cannot occur: claims reach a shard only through the
`x-lunora-identity` header, which is itself `JSON.stringify`d, so a bigint claim
already throws at the worker and a `Date` is already a string. The transport
half is also still asymmetric — `seedRelayShape` encodes `args` across the
relay→owner hop and forwards `identity` raw. The docblock now records both
facts. Closing the hop is a wire-format change on the relay path and is
deliberately not done here.

Both columns now go through a named `encodeColumn`/`decodeColumn` pair, mirroring
`encodeDocJson`/`decodeDocJson` in `do-sql.ts`, so the halves cannot drift apart
the way they already did once.

**The tests pinned the wrong row shape.** Both seeded cohort rows, which
`OwnerRelay.relayShapes` hydrates while discarding identity entirely. Only a
proxy row carries it, so both cases now set `relayIndex`/`connectionId`, and one
asserts that addressing survives the round trip.

Also from the audit: the `flagsClient` alias the rebase left behind is gone (it
existed only while it was wrapped, and that wrapping was reversed), its 18-line
rationale moved out of the emitted template into the emitter's docblock so it
stops shipping into every generated app, the `no-secrets` suppression now wraps
the whole function instead of sitting between two object properties,
`read-footprint.ts` no longer lists `ctx.flags` among the stamped reads, the
redundant `{ status: 501 }` on a catalog code that already carries it is dropped,
and the protocol table's `delta` row documents the `lastMutationId` that rides
every frame.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

* fix(shard-engine): close the relay-shape seed and probe review findings

Three defects and four hardenings from the outstanding review notes on the
delta-sync read path.

A relayed shape seed reported its checkpoint at the op-log cursor it was
computed at while memoing the socket at the cohort frontier. Any joiner to a
cohort whose frontier already lagged — which an unrelated write is enough to
cause — was therefore told a base the next multicast poke would not stamp, so
its very first poke failed the client's divergence check and re-seeded it. The
seed now reports the frontier it memos; the poke stamps the socket's own memo
rather than the range's opening cursor, which the admission rule (a range, not
an equality) allows to differ.

A non-uniform relay shape whose subscribe carried no connection id registered
no proxy and wrote no row, but still returned seed frames. The subscriber
rendered one snapshot and was never poked again for the life of the socket,
with nothing logged. It is now refused with RELAY_SHAPE_UNROUTABLE.

`cdcTouchesTables` bound one parameter per table in the read-set, and the
read-set is however many tables one query happened to read. Past workerd's
100-parameter statement cap the resume probe threw instead of answering. It is
chunked now.

Also: the search backfill decided its page budget after walking the page, so a
call arriving with nothing left wrote 500 more rows than the caller asked for;
the shared per-flush scan and membership map are typed read-only, since every
subscriber of a shape in one flush is handed the same objects; the changed-key
read no longer aliases `MAX(seq)` to the column it aggregates; and the backfill
docs name the `.global()` twin, which the shard-local entry point silently
skips.

* test(codegen): recapture the delta-sync golden after the rebase

The base branch added a `head` method to the no-storage `ctx.storage` stub;
the fixture this branch introduced predates it.

* fix(do): close the delta-sync audit findings

Two silent data-divergence paths, one inert feature, and the maintainability
findings from the same audit round.

**A shape over a quiet table pinned the whole retention floor.** A shape whose
table saw no write in a flush was skipped without advancing its cursor, and
`retentionFloor` is a MIN over every recorded cursor — so one subscriber to a
quiet table held the log's floor at its seed cursor indefinitely, and an
operator who set `LUNORA_CDC_LOG_RETENTION` watched the log keep growing with no
error, no metric, and nothing to grep. Such a shape now advances anyway: its
diff over that range is empty without reading the log. The relay tier cannot do
the same — advancing a cohort cursor with no delivered poke puts every relay
socket below the next poke's base and freezes them — so that ceiling is written
down at the floor computation instead.

**The `.global()` PITR applier and bulk importer wrote with CDC off.** Restored
rows reached the tables and nothing else: a warehouse connector's cursor walked
past a range with no entries and its mirror diverged from the database with
nothing on either side able to notice. Both writers now carry the app's own
`cdc` setting.

**A shard-local shape with CDC off seeded once and then never updated.** The
seed reads the table, not the log, so it succeeded; every later diff threw `no
such table` into a per-shape catch and the client rendered one snapshot and went
silent for the life of the socket, reported only on a counter. The subscribe is
now refused with `SHAPE_REQUIRES_CDC`, naming the switch. The playground shipped
in exactly this state and is fixed.

Also: the unvouchable-read sentinel no longer reaches the Studio's reactor
watched-table list; `backfillSearch` rejects a malformed `maxPages` instead of
reading it as "no cap"; the retained-floor predicate and its refusal are stated
once rather than six times across three packages; the two `CDC_SWEEP_MAX_ROWS`
constants no longer share a name at different values; `.global()` poll counters
get their own type, since they are not membership probes and were rendered
through the same component; the instrumented `sql` getter returns one handle per
dispatch, which is what the resume path's table-catalog memo was keyed on; and
the `sealForkedTimeline` threat model no longer understates what a forged frame
buys.

### Performance Improvements

* **do:** rebuild the delta-sync read path — metadata scan, hydrate last ([#432](https://github.com/anolilab/lunora/issues/432)) ([f98847d](https://github.com/anolilab/lunora/commit/f98847df4605b3e20b51c13904411138f434a9bc))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/bindings:** upgraded to 1.0.0-alpha.38

## @lunora/shard-engine [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.36...@lunora/shard-engine@1.0.0-alpha.37) (2026-08-25)

### ⚠ BREAKING CHANGES

* authorizeShard takes a single ShardCaller object
({ identity, shardKey }) instead of two positional arguments. Both
previously-natural shapes now fail to compile, which is deliberate -- an
optional argument would have documented the trap while leaving every
un-updated gate silently breaking cron dispatch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(examples): update authorizeShard call sites

team-chat's gate no longer type-checks against the ShardCaller object.
The remaining changes are code samples and comments that would otherwise
teach the positional shape that no longer exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(studio): mask the global data browser

The .global() browser had no mask preview at all: a table carrying a
.use(mask(...)) policy rendered in cleartext, with no toggle and no
header chips, while the sharded browser honoured the same policy on every
surface.

The policy metadata was reachable all along -- maskPolicies is
schema-wide rather than shard-scoped, and a .global() table's declared
field names join against it identically.

Covers the grid cells, header chips, the toggle, the facet sidebar, and
the drill-down filter chips. That last one is the non-obvious surface:
facet a covered column with the preview off, click a value, toggle back
on, and the chip still held the secret.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* build(api): pin re-exports to one printed signature

A subpath re-exporting another subpath's declaration printed the whole
signature again, so auth-ui's six framework ports each re-printed core's
271 declarations and the snapshot reached 39,299 lines -- a real surface
change was unreviewable inside it.

A declaration now prints in full once, under the subpath whose entry
directory contains it, and every other subpath records a pin naming where
the signature is tracked. Keyed by declaration identity rather than name,
so two subpaths exporting the same name from different files stay two
sections. The same rule the script already applied across packages, now
applied within one.

Coverage is unchanged: every export is still recorded per subpath, so
losing a re-export still fails for that port by name. auth-ui drops to
16,691 lines.

Also fixes the drift reporter, which keyed sections by bare export name:
in a multi-subpath snapshot the last section overwrote the others, so a
real signature change could summarise as no change. The gate always
compared whole files, so this affected the message, not the verdict.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* test(runtime): format and annotate the fixture bearer

The scheduler-dispatch test's authorization header trips the secret
scanner's kingfisher.http.2 rule; it is a fixture matching the stub admin
token asserted a few lines below, so it carries an inline allow naming
what it is rather than a baseline entry.

Both files also went in unformatted -- they predate the pre-commit hooks
being wired up, which is what would otherwise have caught this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(examples): regenerate every stale _generated tree

All 13 examples carried generated output predating a codegen change --
the lifecycle field on RegisteredLunoraFunction, runShardInit/runReactor
dispatch, the inTransaction predicate and the untracked ctx.runQuery
path. 26 files, and nothing had ever noticed.

Output is deterministic (two consecutive sweeps produced byte-identical
diffs) and every regenerated tree typechecks clean.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* build: gate lunora codegen output

check-generated-files.mjs proved three generators reproduce their
committed output and did not cover lunora codegen -- the repo's primary
generator -- so every _generated tree under examples/ drifted unwatched.
All 13 were stale.

The generator list now discovers an entry per example with a codegen
script, so a new example is covered as soon as it has one. Templates are
not gated because they commit no generated output at all: every one of
the 13 lists lunora/_generated in its .gitignore, so there is nothing to
hold to a generator.

The job gains the build the sweep needs, matching what the api-surface
job already pays.

The gate was also not triggering: the generated_files filter matched
manifests and generate-*.js, so a change to packages/codegen/src/emit.ts
-- the exact thing that caused this drift -- matched nothing and the job
never ran. The filter now covers packages/codegen, examples, and the
script itself.

Known limitation, unchanged and now documented: the script compares git
status codes rather than content, so drift inside a file that was already
dirty before the sweep is invisible. Harmless in CI, which starts clean;
it means a local run mid-change cannot detect drift in files you have
already modified.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* docs(studio): record why filter rows stay unmasked

The question of whether the sharded browser's filter bar should mask has
now been asked twice and answered from memory both times. The answer is
no, and the reason is an invariant rather than a preference: a filter
clause rendered in that bar is always simultaneously rendered verbatim in
the address bar, because useDataBrowser mirrors toFilterClauses through
onViewChange into ?filters=. Masking a row would blank a value legible
three inches above it while making the input uneditable.

That is what separates it from the .global() drill-down chips, which are
masked: those are read-only, fed only by a facet click, and held in local
state that never reaches the URL. The two data-derived paths into a
sharded filter are already closed at the source -- a facet click cannot
reach a covered column while the preview is on, and FK traversal seeds
search rather than filters.

Two tests now pin the halves the rationale rests on, so it fails loudly
rather than rotting into a stale comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(sdk): chain the dart generated-check analysis

A `\` continuation followed by a comment terminates the command, so the
prose spliced mid-chain detached everything after it: the analysis ran
unchained from the `cp` that stages the smoke, in a script that runs
without `set -e`.

That is the hole the chain was added to close, still open on the one leg
this script exists to gate. The comment moves above the case label, with a
note saying why it cannot live inside the chain. No other shell file in
the repo has the pattern.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(shared): one fnv1a, not four

`shared/fnv1a.ts` argues in its own header that a shared definition is
what enforces non-drift. Four definitions existed, one of them
`shared/content-digest.ts` in the same directory, and
`notify`'s carried a comment requiring it to reproduce the algorithm
byte-for-byte or delete the wrong subscription row -- a hand-maintained
contract against a function it did not import.

Equivalence was proven before consolidating, across 4,016 inputs
including astral characters and lone surrogates, because a digest change
here picks which row gets deleted. The offset is now a parameter so
`contentDigest` can run its second pass through the same function.

`@lunora/client`'s `hashToken` is deliberately NOT folded in: it uses
`charCodeAt` and combines FNV with djb2, so it is a different digest.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(studio): share the toolbar button classes

Five copies across the data feature, several commenting themselves
"shared", two already differing in class order. A theme tweak had to land
in five files.

Two exports rather than one, because three of the five carried
`aria-pressed:` styling and two did not. The pressed classes are inert
without the attribute so a single constant would render identically --
but which buttons are toggles is the thing a reader needs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(codegen): let tsc classify the capabilities

The gate map was `Partial`, with the unmapped keys repeated in a second
list and a test asserting the two partitioned `CapabilityKey`. The map is
now total and credential-based is spelled `null`, so an unclassified
capability fails `tsc` where it is written instead of a test at CI time
-- verified by deleting an entry and reading TS2741.

The surviving test covers what the type cannot: `CAPABILITIES` is a
runtime array, so a row added there without widening `CapabilityKey`
would still leave a real capability out of the map. That is the fail-open
`notify` had.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(runtime): throw the typed error on a denied voice shard

The voice upgrade returned a bare 403 `Response` where every other shard
path throws `FORBIDDEN_SHARD`, so a denied caller there got a status with
no error code to branch on.

Deliberately NOT collapsed into `assertShardAuthorized`, despite reading
like a copy of it: that helper default-denies only a NON-default shard,
and there is no default voice shard, so routing through it would admit a
caller who names the default shard as their threadKey. The difference now
says so in a comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(studio): mask the foreign-key hover preview

Hovering an FK cell fetched the TARGET row and rendered its first eight
fields verbatim. The grid's mask view covers the browsed table and says
nothing about another table's columns, so a target's covered columns
showed in the clear in a tooltip beside a grid masking exactly those.

The policies are deployment-wide, so the target resolves without another
fetch. The test uses a column the NAME HEURISTIC cannot catch: the first
version used `apiKey`, which the heuristic masks whichever table is
looked up, so it passed against the unfixed code and proved nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* docs: fix an authorizeShard that 403s the default shard

`assertShardAuthorized` runs the callback for EVERY shard the caller
names once one is configured -- the non-default test is in the `else`,
reached only when there is no callback. So `identity?.userId === shardKey`
rejects the default shard, which is where an unsharded table lives, and an
app copying the snippet 403s every unsharded RPC it has.

The snippets are corrected across the concept docs, the scaling tutorial
and the template comments, and the package's own docs already recommended
the safe form -- the two contradicted each other on lines this branch had
just touched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* ci: self-list lint.yml in the generated_files filter

The job's workflow now carries the `build:packages` step the codegen
sweep cannot run without. A PR editing only `lint.yml` to drop it matched
`frontend_lintable` -- so eslint ran -- but not `generated_files`, so the
generated-files job was skipped and its required check stayed green while
the guard it protects was removed. The file's own header states this
self-listing rule; four other filters already follow it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* test: pin the AI filter grounding and drop two tautologies

The studio's rationale for leaving filter rows unmasked cited
generateFilter sending column names only, in a comment about another
package with nothing checking it. Now asserted subtractively -- everything
the caller supplied is removed from the serialised payload and the residue
must contain no user data -- rather than as a not.toContain of a value the
test never supplied, which would pass whatever the code did.

Also: a bigint equality assertion that called one pure function twice with
the same argument, and an admin-function count pinned at 50 that would
fail the day someone legitimately adds one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* style(studio): format useMaskView

An eslint --fix arrow-body-style rewrite landed after the file was
formatted, and the version restored from a mutation-test backup captured
that state -- so the concise body became a block body Prettier had never
seen. CI's `prettier --check .` caught it.

This is the ordering CLAUDE.md warns about, in reverse: Prettier must run
BEFORE eslint --fix, and anything restored from a backup afterwards needs
the check re-run against it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

### Bug Fixes

* restore guards and gates that passed silently ([#478](https://github.com/anolilab/lunora/issues/478)) ([62af245](https://github.com/anolilab/lunora/commit/62af2456030c28cba83814e410a9dc2ea1d3e580))


### Dependencies

* **@lunora/bindings:** upgraded to 1.0.0-alpha.37

## @lunora/shard-engine [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.35...@lunora/shard-engine@1.0.0-alpha.36) (2026-08-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.17
* **@lunora/bindings:** upgraded to 1.0.0-alpha.36

## @lunora/shard-engine [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.34...@lunora/shard-engine@1.0.0-alpha.35) (2026-08-25)

### Bug Fixes

* **shard-engine:** stamp stream generations ([#462](https://github.com/anolilab/lunora/issues/462)) ([b67de3c](https://github.com/anolilab/lunora/commit/b67de3c27d473aa7094bc4629b40db4af92070ad))

## @lunora/shard-engine [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.33...@lunora/shard-engine@1.0.0-alpha.34) (2026-08-23)

### Features

* **server:** close all four Convex primitive gaps — _commitSeq, untracked runQuery, .memory() + onShardInit, onQueryChange reactors ([#469](https://github.com/anolilab/lunora/issues/469)) ([75b0187](https://github.com/anolilab/lunora/commit/75b01872c06ae32f0174d2cc8385e78e373d9693))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.15
* **@lunora/bindings:** upgraded to 1.0.0-alpha.33

## @lunora/shard-engine [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.32...@lunora/shard-engine@1.0.0-alpha.33) (2026-08-21)

### ⚠ BREAKING CHANGES

* **search-core:** an exact-boundary page request
(offset + numItems === 1024) now throws BAD_REQUEST instead of
returning a final page. A ≤1024-match corpus paged right up to the cap
previously got a correct last page; it now gets the same refusal every
other cap-reaching request already got, because without the probe row
the page cannot answer hasMore truthfully. The test that asserted the
boundary page succeeded encoded the bug and now expects the throw;
consumer test regexes tracking the error message were updated to match.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* chore(search-core): align manifest with sibling conventions

Pin @lunora/errors to 1.0.0-alpha.22 like every sibling in the
platform/runtime cluster (runtime, do, shard-engine, d1, sql-store),
so the pin moves with the release tooling instead of floating on
workspace:*. Add the fallow:audit / fallow:dead-code / fallow:health
scripts and the fallow devDependency so the package joins the repo's
dead-code and health gates, and add @vitest/coverage-v8 so the
already-declared test:coverage script can actually run.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(search-core): reject non-finite page sizes

Math.floor(NaN) is NaN and NaN >= MAX_SEARCH_SCAN is false, so a NaN
numItems slid past both the normalization and the cap guard and came
back as a bogus empty terminal page instead of an error. planSearchPage
now refuses any non-finite numItems with the same BAD_REQUEST family
before normalizing; the cap boundary behavior is unchanged for finite
input. Adds a NaN regression test beside the boundary cases.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(search-core): keep the errors dep on workspace:*

The exact-version pins on intra-repo dependencies work because
multi-semantic-release rewrites them on every release — as
pnpm-workspace.yaml documents. @lunora/search-core is private with no
.releaserc.json, so nothing rewrites its manifest: an exact pin
resolves locally only while packages/errors happens to sit at that
version, and the next @lunora/errors release would put the local
package outside the range, make preferWorkspacePackages inert, and
resolve the registry tarball instead — which then gets inlined into
@lunora/server, @lunora/do and @lunora/sql-store, all of which bundle
this package. The lockfile records `specifier: workspace:*` either way,
so CI would not catch the flip. Private packages stay on workspace:*,
as @lunora/auth-ui already does.

Also make the scan-cap refusal actionable: the error now names the
largest numItems that would still leave room for the probe row, since a
power-of-two page walk lands its final page exactly on the cap and the
caller otherwise has to guess. Two comments describing the old
report-isDone-at-the-cap behaviour are corrected to match.
* **search-core:** a search page ending exactly on the 1024-document scan
cap now throws BAD_REQUEST instead of returning a final page. This hits
the last page of any walk whose sizes divide the cap — numItems 512 at
offset 512, 256 at 768, 128 at 896, 64 at 960, 32 at 992, and so on.
Such a page cannot fetch the probe row that distinguishes "exactly this
many matches" from "far more", so its isDone was a guess reported as
fact; the error now names the page size to retry with.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

### Bug Fixes

* **search-core:** refuse the capped boundary page ([#464](https://github.com/anolilab/lunora/issues/464)) ([86bfa63](https://github.com/anolilab/lunora/commit/86bfa631be8d7eabe4399b138b44dc85bf1026d6))

## @lunora/shard-engine [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.31...%40lunora%2Fshard-engine%401.0.0-alpha.32) (2026-08-19)

## @lunora/shard-engine [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.30...%40lunora%2Fshard-engine%401.0.0-alpha.31) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.14
* **@lunora/bindings:** upgraded to 1.0.0-alpha.32

## @lunora/shard-engine [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.29...%40lunora%2Fshard-engine%401.0.0-alpha.30) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.13
* **@lunora/bindings:** upgraded to 1.0.0-alpha.31

## @lunora/shard-engine [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.28...%40lunora%2Fshard-engine%401.0.0-alpha.29) (2026-08-15)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.12
* **@lunora/bindings:** upgraded to 1.0.0-alpha.30

## @lunora/shard-engine [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.27...%40lunora%2Fshard-engine%401.0.0-alpha.28) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11
* **@lunora/bindings:** upgraded to 1.0.0-alpha.29

## @lunora/shard-engine [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.26...%40lunora%2Fshard-engine%401.0.0-alpha.27) (2026-08-11)

## @lunora/shard-engine [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.25...%40lunora%2Fshard-engine%401.0.0-alpha.26) (2026-08-11)

## @lunora/shard-engine [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.24...%40lunora%2Fshard-engine%401.0.0-alpha.25) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10
* **@lunora/bindings:** upgraded to 1.0.0-alpha.28

## @lunora/shard-engine [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.23...%40lunora%2Fshard-engine%401.0.0-alpha.24) (2026-08-10)

## @lunora/shard-engine [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.22...%40lunora%2Fshard-engine%401.0.0-alpha.23) (2026-08-10)

## @lunora/shard-engine [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.21...%40lunora%2Fshard-engine%401.0.0-alpha.22) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20
* **@lunora/bindings:** upgraded to 1.0.0-alpha.27

## @lunora/shard-engine [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.20...%40lunora%2Fshard-engine%401.0.0-alpha.21) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19
* **@lunora/platform:** upgraded to 1.0.0-alpha.9
* **@lunora/bindings:** upgraded to 1.0.0-alpha.26

## @lunora/shard-engine [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.19...%40lunora%2Fshard-engine%401.0.0-alpha.20) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/bindings:** upgraded to 1.0.0-alpha.25

## @lunora/shard-engine [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.18...%40lunora%2Fshard-engine%401.0.0-alpha.19) (2026-08-09)

## @lunora/shard-engine [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.17...%40lunora%2Fshard-engine%401.0.0-alpha.18) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8
* **@lunora/bindings:** upgraded to 1.0.0-alpha.24

## @lunora/shard-engine [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.16...%40lunora%2Fshard-engine%401.0.0-alpha.17) (2026-08-08)

## @lunora/shard-engine [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.15...%40lunora%2Fshard-engine%401.0.0-alpha.16) (2026-08-07)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.7
* **@lunora/bindings:** upgraded to 1.0.0-alpha.23

## @lunora/shard-engine [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.14...%40lunora%2Fshard-engine%401.0.0-alpha.15) (2026-08-07)

## @lunora/shard-engine [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.13...%40lunora%2Fshard-engine%401.0.0-alpha.14) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/bindings:** upgraded to 1.0.0-alpha.22

## @lunora/shard-engine [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.12...%40lunora%2Fshard-engine%401.0.0-alpha.13) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/bindings:** upgraded to 1.0.0-alpha.21

## @lunora/shard-engine [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.11...%40lunora%2Fshard-engine%401.0.0-alpha.12) (2026-08-04)

## @lunora/shard-engine [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.10...%40lunora%2Fshard-engine%401.0.0-alpha.11) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/platform:** upgraded to 1.0.0-alpha.6
* **@lunora/bindings:** upgraded to 1.0.0-alpha.20

## @lunora/shard-engine [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.9...%40lunora%2Fshard-engine%401.0.0-alpha.10) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/platform:** upgraded to 1.0.0-alpha.5
* **@lunora/bindings:** upgraded to 1.0.0-alpha.19

## @lunora/shard-engine [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.8...%40lunora%2Fshard-engine%401.0.0-alpha.9) (2026-08-04)

## @lunora/shard-engine [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.7...%40lunora%2Fshard-engine%401.0.0-alpha.8) (2026-08-03)

## @lunora/shard-engine [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.6...%40lunora%2Fshard-engine%401.0.0-alpha.7) (2026-08-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.4
* **@lunora/bindings:** upgraded to 1.0.0-alpha.18

## @lunora/shard-engine [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.5...%40lunora%2Fshard-engine%401.0.0-alpha.6) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12
* **@lunora/platform:** upgraded to 1.0.0-alpha.3
* **@lunora/bindings:** upgraded to 1.0.0-alpha.17

## @lunora/shard-engine [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.4...%40lunora%2Fshard-engine%401.0.0-alpha.5) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11
* **@lunora/platform:** upgraded to 1.0.0-alpha.2
* **@lunora/bindings:** upgraded to 1.0.0-alpha.16

## @lunora/shard-engine [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.3...%40lunora%2Fshard-engine%401.0.0-alpha.4) (2026-07-31)

## @lunora/shard-engine [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.2...%40lunora%2Fshard-engine%401.0.0-alpha.3) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/bindings:** upgraded to 1.0.0-alpha.15

## @lunora/shard-engine [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.1...%40lunora%2Fshard-engine%401.0.0-alpha.2) (2026-07-31)

## @lunora/shard-engine 1.0.0-alpha.1 (2026-07-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.1
* **@lunora/bindings:** upgraded to 1.0.0-alpha.14
