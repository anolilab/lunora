## @lunora/observability [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.78...@lunora/observability@1.0.0-alpha.79) (2026-09-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.37
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.70

## @lunora/observability [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.77...@lunora/observability@1.0.0-alpha.78) (2026-09-12)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.69

## @lunora/observability [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.76...@lunora/observability@1.0.0-alpha.77) (2026-09-12)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.68

## @lunora/observability [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.75...@lunora/observability@1.0.0-alpha.76) (2026-09-12)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.66

## @lunora/observability [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.74...@lunora/observability@1.0.0-alpha.75) (2026-09-12)

### Documentation

* align package docs with the shipped api ([#706](https://github.com/anolilab/lunora/issues/706)) ([40c24b7](https://github.com/anolilab/lunora/commit/40c24b7218d1326ced4d73c8961c6e339d89f562))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.65

## @lunora/observability [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.73...@lunora/observability@1.0.0-alpha.74) (2026-09-12)

### ⚠ BREAKING CHANGES

* `lunora_run_mutation` and `lunora_run_action` no longer execute on a
single call. Callers must perform the two-step handshake; the one-shot path is gone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* docs(errors): generate the reference from the catalog

apps/docs/src/content/docs/errors.mdx was hand-written and listed 36 of
ERROR_CATALOG's 154 codes. The other 118 were on no page at all, so llms.txt,
llms-full.txt and the docs MCP server at /mcp — the three ways an agent
retrieves an explanation — had nothing to return for them.

A new apps/docs/scripts/generate-error-reference.js writes the block between two
MDX markers from packages/errors/src/catalog.ts: one section per published code,
with its transport status, title and hint. All 141 non-internal codes now have a
heading and therefore an anchor. The 13 internal codes stay out — their message
is redacted on the wire, so there is nothing for an app author to branch on.

The hand-written prose above the markers (the intro, the isLunoraError example,
the build-time solutions table, "Throwing your own") is untouched by every run.
The per-code tables it duplicated are gone.

It imports catalog.ts through Node's type stripping rather than the built
package, so it needs no build step in front of `pnpm dev`, and adds no
dependency to the zero-dependency @lunora/errors.

Wired into apps/docs's build and dev scripts next to the sibling generators, and
into scripts/check-generated-files.mjs so `pnpm run lint:generated` re-runs it in
CI and fails on a stale committed page. errors.mdx joins the generated_files
path filter so a hand edit to the output cannot skip that job.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* feat(mcp): add the lunora_explain_error tool

An agent that hits a Lunora error over MCP had nowhere to look it up: the tool
surface exposed the deployment, never the error catalog that already drives the
CLI renderer, the Vite overlay, Studio and the client SDK.

lunora_explain_error takes a code, a raw message, or both, and returns the
catalog entry (status, title, hint), any solution the message-matching tables
recognise, and a link to the published reference — anchored on that code's
section, or the bare page for an internal code, which has none.

It lives in the always-exposed tier, behind neither the write nor the
observability gate: everything it returns is static data compiled into
@lunora/errors, so it reveals no user data and needs no admin bearer. It is the
only tool here that touches no deployment, so ./local answers it directly rather
than refusing it when no dev server is running — explaining the error is exactly
what you want when nothing is up.

Matching is not re-implemented: resolveHint and findIssueSolution are the same
seams every other error surface resolves through. @lunora/errors now exports
getCatalogEntry, the guarded Object.hasOwn seam for reading the catalog by an
arbitrary string, so the tool does not reach into ERROR_CATALOG by bracket.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* feat(cli): add a stable exit-code taxonomy

An agent or a CI step had three codes to work with — 0, 1 and 130 — so telling
"not logged in" from "wrangler is missing" from "that name is already taken"
meant parsing English prose out of stderr.

The CLI now terminates with a documented code: 0 success, 1 failure, 2 usage,
3 auth, 4 permission denied, 5 not found, 6 conflict, 7 rate limited,
8 unavailable, 9 missing local dependency, 130 cancelled.

The classification is derived, not invented. ERROR_CATALOG already assigns every
code a transport status, so util/exit-code.ts maps status -> exit code once and
every catalogued code inherits its bucket. Only two kinds of code are overridden
by name: the build-time codegen diagnostics (catalogued 500 for a wire they
never cross, while what they report is the developer's own source being wrong,
so exit 2), and LOCAL_DEPENDENCY_MISSING, for which no HTTP status exists.

That new catalog code is minted by defaultSpawner, the single chokepoint every
shell-out goes through: a command that is not on PATH raises ENOENT with no PID,
which now becomes a coded error and exit 9 instead of a bare exit 1.

command.ts and cli.ts resolve their exit through the taxonomy, and both now
render a coded error through renderLunoraError, so the hint block reaches the
terminal from a command body too. The rendered block also names the code and the
exit code it carries, so the number a script branches on and the text a human
reads agree.
* PROMPT_CANCEL_EXIT_CODE is gone — use EXIT_CODE.CANCELLED.
PromptCancelledError is now util/prompt-cancelled's default export (it is that
module's only export). An unknown command exits 2 rather than 1, and any command
throwing a LunoraError exits with its mapped code rather than 1.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* feat(cli): normalize machine-readable output on --format

The flag was inconsistent and partial: nine commands took `--format json`, six
took a `--json` boolean instead, and nine agent-heavy ones had neither. An agent
had to memorize which spelling each command wanted.

`--format pretty|json` is now the one result-document flag, on 23 commands.
Converted from `--json`: info, insights, analyze, registry, deployments.
Newly covered: migrate, introspect, env, seed, run, import, export, backup,
containers. All of them go through output-format.ts, so the stdout/stderr
contract is identical everywhere — in json mode stdout carries exactly one JSON
document and every human/progress line moves to stderr.

Each document is the command's own structured result, not a stringified
rendering: env answers per-subcommand (list keys, the diff's three-way split,
doctor's missing/placeholder/extra), migrate hands back the orchestrator's
per-shard roll-up, import the batcher's summary, seed the generated rows,
introspect the dialect + tables + files written, backup the manifest entries or
the PITR receipt, run the RPC's own return value.

Three carry a documented restriction rather than a fabricated shape, and refuse
with a usage error: `export --format json` requires `--out <file>`, because with
`--out -` the NDJSON stream already owns stdout; `deployments --format json` is
`list` only; `containers --format json` is list | info | images list. In those
last two wrangler writes the document itself, so the flag is forwarded rather
than wrapped — the same thing `deployments list` already did.

RULING on `lunora dev --json`: it stays as-is, deliberately. It selects a
streaming JSON LOG-LINE format for a long-running process, where `--format json`
promises exactly one document on stdout — folding it in would give one flag two
incompatible meanings, which is the ambiguity this change exists to remove.
`dev status` / `dev stop` do print a single document under that same flag, but
they share dev's option table, and two format flags on one command is worse for
a caller than one flag whose meaning is stated. Its description now says so, and
a test pins `dev` as the only command declaring a bare `--json`.

Also refactored four functions that went over the cognitive-complexity budget as
the branches were added (export's output preflight and finish, import's report,
seed's dry run, migrate's subcommand dispatch).
* the `--json` boolean is removed from info, insights, analyze,
registry and deployments — pass `--format json`. The `json` option on their
`run*Command` library entry points is likewise replaced by `format`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* feat(shard-engine): add relation-graph traversal

Every `v.id("target")` column already declares a foreign-key edge, and nothing read it. This
compiles those columns into a directed edge set and walks it.

`ctx.db.related(start, options)` is a bounded breadth-first traversal from a loaded document or
`{ table, id }`. It takes `edges` (an allow-list of `"<table>.<column>"` edge names), `direction`
(`"out" | "in" | "both"`), `depth` (1..4), `limit` (default 50, max 200) and a `cursor`, and returns
the `ctx.db` page envelope with each node's `document`, `depth`, `path` (edge names walked),
`pathIds` and a depth-decaying `score` (`0.5 ** (depth - 1)`). Depth and limit out of range are
refused rather than clamped; a `visited` set makes a cyclic schema terminate.

The traversal emits no SQL: every hop is one batched `findMany` back through the caller's own
writer, so read-dependency stamping, soft-delete scoping, `.global()` routing, RLS and column
masking all apply per hop. An array foreign key is followed outward only — `where` has no
array-containment operator and the alternative is an unbounded scan.

- `@lunora/shard-engine`: `deriveRelationEdges` / `findRelated`, `related` on `DatabaseWriterLike`,
  and a new `"rebound"` gating kind in `rls-guard` that re-binds `related` over the GUARDED writer
  so every hop is table-gated. `ValidatorLike._meta` now declares `inner` / `tableName`.
- `@lunora/server`: `DatabaseReader.related` plus its public option/result types, and `related`
  overrides in the RLS and mask middlewares so a traversal cannot read around either policy.
- `@lunora/codegen`: IR-side `deriveRelationEdges` feeding a new `relationGraph` `PlatformSignals`
  entry, and a `runShardFindRelated` override in the emitted shard.
- `@lunora/platform`: `relationGraph` rated `emulated` on Cloudflare and Node — the walk is Lunora's
  own expansion over reads each host already serves, carried by `ShardHost` and nothing more.
- `@lunora/ai`: `hybridRank` takes a third (graph) leg whose RRF term is scaled by each hit's depth
  decay, wired through a new `RagConfig.graphStore`.
- `@lunora/do` / `@lunora/mcp`: a read-only `__lunora_admin__:findRelated` op and the
  `lunora_find_related` MCP tool over it.

The `sql-store` / `d1` edits are a consequence, not drive-by: declaring `_meta.inner` on
`ValidatorLike` made their hand-written casts around it unnecessary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* chore(examples): regenerate the expo shard codegen

Lane A regenerated 11 of the 12 examples' `lunora/_generated` trees; expo was
missed, so its committed `shard.ts` lacked the `runShardFindRelated` override
the merged codegen now emits. `lint:generated` caught it on the integration
branch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(mcp): bind the whole proposal into the write digest

`canonicalize` hand-listed the six `ProposedWrite` fields and `actionRequired`
listed them a third time, so the module built to stop an unreviewed write failed
OPEN: a field added to `ProposedWrite` later would be shown to the human in the
`action_required` proposal and NOT be covered by the digest, letting a
confirmation for the action a human saw also confirm one with that field
changed.

Sign the proposal whole (`stableStringify(proposal)`) and hand the same object
back as `proposedAction`, so what the human reviews and what the digest binds
cannot drift apart, and a new field is covered the moment it exists.

The new test is the gate: it pins the field set the proposal exposes and tampers
with each caller-settable one under the approved digest. Verified it fails —
rather than silently passing — by adding a seventh field and watching two
assertions go red.

Found by a thermo-nuclear code-quality review of the integration branch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(shard-engine): derive the rebound gate set

`WRITER_METHOD_GATING` is the guard's exhaustiveness control, and
`LOOP_GATED_METHODS` is derived from it so the two can never drift. The
`"rebound"` mode had no derived counterpart — `installGuardedRelated` hard-coded
`related` — so classifying a second method as `"rebound"` compiled, fell out of
the loop-gated filter, got no gate installed, and reached the guarded writer
UNGATED through the `...raw` spread. That is exactly the bypass the spread's own
comments warn about in three places. Latent rather than live, since `related` is
the only rebound method today.

Derive `REBOUND_METHODS` the way `LOOP_GATED_METHODS` is derived, and index it
against a `Record<ReboundMethod, Rebinder>`. A new `"rebound"` entry now widens
`ReboundMethod` and fails to compile until it has a rebinder. Confirmed by
classifying `count` as rebound and getting TS2741 rather than a silent hole.

The old test restated the gating map literal and would have stayed green through
all of the above. It now walks the classification and checks that no rebound
method reaches the caller as the raw one.

Found by a thermo-nuclear code-quality review of the integration branch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(cli): exit with the usage code on a bad --format

The taxonomy documented `USAGE` (2) as "the invocation itself is wrong", and
`cli.ts` already exits 2 for an unknown command — but all 22 `--format` guards
returned 1, so the CLI contradicted itself: a misspelled command exited 2 and a
misspelled flag VALUE exited 1. An agent branching on the exit code got the
wrong bucket for the most obviously-bad invocation there is.

Every `--format` refusal now resolves through the taxonomy. Two handlers needed
a channel for it: `codegen` and `advisor` classify their outcome at the
`execute` boundary from `error`/`failedAdvisories`, which cannot tell a bad flag
value from a failed run after the fact, so their result carries an optional
`code` that only a usage refusal sets. `deploy` overrides the code on its
shared `abortResult` rather than reclassifying every pre-wrangler abort.

The two sibling refusals — `deployments` and `containers` rejecting `--format
json` on a subcommand wrangler cannot render — move with them, since asking for
a flag value a subcommand cannot honour is the same class of mistake.

Scope, deliberately: this fixes the `--format` contradiction, not the wider
reclassification. 165 `code: 1` returns remain across the command tree, and each
needs its own judgement about which bucket it belongs in.

Found by a thermo-nuclear code-quality review of the integration branch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* security(mcp): gate the relation traversal behind the observability tier

`lunora_find_related` sat in the always-exposed tier, gated by nothing. Its
server side is the shard's `__lunora_admin__:findRelated` op, whose writer comes
from the generated `adminWriter()` — built by `createShardCtxDb` WITHOUT
`enforceRls`, so `ctx-db.ts` never wraps it in `guardWriter`. No
`relationBaseWhere` or `relationMask` are passed either.

So any MCP server holding an admin bearer let a model read arbitrary rows of
arbitrary tables by `{table, id}`, plus everything reachable within four hops,
with RLS policies and column masks bypassed — by default, with no opt-in.

That is the argument the observability tools already make for log lines and
grouped errors, only sharper: these are the rows themselves. The traversal now
sits in its own tier gated by `allowObservability`, omitted from the advertised
list AND refused at dispatch, and its description and the package docs say
plainly that it reads past RLS. It was also absent from the package's tool
table entirely; that row is added.

Holding the admin bearer already confers this authority. What must not be
implied is handing it to a model.

Found by a thermo-nuclear security review of the integration branch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* security(shard-engine): bound the traversal cursor offset

`decodeRelatedCursor` accepted any non-negative integer offset. The offset is
not a skip — `wanted = offset + limit + 1` flows straight into each hop's
`findMany({ limit })`, and `ctx-db` emits that as a bare SQL LIMIT with no
ceiling. Cursors are unsigned base64 JSON, so a forged offset made a shard
materialise every row of up to four tables inside one request, and the refusal
`readBoundedInteger` enforces on `limit` was bypassable simply by moving the
number into the cursor.

Cap the offset at 10 000 — 50 pages at the maximum `limit`, ~10 200 rows per
hop — and refuse rather than clamp, like every other bound in this module.

The docs claimed the re-walk was "bounded by the same depth and limit caps as
the first page". That was never true: even organic deep paging grows the
per-hop read window linearly with the offset. Corrected to state what the
offset actually costs.

Found by a thermo-nuclear security review of the integration branch, which
demonstrated a hand-built cursor driving a single hop to limit 1000000051.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(server): refuse ctx.db.related under a required-RLS schema

Under `.rls("required")` the traversal was unusable, and failed confusingly.
`related` was the one read in the RLS wrapper that did not call `route()`: it
used `base` unconditionally, which is the GUARDED writer there, and whose
`related` is re-bound over that same guarded writer. So every hop ran
`guarded.findMany` and `guardTable` denied any non-public table EVEN WHEN a
policy covered it — a handler with correct policies got `RLS_REQUIRED` from a
table it had declared.

`related` cannot call `route()` because a traversal discovers its tables as it
walks, so there is no table name at that call site. Routing it properly means
handing the walk a reader that resolves per table, which needs `findRelated` and
the schema's edge set inside this middleware; neither is reachable from
`@lunora/server` today. The shortcuts — a reader override, or letting a supplied
filter earn guard passage — each turn an engine-internal seam from one that only
NARROWS into one that widens, which is worse than the bug.

So it refuses up front with a message naming the limitation, instead of
surfacing as a denied table mid-walk. Non-required schemas are unaffected
(`base === raw`), which is where the feature already worked.

Adds the first test of `related` through the RLS middleware; that path had none,
which is how this shipped. Verified it fails when the refusal is removed.

Follow-up: per-hop routing, which makes a policy-covered table reachable and
keeps an uncovered one denied.

Found by a thermo-nuclear security review of the integration branch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* security(mcp): give the relation traversal its own gate

Folding it into `allowObservability` made one opt-in grant two different data
classes. An operator enabling log reading to debug a deployment would also, and
silently, hand the model every row of every table with RLS policies and column
masks bypassed. Those are not the same decision.

`lunora_find_related` now has `allowDataReads` / `LUNORA_MCP_ALLOW_DATA_READS`,
omitted from the advertised list and refused at dispatch exactly as the other
tiers are, and the docs say which gate covers what and why they are separate.

Also hardens the write-confirmation digest key. `client.getAuthToken() ?? ""`
silently degraded the key to a public constant for a tokenless client — every
input then knowable, so anyone could mint a digest that verifies while the
handshake still LOOKED like it was working. It now refuses. A tokenless server
cannot run a write anyway, so this costs nothing real. (The guard as first
written compared against `undefined`; ESLint caught that the real return type is
`string | null`, so half of it was dead.)

Not changed, deliberately: the server side keeps using `adminWriter()`. An
RLS-enforcing `findRelated` has no identity to evaluate policies under — the
admin bearer is not a principal and MCP carries no end-user session — so it
would deny nearly everything and look broken rather than be safe. Every sibling
admin RPC uses the same unguarded writer for the same reason. The defect was the
tier, not the RPC.

Found by a thermo-nuclear security review of the integration branch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* refactor(cli): import data-transfer entry points directly

`backup` and `migrate` reached `runExportCommand` / `runImportCommand` through
the `../data-transfer` barrel. Pre-existing (both trace to `786b5735d`); they
surfaced now only because this branch touched those files and the review bot
reads changed hunks.

Kept out of the feature commits, per the house rule that pre-existing lint debt
travels separately.

Note for whoever reads the bot comment: its stated rationale — "ships extra code
to your users & slows page load" — is a browser-bundle concern and does not
apply to a Node CLI handler. Direct imports are still the clearer spelling, so
this follows the advice without adopting the reasoning.

Four other call sites still use the barrel (`export`, `import`, `seed`); left
alone because nothing flagged them and widening this commit would bury the two
that were.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* test(cli): cover migrate --format json, and exit USAGE on a bad subcommand

`migrate` was the branch's largest single refactor — an if-chain became a switch
over four `dispatch*` shells, each owning its own JSON document — and it landed
with no `--format` coverage at all. Two independent signals said so: the
code-quality review ranked it merge-blocking, and Codecov reported 54% patch
coverage on this file with 25 lines missing.

Pins the `generate` and `create` documents, that stdout carries exactly one
document with the prose on stderr, and that a bad `--format` is refused before
anything dispatches.

Writing them surfaced an inconsistency the taxonomy work had missed: an unknown
SUBCOMMAND returned 1 while `cli.ts` already exits USAGE for an unknown
top-level command. Same class of mistake, so it now exits USAGE too.

Not changed: `migrate up` with no migration id still exits 1. It is a known
subcommand missing a required argument, which belongs with the wider
reclassification of the remaining `code: 1` returns rather than here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* security(mcp): bound the write-confirmation digest

An `actionDigest` was eternal: keyed by the deployment URL plus the admin bearer
and nothing else, so one human-approved `payments:refund` stayed confirmable for
the life of both, in every later session. Bind a deadline into the digest itself
and refuse a digest past it.

The digest is now `<expiresAt>.<signature>`, the signature covering the canonical
proposal AND that deadline. A stateless server has nowhere to record "issued at
T", so the deadline travels in the clear for the verifying instance to read —
signed alongside the proposal, so moving it breaks the signature. Ten minutes:
long enough for a human reading a proposal in a chat client, short enough that
the window is a real bound. An expired digest is refused rather than re-proposed,
because handing a fresh digest back to a call that said `confirmed: true` reads
to a model like the confirmation was accepted.

`action_required` now also reports `expiresAt` as an ISO stamp, so what a client
shows a human is the same number the verify enforces.

This does NOT make the handshake a human gate, and the module doc, the README and
the package docs now say so instead of implying otherwise. A verified digest
proves the call about to run is the call that was proposed, on this deployment,
inside its window — it cannot prove a person saw it. An MCP server has no channel
to one: no session, no end-user identity, no UI, and MCP puts the
human-in-the-loop at the host. A client that asks nobody can send back the digest
it was just handed. Enabling writes is the operator asserting that the client on
the other end does the asking; the digest is a client-UI affordance and an audit
record past that gate.

Also documented as a scope limit rather than left to be discovered: the digest is
deployment-wide, not principal-bound. On an OAuth-fronted server every principal
shares the admin bearer that keys it, so inside the window any principal holding
write scope can confirm another's identical proposal.
* `actionDigest` carries an expiry and two proposals of the same
write no longer produce the same digest string. A digest minted before this
change no longer verifies. The `idempotencyKey` guarantee is restated: the digest
already in hand keeps confirming inside its window, rather than the string being
byte-identical across proposals.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* security(ai): propagate the rag filter into the graph leg

`retrieve()` built `effectiveFilter` — the caller's `filter` with `rlsFilter`
merged over it — and handed it to the vector store and the lexical store. It
handed the graph store nothing. A traversal seeded from a document the caller may
see therefore returned that document's neighbours whether or not they were inside
the filter, and `hydrateFusionLeg` only hydrates, so nothing downstream narrowed
them either. A filter two legs honour and the third ignores is not a filter: an
app scoping retrieval by `orgId` leaked the neighbouring tenant's chunks the
moment it attached a `graphStore`.

`RagGraphStore.related` now receives `options.filter`, and the store must declare
whether it applies it. `enforcesFilter` is required rather than optional because
the answer is not derivable — `related` is somebody else's traversal and nothing
in `defineRag` can see whether it narrows — and a store answering `false` is
SKIPPED whenever a filter is in play rather than trusted. Retrieval then loses its
third signal and keeps its isolation, which is the right way round: a missing
signal is recoverable, a leaked tenant is not. An empty filter is not a filter, so
an `rlsFilter` returning `{}` for an admin does not cost a non-enforcing store its
leg.
* `RagGraphStore` gains a required `enforcesFilter: boolean`, and
`related`'s options carry `filter`. Every implementation must state whether it
enforces the filter it is given; `false` is the safe answer and disables the graph
leg for filtered retrievals only.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* security(cli): stop env --set printing the secrets it wrote

`env generate --set` writes minted secrets into `.dev.vars` and the pretty path
then names the keys and prints nothing else. The `--format json` document carried
`secrets: [{ key, value }]`, so the same invocation that discloses nothing on a
terminal put a freshly-minted `LUNORA_ADMIN_TOKEN` and every signing secret on
stdout — into CI logs, shell history, and whatever consumed the pipe. `--format`
must not be more disclosing than the default.

The `--set` document is now a separate shape carrying only `written`, the key
names. Two union members rather than an optional `value`, so that document cannot
carry a value by construction. `generate` WITHOUT `--set` is unchanged and still
returns the values: that mode exists to hand them over, and the pretty path prints
the same `KEY=value` lines to stdout.

Also applies the exit-code taxonomy to this handler's own argument validation,
which had `--format` at exit 2 and everything else at a generic 1: an invalid key,
a value `.dev.vars` cannot represent, a missing key or value, a missing `--yes` on
`push`, and an unknown subcommand are all the invocation being wrong, so they are
exit 2 too.
* `lunora env generate --set --format json` no longer includes the
minted values. Read `written` for the key names; drop `--set` if you need the
values.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* security(do): reject malformed findRelated options

`parseFindRelatedArgs` dropped each traversal option that had the wrong type and
fell back to its default — and every default this op has is its WIDEST setting, so
a malformed narrowing option ran a BIGGER traversal than the caller asked for:

- `direction: "sideways"` became `"both"`, walking both directions.
- `edges: "orders.customerId"` (a string, not an array) became EVERY edge.
- `limit: "1"` and `depth: "1"` became the default page and the default depth.
- a non-string entry inside `edges` was filtered out, so two of three named edges
  silently became one.

The caller is an AI agent composing JSON for `@lunora/mcp`'s
`lunora_find_related` — the caller most likely to send `"1"` for a number — and
the traversal reads through the ADMIN writer with RLS policies and column masks
bypassed. Widening its blast radius on malformed input is the wrong direction to
fail, so each option is now either absent or the right shape, and anything else is
a 400 naming the field. Ranges stay the writer's to enforce, so an out-of-range
`depth`/`limit` still fails with the message that names the cap.

`cursor: null` remains the wire's "first page" rather than a malformed cursor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* fix(mcp): advertise the error tool with no deployment

`lunora_explain_error` answers from the compiled-in `ERROR_CATALOG` and needs no
deployment at all, but it reached the tool list through `toolDefinitions` inside
`lazyDeploymentTools` — which `localTools` only builds when `options.deployment`
is set. So `createLocalMcpServer()` on its own never advertised it, and "what does
SHARD_TIMEOUT mean" is precisely the question you ask when nothing is running.

Registered unconditionally now, via its own `staticErrorTools`, and filtered out
of the deployment-bound list rather than left to `createToolServer`'s
first-registration-wins rule — so the advertised list has one entry per name and
nothing depends on registration order. The dispatch-side special case inside
`lazyDeploymentTools` goes with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* fix(cli): stop telling automation to retry a ceiling

`507 -> UNAVAILABLE` gave `BACKUP_TOO_LARGE` an exit code whose documented
contract is "retryable", so a CI step or agent reading it retries a backup that
will fail identically every time. The catalog entry's own hint says so:
"backing up more often does not help — every run is a full snapshot."

Both catalogued 507s are deterministic ceilings, not transients —
`BACKUP_TOO_LARGE` (the snapshot exceeds what a Worker isolate will assemble; the
fix is `backupTables` or `--bucket`) and `STREAM_TOO_LONG` (a durable stream past
its chunk ceiling). So the status maps to `USAGE`, which covers both and any
future 507 this system raises for the same reason; a genuinely transient 507 added
later belongs in `EXIT_CODE_BY_CODE`.

Audited the rest of the table for the same shape. 421 (`REPLICA_NOT_READY`,
`REPLICA_READ_ONLY`), 429, 503 (`SEARCH_INDEX_BUILDING`) and 504 all resolve on a
later attempt and stay retryable; tests now pin that too, so the fix cannot creep.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* fix(cli): refuse containers --format json before probing docker

`containers build --format json` is an unsatisfiable flag combination on every
machine, but the Docker preflight ran first — so the SAME invocation answered
exit 2 on a laptop with Docker up and "start Docker or Colima" in a CI runner
without it. Automation could not tell "fix the flag" from "provision the runner".

Invocation-shaped refusals now go ahead of environment probes. While there, the
unknown-subcommand guard exits `USAGE` rather than a generic 1, and the Docker
refusal exits `MISSING_DEPENDENCY` — the bucket whose docstring names docker
explicitly, and the one that tells a pipeline to install rather than retry.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* fix(cli): apply the usage taxonomy past the --format guard

Several handlers had adopted `EXIT_CODE.USAGE` for an invalid `--format` and left
every other argument validation at a generic 1, so automation reading the new
contract could not tell a mistyped flag from a command that ran and failed:

- `advisor`: an out-of-range or valueless `--min-score`.
- `codegen` and `verify`: a `--target` naming no registered driver.
- `migrate create`: a name with no alphanumerics, and a table that is not a bare
  identifier.
- `seed`: a `--table` the schema does not define.
- `backup` and `deployments`: an unknown subcommand.

Scoped to handlers that already apply the taxonomy for `--format` — the commands
that have not adopted it at all (`logs`, `link`, `rules`, `registry`, `mcp`,
`init`, `dev`) belong to the broader `code: 1` reclassification the PR already
lists as a follow-up, not to a partial pass here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* refactor(mcp): route tool dispatch through a family table

`tools.ts` tested `name` against three name-sets and then a switch, and checked
`OBSERVABILITY_TOOL_NAMES` twice — once inside `refuseGatedTool`, once in `callTool`. Four
dispatch mechanisms in one router is a worse shape than the one big function it was extracted
from.

The surface is four families plus write, and each already had the same three parts: a
`*_TOOL_DEFINITIONS` array, a `*_TOOL_NAMES` set, a `call*` function. `TOOL_FAMILIES` makes that a
table of `{ definitions, names, call, gate? }`; `toolDefinitions` flatMaps the open families and
`callTool` finds the owning family, checks its gate, dispatches. `refuseGatedTool`, the duplicate
observability check and the `no-unnecessary-boolean-literal-compare` disable wrapper all go with
it.

Each gate is declared once and read by `closedGate`, which both halves of the guarantee consume:
`toolDefinitions` omits a closed family, `callTool` refuses its names even when a client names one
it was never shown. Fail-closed is now one `isOptedIn(value) => value === true` over an
`unknown`-typed gate bag, so an env-plumbed `"false"`/`"0"` still cannot opt in — and the
comparison no longer needs a lint disable to survive.

`lunora_find_related`'s input schema and argument coercion move to `src/row-read-tools.ts`,
matching the module-per-family shape the error and observability tiers already had.

A table-driven suite now holds all three gates to the same contract: omitted from the advertised
list, refused at dispatch naming its env var without touching the deployment, and closed for
truthy non-booleans.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(mcp): match findRelated args to the shard's rules

Two parsers, one payload, different rules. `readRelatedArguments` required only a non-EMPTY
`table`/`id` and passed `edges` through on `Array.isArray` alone. `@lunora/do`'s
`parseFindRelatedArgs` — the check the payload actually meets on the shard — requires non-blank
after `.trim()`, rejects an `edges` entry that is not a string, and rejects a malformed
`cursor`/`depth`/`direction`/`limit` rather than falling back to a default, because every default
this op has is its WIDEST setting.

So `{ table: "   " }` and `edges: ["tickets.customerId", 7]` left the MCP server looking
well-formed, and `direction: "sideways"` was forwarded to a parser that 400s it. A pre-check that
disagrees with the real check about which payloads are well-formed is worse than none.

The MCP side now applies the same rules and the same refusal text, so one payload gets one answer
wherever it is caught. Nothing that used to succeed now fails — every newly-refused payload was
already refused one hop later, with a different message.

The duplication survives. `parseFindRelatedArgs` is module-private to `@lunora/do` (its public
entry re-exports no part of `./admin-rpc-args`) and `@lunora/mcp` does not depend on `@lunora/do`;
adding that dependency would pull the Durable Object runtime, `@lunora/platform-cloudflare` and
`drizzle-orm` into a stdio/HTTP server that never runs a DO, and would still not reach a
module-private export. The rules the two share are pinned as a table in the tests instead, so the
next divergence fails here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* refactor(ai): take fusion legs as a list in hybridRank

`hybridRank(vector, text, graph = [], k = 60)` grew its graph leg as a THIRD POSITIONAL parameter
inserted BEFORE `k`, and the call sites showed why that is a trap: the graph-only caller had to
write `hybridRank(chunks, [], graphLeg)`, passing an empty list for a leg it does not have.

The third parameter was never "a third list" — it is a list with a different scoring rule, scaling
its RRF term by a clamped `chunk.score`, which the other legs do not do. It encoded a leg KIND,
not a leg POSITION, which is exactly why the empty slot read as nonsense.

The signature is now `hybridRank(legs, { k })`, where each leg is
`{ chunks, weight?: "rank" | "proximity" }`. A caller passes the legs it has, in any number, and
declares the graph leg's rule on the leg itself. The three near-identical contribution loops
collapse into one loop over the list, and `NO_GRAPH_RESULTS` ("costs no allocation per call") goes
with them — allocation theatre in a function that immediately builds a Map, three arrays and a
sort.

`vectorRank` becomes `primaryRank`, the tie-break rank in the FIRST leg. Same behaviour for the
existing callers, where leg 0 is the vector leg.

The module moves from a sole default export to named exports, since it now exports the `FusionLeg`
and `HybridRankOptions` types alongside the function — a default plus names in one file is what
the repo forbids.

This is an API break on an alpha package: the old positional form is deleted, not aliased, and all
call sites and tests move with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(ai): fuse the retrieval legs once, not one at a time

`retrieve()` folded one leg into the ranking at a time — the multi-query loop, then lexical, then
graph — and every `hybridRank` call both multiplies each chunk's `importance` into the score it
returns AND sorts by that score. So every pass after the first derived its ranks from an ordering
importance had already weighted, and then weighted it again.

Measured on three legs, with a source demoted to `importance: 0.1` sitting at rank 0 of the vector
leg: the sequential shape scored it `(1/63) * 0.1 = 0.00158730`, because pass 1's weighting pushed
it from rank 0 to rank 3 before pass 2 re-derived its RRF term from that demoted rank. One fusion
scores it `(1/60) * 0.1 = 0.00166667`. The gap grows with the number of legs, and it only ever
moves chunks importance had already moved — a full-weight chunk is unaffected either way, which is
why it went unnoticed.

The sequential pattern predates this branch (`alpha` already folds twice: the multi-query loop and
the lexical leg), so this is not the graph leg's bug — the graph leg made it a third pass.

`retrieve()` now collects the legs and calls `hybridRank` once. The graph leg does not need the
fused list: `legs.flatMap(...)` is the same seed set, since fusion returns the legs' union. That
deletes the `chunks = [...]` reassignment chain. A lone leg is still returned as it stands, so a
plain vector retrieval keeps cosine scores on the scale `minScore` is documented against.

`NO_GRAPH_RESULTS` is gone, and `hybridRank`'s docblock now states the once-per-call rule the
caller has to honour.

Two tests pin it: a unit case showing a fused list re-fused is weighted twice, and a three-leg
`retrieve()` case asserting the exact single-multiplication score. Both fail against the
sequential shape.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* chore(ai): accept the hybridRank api snapshot

`FusionLeg`, `FusionWeight` and `HybridRankOptions` are new public types on `@lunora/ai/rag` —
`hybridRank`'s parameter shapes, which have to be nameable now that the legs are a list. Regenerated
with `pnpm run api:update` against a fresh full build.

`hybridRank` itself is tagged `@experimental`, so the snapshot tracks only the new type names and
not the signature change that introduced them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* docs(docs): teach agent-setup the new agent surfaces

agent-setup.md is the one URL a user pastes at a coding agent, and it knew
* `DatabaseWriterLike` gains `relationEdges`, which a writer
implementing `related` must publish — the RLS wrapper keys the traversal off it
rather than off `related`. `@lunora/server` now depends on
`@lunora/shard-engine`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* refactor(shard-engine): fold the two edge expansions into one

`expandOutEdge` and `expandInEdge` were ~30 duplicated lines: both built a
`parentOf` map, called `readHop`, then ran an identical dedupe-and-push loop
producing the same `FrontierNode`. They disagreed about four things — the array
short-circuit, which table and `where` to read, whether the parent is recovered
via `_id` or the foreign-key column, and which table labels the reached node.

Three of those collapse into one question: which column on the table being read
carries the key a row was reached under. It is `_id` outward and the foreign-key
column inward, and it is both the batched `where`'s field and the parent lookup.
So `expandEdge(reader, frontier, edge, hop, direction)` takes a four-field
direction descriptor — `keyColumn`, `keysOf`, `skipVisitedKeys`, `table` — and
the array short-circuit becomes the in-direction's `keysOf` yielding nothing.

`skipVisitedKeys` is the one asymmetry worth naming: out-keys are ids of rows
about to be loaded, so dropping a visited one early keeps the `IN (…)` list and
the hop's budget tight; in-keys are ids of the frontier nodes being expanded
from, all of which are visited by definition, so the same filter would drop the
entire hop.

In `expandFrontier`, the two budget guards now read `remaining()` instead of
`hopOf().limit`. `hopOf` is a non-idempotent closure over the mutable `reached`,
and it was allocating a whole `HopContext` twice per edge just to read one number
off it.

No behaviour change; the 21 relation-graph tests cover both directions, array
edges, cycles and budget exhaustion.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* refactor(codegen): keep the relation-graph question, drop the copy

`deriveRelationEdges` was implemented twice — 118 lines here off the static
schema IR, and again in `@lunora/shard-engine` off the live validators. Both
docstrings claimed the two name edges identically and are both pinned by tests,
but the tests built independent fixtures and asserted independently: nothing ever
compared them, so teaching one side to unwrap `v.union` would have desynced the
codegen gate from the runtime with every test green.

The copy also had exactly one consumer — `declaration-surface.ts` doing
`deriveRelationEdges(schema).length > 0` — so 118 lines, a public `RelationEdge`
export and an api-snapshot entry existed to compute one boolean. That is the
abstraction-with-one-implementation the repo rules forbid.

So codegen keeps the QUESTION and drops the duplicate answer:
`schemaDeclaresRelationGraph(schema): boolean`, 30 lines, no exported edge type.
The edge set now has a single derivation, in `@lunora/shard-engine`, which is the
only one whose output anything consumes.

The alternative — emitting the edge set from codegen into `_generated/` — was
rejected: it would make a core `ctx.db` method depend on a generated artifact,
and the runtime must derive from the live validators anyway to stay honest about
what it can actually filter on.

The inputs still differ (static AST IR vs runtime validators), so codegen's test
now cross-pins its boolean against `deriveRelationEdges` over one shared fixture,
each case written once and projected into both worlds. Verified by mutation: an
added `v.union` unwrap on the codegen side fails the cross-pin.
* `@lunora/codegen` no longer exports `deriveRelationEdges` or the
`RelationEdge` type. Derive edges from `@lunora/shard-engine` instead; the
`relationGraph` platform signal is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(shard-engine): make RelatedStart actually discriminate

`RelatedStart` was `Record<string, unknown> | RelatedStartReference`, and arm 2
is assignable to arm 1 — so the union collapsed to arm 1 and gave zero
compile-time help. `related({ tabel: "x", id: "y" })` type-checked and failed at
runtime inside `resolveStart`, with a message about the very shape the type was
supposed to be enforcing.

The document arm now requires the `_id` that `resolveStart` reads to recognise
it: `RelatedStartReference | (Record<string, unknown> & { _id: string })`. That
is the documented discrimination, made real. Both mirrors move together
(`@lunora/shard-engine`'s `schema-types.ts` and `@lunora/server`'s `types.ts`),
and the one call site passing an untyped row now names the shape.

`types.test-d.ts` pins all four verdicts — reference accepted, document accepted,
misspelled `tabel` rejected, bare `Record<string, unknown>` rejected. Verified by
mutation: restoring the old union fails two of them at compile time.
* `RelatedStart`'s document arm requires `_id: string`. A caller
handing `ctx.db.related` a value typed only as `Record<string, unknown>` must
narrow it — the runtime already rejected such a value.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* docs: drop the related-under-rls limitation, it is fixed

The docs lane described `ctx.db.related` as unsupported under a
`.rls("required")` schema, which was true when it wrote them. The relation-graph
lane then landed per-hop routing, so every hop now gets exactly the verdict a
direct read of that table would — and the two lanes could not see each other,
both having branched from the same commit.

Removes the stale callout and its maintenance marker from the concept page, and
replaces the one-clause versions in `agent-setup.md` and the `lunora-functions`
skill with the real contract: declare a read policy for every table the walk can
reach, or narrow it with `edges`.

The concept page already carried the correct behaviour a few lines above, from
the relation-graph lane, so it was contradicting itself after the merge.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* refactor(cli): parse --format once in defineHandler

`--format` was re-asked at every layer: 23 option declarations, 22 runtime
re-validations of the raw string, ~40 `isJsonFormat(options.format)` calls and a
`loggerForFormat` re-route in each handler. Every one of them answered the same
question, and each carried a retyped command-name literal that could drift from
the command it names.

`defineHandler` now resolves it once, before the body runs, and hands the body a
narrowed `OutputFormat` plus a logger already routed for it. The 22 guards are
gone, `isJsonFormat` collapses to `format === "json"`, and a bad value exits 2
without the command doing any work.
* every `*CommandOptions.format` is `OutputFormat`
("json" | "pretty") instead of `string`, so a direct caller of `runDeployCommand`
/ `runCodegenCommand` / `runExportCommand` / `runImportCommand` / `runRpcCommand`
passes a checked value and gets no runtime re-validation. `validateOutputFormat`
and `isJsonFormat` are deleted; `loggerForFormat` now takes an `OutputFormat`.
A `run*Command` no longer re-routes the logger it was given — `defineHandler`
did that, and an embedder's own logger was never diverted anyway.

The seven per-command "rejects an unknown --format" tests asserted one fact at
seven boundaries; they are replaced by the gate's own test in
`__tests__/util/command.test.ts` plus one end-to-end proof through `lunora add`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* feat(cli): give --format json one envelope, failures included

`--format json` answered on success and said nothing at all on failure: a failed
command wrote zero bytes to stdout and left the reason as English prose on
stderr — the exact thing the exit-code taxonomy's own docstring says this feature
replaces. The ~20 documents were also not a family: some were a bare domain
payload, some carried `code`, some `ok`, some a `subcommand` discriminant, and
`export` / `import` shared no key.

One envelope now, written once by `defineHandler` after the body returns:

    { "code": <exit code>, "data": <command payload>, "error": "<why it failed>" }

`code` is always there, `data` is absent when the run produced none, `error` is
present whenever `code` is non-zero and a reason is known — including for a
thrown error, which previously exited in silence. The ~20 per-command
`if (isJsonFormat(...)) printJson(...)` sites are gone, and `ok` / nested `code`
members are dropped from the payloads because the envelope answers that.

A command that forwards `--format json` to a tool which writes the document
itself (`deployments list`, the `containers` read subcommands, `logs`) returns
`delegated: true` and gets no envelope: a second document on that stream would
make neither parseable.

Two commands were splicing a child's output into their own document and are
fixed here: `analyze` left wrangler's bundle report on stdout, and `verify` left
tsc's diagnostics there. `import` printed its summary twice in json mode — once
to stderr, once inside the document.
* every `--format json` document is now the envelope, so a
consumer reads `.data.<field>` where it read `.<field>`. `dev --json` is
unchanged — it is a log-line stream, not a result document.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(cli): map the generic failures onto the taxonomy

The exit-code taxonomy was documented and exported, but the CLI only ever emitted
a few of its buckets from its own code: the rich ones (auth, permission, not
found, conflict, rate limited, unavailable, missing dependency) fired only when a
handler happened to THROW a catalogued error. Every refusal a handler wrote by
hand exited 1, so `migrate up` with no id, an expired credential and a corrupt
snapshot were one number to a caller.

Per-site pass over the ~125 `code: 1` returns. The shape of it:

- a missing positional, a bad flag value, a flag combination a subcommand cannot
  honour, a `--yes` that was not passed → 2
- "admin token required" → 3, everywhere it is raised
- a named schema / key / template / backup / registry root that is not there → 5
- `init` onto a non-empty directory or a symlink, and a migration id that already
  exists → 6
- a detached `dev` that never became ready, and a post-deploy health probe that
  never answered → 8
- `deploy` blocked by a missing container engine → 9, the same bucket
  `containers build` already exits with for the same missing engine
- a declined confirmation prompt → 130, like the Ctrl-C it stands in for
- an HTTP failure where the status is in hand → `exitCodeForStatus(status)`, so a
  403 shard denial and a 429 stop being the same answer

Four preflight resolvers refused with a bare `undefined` over several different
reasons at once — a flag combination (2) and a missing bearer (3) among them — so
the call site had nothing left to classify from. They now return a `Refusal`
carrying the code their reason maps to. `deploy`'s pre-deploy checks did the same
thing across three project-config checks and one machine check.

`doctor`, `verify`, `advisor`, `eval` and `env doctor` keep exiting 1 on a
negative verdict: they ran and the answer is no, which is not the same as
refusing to run. The docs page states that division, and drops the stale `507 →
8` row (the code has mapped 507 to usage since it became a ceiling, not a
transient).
* commands that previously exited 1 now exit 2, 3, 5, 6, 8, 9 or
130 depending on why they failed. A caller branching on `!== 0` is unaffected; one
matching `=== 1` must be updated.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* refactor(cli): split migrate, unwind the complexity band-aids

`migrate/handler.ts` was 999 lines, one from the repo's 1000-line threshold, so
the next subcommand would have tipped it. Its four `dispatch*` shells and the
cerebro `execute` they serve move to `migrate/dispatch.ts` (162 lines), leaving
`handler.ts` (848) the migration operations themselves — which is also the half an
embedder imports, since `runMigrateGenerateCommand` is re-exported from the
package root. The dependency runs one way: dispatch reads handler, and the
command's `loader` resolves `execute` from dispatch.

The dispatch context also drops `format`: nothing downstream reads it now that
`defineHandler` writes the document.

Two extractions made to satisfy `sonarjs/cognitive-complexity` moved complexity
into parameter bags instead of removing it, and both are unwound:

- `finishExport` threaded six fields out of a scope only to reassemble them, call
  a pre-existing helper and log one line. Inlined at its one call site.
- `emitImportReport` copied six fields out of `outcome` into a literal with the
  same six names. Inlined; the assembly happens where the values are.

Inlining `finishExport` put `runExportCommand` one point over the budget, so the
complexity is actually reduced rather than re-hidden: the target-and-credential
preflight becomes `resolveExportRequest`, which is one cohesive step with one
return value — and the shape `import` has always used for the same job.

`api-snapshots/cli.api.md` is regenerated here for the whole branch: the narrowed
`format` type and the `CommandResult` envelope the two earlier commits introduced
both reach the published surface.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(cli): carry the failure reason into the json envelope

The envelope defines `error` for a known nonzero result, and a dozen sites set
the code without it — so `--format json` reported an exit with nothing
explaining it, which is the gap the envelope exists to close.

`import`, `registry build` and `export` now carry the message they already
logged; `add`, `seed` and the four `migrate` adapters forward the nested
failure's reason instead of only its code. Two migrate result contracts gained
`error` to make that possible.

Three real defects alongside it:

- `logs` claimed `delegated: true` on the durable path's early refusals, which
  write nothing — so json mode suppressed the envelope and left stdout empty.
  Delegation is now claimed only once rows were written.
- `prepare` replaced the shared pipeline's own exit code with USAGE, losing
  MISSING_DEPENDENCY when Docker is absent.
- `confirmDepMutation` returned a bare `false` for two different things: a
  non-TTY run with no `--yes` (nobody could be asked — the invocation is wrong)
  and a human declining the prompt (a deliberate abort). It now reports which,
  so they exit USAGE and CANCELLED respectively. Three tests asserted the
  collapsed behaviour and are updated.

Verified against the built binary: `import --format json` and `registry build
--format json` both emit `{code, error}` where they previously emitted a bare
code.

Found by CodeRabbit on the follow-up push.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014h2dcDevwJvCuZfPsc7eRa

* fix(cli): carry the containers delegated and error markers into the envelope

`lunora containers`'s cerebro adapter returned only the exit code, dropping the
two markers `runContainersCommand` sets. Both matter under `--format json`:

- `delegated` suppresses the envelope for a read forwarded to wrangler with
  `--json`. Dropping it appended a second JSON document after wrangler's own, so
  stdout was two documents concatenated and parsed as neither.
- `error` carries a refusal's reason. Dropping it left `containers build
  --format json` emitting an exit code with nothing saying why.

Every existing test called `runContainersCommand`, which writes nothing, so the
adapter's drop was invisible to all of them; the two new ones drive `execute`,
where the envelope is written, and both fail against the unfixed return.

Also pins the unresolved-`--target` refusal in `codegen` and `verify`: those
return before their reporting tail, and `defineHandler` serializing them is what
keeps that path from going out as an empty stdout.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* refactor(cli): import command modules directly rather than through barrels

Five handlers reached their orchestrators through `../registry`,
`../data-transfer` and `./index`. The direct path names the module that actually
owns the function, which is the clearer spelling and stops a handler pulling in
every sibling the barrel re-exports.

The two tests that stubbed those orchestrators mocked the barrel, so they
silently stopped intercepting once the handler no longer went through it — both
retargeted at the module the handler imports.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* fix(repo): restore what the rebase dropped from the branch

Two merge drivers and one strategy option each ate content while reporting
success, so the rebased tree was missing changes this branch had already landed:

- `.git/info/attributes` maps `api-snapshots/*.api.md` and `pnpm-lock.yaml` to
  `keepours`, which resolves a conflicting hunk to the upstream side without
  reporting a conflict. Three snapshots came out at their pre-branch content —
  `EXIT_CODE` and the `CommandResult` envelope gone from `cli`,
  `LOCAL_DEPENDENCY_MISSING` gone from `errors`, every `Related*` type gone from
  `lunora`. The generated error reference lost the same entry.
- Replaying 46 commits over 11 flattened lane merges made the lanes conflict
  with each other rather than with upstream, and resolving those toward the
  commit being applied left `packages/mcp/docs/index.mdx` describing a tool
  export it no longer lists, and `packages/server/package.json` carrying two
  dependency pins older than either side.

Upstream turns out to touch only two files this branch also touches, so the
correct tree is recoverable exactly: every file only one side changed must match
that side, and the two shared files are `packages/cli/docs/index.mdx` (both
changes present) and `packages/server/package.json` (upstream's pins plus this
branch's `@lunora/shard-engine` dependency). Verified file-by-file in both
directions.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

### Features

* make Lunora's agent surface first-class (relation graph, MCP write confirmation, CLI automation contract, error catalog reach) ([#694](https://github.com/anolilab/lunora/issues/694)) ([c03e723](https://github.com/anolilab/lunora/commit/c03e7238365d393a8edd65079e8c1508afef7718))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.36
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.64

## @lunora/observability [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.72...@lunora/observability@1.0.0-alpha.73) (2026-09-12)

## @lunora/observability [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.71...@lunora/observability@1.0.0-alpha.72) (2026-09-11)

## @lunora/observability [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.70...@lunora/observability@1.0.0-alpha.71) (2026-09-11)

## @lunora/observability [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.69...@lunora/observability@1.0.0-alpha.70) (2026-09-10)

### Features

* **observability,do:** stamp the deploy onto every request-log row ([#681](https://github.com/anolilab/lunora/issues/681)) ([925dbda](https://github.com/anolilab/lunora/commit/925dbda2479e258aa71582170dd20f2d85ffece8))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.63

## @lunora/observability [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.68...@lunora/observability@1.0.0-alpha.69) (2026-09-10)

## @lunora/observability [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.67...@lunora/observability@1.0.0-alpha.68) (2026-09-08)

## @lunora/observability [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.66...@lunora/observability@1.0.0-alpha.67) (2026-09-08)

## @lunora/observability [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.65...@lunora/observability@1.0.0-alpha.66) (2026-09-08)

## @lunora/observability [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.64...@lunora/observability@1.0.0-alpha.65) (2026-09-08)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.62

## @lunora/observability [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.63...@lunora/observability@1.0.0-alpha.64) (2026-09-08)

## @lunora/observability [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.62...@lunora/observability@1.0.0-alpha.63) (2026-09-08)

## @lunora/observability [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.61...@lunora/observability@1.0.0-alpha.62) (2026-09-07)

## @lunora/observability [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.60...@lunora/observability@1.0.0-alpha.61) (2026-09-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.61

## @lunora/observability [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.59...@lunora/observability@1.0.0-alpha.60) (2026-09-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.35
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.60

## @lunora/observability [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.58...@lunora/observability@1.0.0-alpha.59) (2026-09-06)

### ⚠ BREAKING CHANGES

* **observability,agent:** `SpanHandle.spanContext()` returns `SpanContextIds`
(`sampled` alongside the ids); `ctx.trace` accepts an optional fourth
`SpanIdentity` argument; `WorkerOptions.queue` receives a fourth `TriggerTrace`
argument, and codegen emits it.

The gates that hid all of this are rewritten to go through the real path: the
bridge suite drives the real span factory instead of a fake that echoed back
whatever id it was handed, and the agent suites drive `generateText`/`streamText`
against a mock model instead of invoking the telemetry hooks by hand.

Not fixed, deliberately: a `ctx.fetch` span still parents to the dispatch rather
than an enclosing `ctx.trace` (no ambient span stack in the DO profile) — the
docblock now says so instead of implying otherwise. The Sentry and Braintrust
model-call spans still end at time-to-first-byte on a streamed turn, because
their host span must wrap `execute()` to establish the parent context; both
docblocks now state it and point at the OTLP bridge.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* chore(api): accept the span-identity and trigger-trace surface

The bridge now records under the id it publishes (SpanIdentity), SpanHandle
reports the propagated sampled bit (SpanContextIds), and a queue consumer accepts
the trigger's trace (TriggerTrace).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent): close every telemetry bridge at the real end of a call

The Sentry and Braintrust bridges wrapped `execute()`, which on a streamed turn
resolves the instant `doStream` hands the stream back. Both reported every
streamed generation as a ~1 ms, zero-token, always-OK call, and a stream that
died mid-way never reached a span at all.

Both now open the host span around `execute()` — still what parents the
provider's own work — but keep it open past it. Sentry uses `startSpanManual`
(present on every SDK built on `@sentry/core`, verified against 10.55.0) and ends
the span from the terminal event; Braintrust parks its `traced` callback on a
gate the terminal event releases, so the caller still gets `execute()`'s value
immediately while the span covers the whole generation. Usage is read off the
SDK's normalized end event, where a LanguageModelV4 provider's nested
`{ inputTokens: { total } }` has already been flattened.

The lifecycle all three share moves to `telemetry/in-flight-calls.ts`, and with
it two fixes:

- Aborts and errors now close the call they NAME. Every ai@7 terminal event
  carries the model call's `callId`, `onAbort` and `onError` included, but the
  close was indiscriminate — and a bridge built at module scope, which is the
  documented `defineAgent({ telemetry: { integrations: [...] } })` shape, shares
  one map across every concurrent run in the isolate. One run's barge-in
  reported a sibling's live generation as aborted and swallowed its real span.
- A stream that rejects outright dispatches no telemetry callback at all, so
  its entry was never removed and pinned the call's prompt for the life of the
  integration. Entries older than ten minutes are now swept on the next open.
  The contradictory claim that the map "cannot grow" is gone.

A throwing integration also no longer fails the user's tool. `traceToolExecution`
runs inside the tool's durable `step.do`, so a host SDK throwing in `executeTool`
made the step retry a tool that had already run, or report a successful one as
failed — against that function's own promise that telemetry is never flow
control. The tool's real outcome is recorded as it happens and always wins.

`SpanIdentity`'s two ids become required: the sole caller always passes both, and
`identity?:` already expresses "no adapter involved", so a partial object
type-checked and meant nothing.

The `version_metadata` object unwrap in `readerFromRecord` is keyed to
`CF_VERSION_METADATA` alone. Applied to any object-valued binding it would export
the internal `.id` of whatever a future probed key named as a resource attribute.

Every model-call test now drives the real SDK through `generateText`/`streamText`
rather than invoking the hooks by hand, which is what hid the streaming defect:
called directly, `execute()` resolves with a finished result and the span looks
perfect. Each new assertion was confirmed to fail against the pre-fix behaviour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent): release swept calls and stop the wrapper deciding tool outcomes

Two findings from review, both real.

**The abandoned-call sweep dropped the record but stranded the resource.** A
swept entry was deleted without `onClose`, which is right — a span ending at
"whenever the next call started" is worse than none. But two bridges carry
something live in the host SDK: Sentry's `startSpanManual` span ends only when
someone ends it, and Braintrust's `traced` callback is parked on a gate the
terminal event releases. Dropping those entries left the span open and the
callback parked for the life of the isolate — the same leak the sweep exists to
prevent, one level down.

`createInFlightCalls` takes an `onEvict`, and each bridge releases its own
resource there without emitting anything. Both new tests fail without it
("expected undefined to be defined"). Writing the Braintrust one showed the
abandonment has to be modelled precisely: with an `execute()` that never
settles, the callback parks on `execute()` rather than on the gate, and nothing
can release it. The real shape is a stream handed back at first byte that then
dies — `execute()` resolves, the callback parks on the gate.

**A telemetry wrapper could decide a durable tool outcome.** The ai@7 contract
hands `executeTool` the tool's `execute` and trusts what it returns. This file
guarded a wrapper THROW, but not a wrapper that skips `execute` entirely or
returns a value of its own — so an integration could record a tool that never
ran, or replace its result, inside the durable `step.do`. That contradicts the
function's own promise that telemetry is never flow control.

The wrapper's return value and its rejection are now both discarded, and the
outcome is read from one memoized promise. Memoized rather than re-run: a
wrapper that starts `execute` without awaiting it leaves no trace by the time it
returns, and re-running would execute the tool twice. This also deletes the
`ran`/`failed` bookkeeping — the promise already carries both.

Five new cases; three fail against the previous flow (skip, replace, and the
un-awaited start), while reject-after-success and the tool's own failure already
behaved correctly.

Also suppress the secret scanner on a fixture `Bearer admin-token` in
`trigger-trace.test.ts`, matching how the e2e fixtures do it — `vis secrets`
reports clean.

464 agent tests, repo `lint:types`, `api:check` (54 snapshots) and `vis secrets`
all green.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* test(agent): floor the streamed-span assertions on the stream, not wall clock

CI failed with `expected 94 to be greater than 96` on the Sentry streamed-span
test. The assertion was `spanDuration > wallMs / 2`, but `wallMs` starts before
the span does — so a runner slow enough to spend ~98ms getting from the timer to
the first `doStream` call inflates the divisor past the span and the test fails
on scheduling alone, with nothing wrong.

All three bridge suites carried the same shape. Each now floors on the stream's
OWN delay budget, which the fixture makes knowable: `streamingModel` waits
`gapMs` per chunk, so `{ chunks: 3, gapMs: 30 }` is ~90ms regardless of how slow
the runner is getting there.

The floor still separates what it exists to separate. The defect being guarded is
a span closed when `execute()` resolves — the instant `doStream` hands the stream
back — which measured ~1ms. Verified by re-introducing exactly that close: the
streamed test fails again, along with three others.

464 agent tests pass; `eslint --max-warnings=0` clean (the constant sits above the
expect group rather than splitting it, which `vitest/padding-around-expect-groups`
flags).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* **observability,agent:** make the trace say what actually happened ([#618](https://github.com/anolilab/lunora/issues/618)) ([c07f788](https://github.com/anolilab/lunora/commit/c07f788836fb5724002a80a2031b88a033e304d0))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.58

## @lunora/observability [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.57...@lunora/observability@1.0.0-alpha.58) (2026-09-05)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.57

## @lunora/observability [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.56...@lunora/observability@1.0.0-alpha.57) (2026-09-05)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.56

## @lunora/observability [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.55...@lunora/observability@1.0.0-alpha.56) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.55

## @lunora/observability [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.54...@lunora/observability@1.0.0-alpha.55) (2026-09-03)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.54

## @lunora/observability [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.53...@lunora/observability@1.0.0-alpha.54) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.53

## @lunora/observability [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.52...@lunora/observability@1.0.0-alpha.53) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.52

## @lunora/observability [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.51...@lunora/observability@1.0.0-alpha.52) (2026-09-01)

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
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.51

## @lunora/observability [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.50...@lunora/observability@1.0.0-alpha.51) (2026-09-01)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.50

## @lunora/observability [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.49...@lunora/observability@1.0.0-alpha.50) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.49

## @lunora/observability [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.48...@lunora/observability@1.0.0-alpha.49) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.48

## @lunora/observability [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.47...@lunora/observability@1.0.0-alpha.48) (2026-08-29)

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

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/fingerprint:** upgraded to 1.0.0-alpha.9
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.47

## @lunora/observability [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.46...@lunora/observability@1.0.0-alpha.47) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.46

## @lunora/observability [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.45...@lunora/observability@1.0.0-alpha.46) (2026-08-28)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.45

## @lunora/observability [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.44...@lunora/observability@1.0.0-alpha.45) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.44

## @lunora/observability [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.43...@lunora/observability@1.0.0-alpha.44) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.43

## @lunora/observability [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.42...@lunora/observability@1.0.0-alpha.43) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.42

## @lunora/observability [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.41...@lunora/observability@1.0.0-alpha.42) (2026-08-26)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.41

## @lunora/observability [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.40...@lunora/observability@1.0.0-alpha.41) (2026-08-26)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.40

## @lunora/observability [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.39...@lunora/observability@1.0.0-alpha.40) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.39

## @lunora/observability [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.38...@lunora/observability@1.0.0-alpha.39) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.38

## @lunora/observability [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.37...@lunora/observability@1.0.0-alpha.38) (2026-08-25)

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

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.37

## @lunora/observability [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.36...@lunora/observability@1.0.0-alpha.37) (2026-08-25)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.36

## @lunora/observability [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.35...@lunora/observability@1.0.0-alpha.36) (2026-08-25)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.35

## @lunora/observability [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.34...@lunora/observability@1.0.0-alpha.35) (2026-08-24)


### Dependencies

* **@lunora/fingerprint:** upgraded to 1.0.0-alpha.8

## @lunora/observability [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.33...@lunora/observability@1.0.0-alpha.34) (2026-08-23)

### Performance Improvements

* **observability:** prune buckets once per window ([#456](https://github.com/anolilab/lunora/issues/456)) ([9543110](https://github.com/anolilab/lunora/commit/95431104f072ecb9c9a6caea55bfb91cdb5deb2e))

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.34

## @lunora/observability [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/observability@1.0.0-alpha.32...@lunora/observability@1.0.0-alpha.33) (2026-08-21)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.33

## @lunora/observability [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.31...%40lunora%2Fobservability%401.0.0-alpha.32) (2026-08-19)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32

## @lunora/observability [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.30...%40lunora%2Fobservability%401.0.0-alpha.31) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31

## @lunora/observability [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.29...%40lunora%2Fobservability%401.0.0-alpha.30) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30

## @lunora/observability [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.28...%40lunora%2Fobservability%401.0.0-alpha.29) (2026-08-15)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29

## @lunora/observability [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.27...%40lunora%2Fobservability%401.0.0-alpha.28) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/fingerprint:** upgraded to 1.0.0-alpha.7
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28

## @lunora/observability [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.26...%40lunora%2Fobservability%401.0.0-alpha.27) (2026-08-12)

## @lunora/observability [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.25...%40lunora%2Fobservability%401.0.0-alpha.26) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27

## @lunora/observability [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.24...%40lunora%2Fobservability%401.0.0-alpha.25) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26

## @lunora/observability [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.23...%40lunora%2Fobservability%401.0.0-alpha.24) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25

## @lunora/observability [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.22...%40lunora%2Fobservability%401.0.0-alpha.23) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24

## @lunora/observability [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.21...%40lunora%2Fobservability%401.0.0-alpha.22) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23

## @lunora/observability [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.20...%40lunora%2Fobservability%401.0.0-alpha.21) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.22

## @lunora/observability [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.19...%40lunora%2Fobservability%401.0.0-alpha.20) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20

## @lunora/observability [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.18...%40lunora%2Fobservability%401.0.0-alpha.19) (2026-08-09)

## @lunora/observability [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.17...%40lunora%2Fobservability%401.0.0-alpha.18) (2026-08-09)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.19

## @lunora/observability [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.16...%40lunora%2Fobservability%401.0.0-alpha.17) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18

## @lunora/observability [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.15...%40lunora%2Fobservability%401.0.0-alpha.16) (2026-08-08)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17

## @lunora/observability [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.14...%40lunora%2Fobservability%401.0.0-alpha.15) (2026-08-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.16

## @lunora/observability [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.13...%40lunora%2Fobservability%401.0.0-alpha.14) (2026-08-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.15

## @lunora/observability [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.12...%40lunora%2Fobservability%401.0.0-alpha.13) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.14

## @lunora/observability [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.11...%40lunora%2Fobservability%401.0.0-alpha.12) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.13

## @lunora/observability [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.10...%40lunora%2Fobservability%401.0.0-alpha.11) (2026-08-04)


### Dependencies

* **@lunora/fingerprint:** upgraded to 1.0.0-alpha.6
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.12

## @lunora/observability [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.9...%40lunora%2Fobservability%401.0.0-alpha.10) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.11

## @lunora/observability [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.8...%40lunora%2Fobservability%401.0.0-alpha.9) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/fingerprint:** upgraded to 1.0.0-alpha.5
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.10

## @lunora/observability [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.7...%40lunora%2Fobservability%401.0.0-alpha.8) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.9

## @lunora/observability [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.6...%40lunora%2Fobservability%401.0.0-alpha.7) (2026-08-03)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.8

## @lunora/observability [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.5...%40lunora%2Fobservability%401.0.0-alpha.6) (2026-08-02)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.7

## @lunora/observability [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.4...%40lunora%2Fobservability%401.0.0-alpha.5) (2026-08-02)

## @lunora/observability [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.3...%40lunora%2Fobservability%401.0.0-alpha.4) (2026-07-31)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.4

## @lunora/observability [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.2...%40lunora%2Fobservability%401.0.0-alpha.3) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.3

## @lunora/observability [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fobservability%401.0.0-alpha.1...%40lunora%2Fobservability%401.0.0-alpha.2) (2026-07-31)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.2

## @lunora/observability 1.0.0-alpha.1 (2026-07-30)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.1
