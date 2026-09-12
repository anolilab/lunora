## @lunora/mcp [1.0.0-alpha.136](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.135...@lunora/mcp@1.0.0-alpha.136) (2026-09-12)

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

* **@lunora/client:** upgraded to 1.0.0-alpha.101
* **@lunora/errors:** upgraded to 1.0.0-alpha.36
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.64
* **@lunora/x402:** upgraded to 1.0.0-alpha.69

## @lunora/mcp [1.0.0-alpha.135](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.134...@lunora/mcp@1.0.0-alpha.135) (2026-09-12)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.100
* **@lunora/x402:** upgraded to 1.0.0-alpha.68

## @lunora/mcp [1.0.0-alpha.134](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.133...@lunora/mcp@1.0.0-alpha.134) (2026-09-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.99
* **@lunora/x402:** upgraded to 1.0.0-alpha.67

## @lunora/mcp [1.0.0-alpha.133](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.132...@lunora/mcp@1.0.0-alpha.133) (2026-09-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.98
* **@lunora/x402:** upgraded to 1.0.0-alpha.66

## @lunora/mcp [1.0.0-alpha.132](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.131...@lunora/mcp@1.0.0-alpha.132) (2026-09-10)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.97
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.63
* **@lunora/x402:** upgraded to 1.0.0-alpha.65

## @lunora/mcp [1.0.0-alpha.131](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.130...@lunora/mcp@1.0.0-alpha.131) (2026-09-10)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.96
* **@lunora/x402:** upgraded to 1.0.0-alpha.64

## @lunora/mcp [1.0.0-alpha.130](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.129...@lunora/mcp@1.0.0-alpha.130) (2026-09-08)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.95
* **@lunora/x402:** upgraded to 1.0.0-alpha.63

## @lunora/mcp [1.0.0-alpha.129](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.128...@lunora/mcp@1.0.0-alpha.129) (2026-09-08)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.94
* **@lunora/x402:** upgraded to 1.0.0-alpha.62

## @lunora/mcp [1.0.0-alpha.128](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.127...@lunora/mcp@1.0.0-alpha.128) (2026-09-08)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.93
* **@lunora/x402:** upgraded to 1.0.0-alpha.61

## @lunora/mcp [1.0.0-alpha.127](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.126...@lunora/mcp@1.0.0-alpha.127) (2026-09-08)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.92
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.62
* **@lunora/x402:** upgraded to 1.0.0-alpha.60

## @lunora/mcp [1.0.0-alpha.126](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.125...@lunora/mcp@1.0.0-alpha.126) (2026-09-08)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.91
* **@lunora/x402:** upgraded to 1.0.0-alpha.59

## @lunora/mcp [1.0.0-alpha.125](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.124...@lunora/mcp@1.0.0-alpha.125) (2026-09-08)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.90
* **@lunora/x402:** upgraded to 1.0.0-alpha.58

## @lunora/mcp [1.0.0-alpha.124](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.123...@lunora/mcp@1.0.0-alpha.124) (2026-09-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.89
* **@lunora/x402:** upgraded to 1.0.0-alpha.57

## @lunora/mcp [1.0.0-alpha.123](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.122...@lunora/mcp@1.0.0-alpha.123) (2026-09-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.88
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.61

## @lunora/mcp [1.0.0-alpha.122](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.121...@lunora/mcp@1.0.0-alpha.122) (2026-09-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.87
* **@lunora/errors:** upgraded to 1.0.0-alpha.35
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.60
* **@lunora/x402:** upgraded to 1.0.0-alpha.56

## @lunora/mcp [1.0.0-alpha.121](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.120...@lunora/mcp@1.0.0-alpha.121) (2026-09-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.86

## @lunora/mcp [1.0.0-alpha.120](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.119...@lunora/mcp@1.0.0-alpha.120) (2026-09-06)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.85

## @lunora/mcp [1.0.0-alpha.119](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.118...@lunora/mcp@1.0.0-alpha.119) (2026-09-06)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.84

## @lunora/mcp [1.0.0-alpha.118](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.117...@lunora/mcp@1.0.0-alpha.118) (2026-09-06)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.83
* **@lunora/x402:** upgraded to 1.0.0-alpha.55

## @lunora/mcp [1.0.0-alpha.117](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.116...@lunora/mcp@1.0.0-alpha.117) (2026-09-06)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.82
* **@lunora/errors:** upgraded to 1.0.0-alpha.33
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.58
* **@lunora/x402:** upgraded to 1.0.0-alpha.53

## @lunora/mcp [1.0.0-alpha.116](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.115...@lunora/mcp@1.0.0-alpha.116) (2026-09-05)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.81
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.57

## @lunora/mcp [1.0.0-alpha.115](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.114...@lunora/mcp@1.0.0-alpha.115) (2026-09-05)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.80

## @lunora/mcp [1.0.0-alpha.114](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.113...@lunora/mcp@1.0.0-alpha.114) (2026-09-05)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.79
* **@lunora/errors:** upgraded to 1.0.0-alpha.32
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.56
* **@lunora/x402:** upgraded to 1.0.0-alpha.52

## @lunora/mcp [1.0.0-alpha.113](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.112...@lunora/mcp@1.0.0-alpha.113) (2026-09-05)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.78

## @lunora/mcp [1.0.0-alpha.112](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.111...@lunora/mcp@1.0.0-alpha.112) (2026-09-04)

### ⚠ BREAKING CHANGES

* `@lunora/config/cloudflare` exports `mergeWranglerEnvironment`,
and `WranglerConfig["placement"]` gains `region` / `host` / `hostname`.

Declined: D6 — `triggers` and `compatibility_date` are both `inheritable` in
wrangler, so the top-level write is correct for every environment that does not
override them, and the bindings reconciler already prints the top-level-only
advisory on the same run. D7 is inert until a second toolchain driver exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent,mcp): close the traversal, retry-storm and prototype-lookup gaps

The MCP documentation corpus is exposed twice — as tools and as resources — and only the tool
path applied the URL guard. `lunora_get_doc` normalises the model-supplied `url` and rejects `..`,
`%2e%2e`, `%252e` and backslashes; `resources/read` stripped the `lunora-docs:` prefix and handed
the remainder straight to the index, which appends it to `/llms.mdx` and fetches. Both
`lunora-docs:/../../admin/secrets` and its percent-encoded form resolved to
`https://<docs-origin>/admin/secrets` and returned that page as documentation. The hosted docs
site is unaffected (its index is a slug map); the local server pointed at a self-hosted
`--docs-url` — the internal-host case the guard's own docblock names — is not. `read` now routes
through the tool's `normalizeDocUrl` rather than repeating its checks, so the two callers cannot
drift apart again.

The loop's "invalid input, let the model recover" branch never fired for a batteries-included
tool. A bare `jsonSchema()` carries no validator, and the AI SDK's `safeValidateTypes` returns
success unchanged when `validate == null`, so a wrong-typed model argument was never marked
`invalid`: it reached `execute`, the dispatched function answered 400, and that threw inside the
loop's native `step.do`, which knows nothing of `isDeterministicDispatchFailure` and retried the
same deterministic 400 until the run failed. The tool step now converts a branded deterministic
dispatch failure into a tool-result row the next turn can read, the way `@lunora/workflow`'s
`createRunStep` does; transient failures keep the host's retry. The `codeTool` documentation
claimed each step's input "is validated against that tool's own `inputSchema`" — it now says what
the check actually depends on.

A voice control frame was cast to the closed `VoiceClientFrame` union straight off `JSON.parse`,
and everything the tail did not recognise was treated as a text turn. So `{type:"x",text:…}`
skipped the 4 000-character bound (keyed on `type === "text"`) and reached the model measured only
against the 17 024-character raw-frame limit, while `{"type":"text"}` read `.length` off
`undefined`. Frames are now narrowed by a real predicate and an unknown one is refused before the
thread round-trip and the session-turn counter.

`codeTool` resolved model-supplied names with `in` and bare indexing, both of which walk the
prototype chain: a step naming `constructor`/`toString`/`__proto__` found a truthy non-tool and
died on `tool.execute is not a function` — a TypeError the host retries — instead of the
documented BAD_REQUEST, and `$from: "constructor"` handed a composed tool the `Object`
constructor as an argument. Both now use `Object.hasOwn`, matching `getPath` in the same file.

`approvalTimeout: 0` was accepted and clamped only from above, so `step.waitForEvent` elapsed
immediately and every human-in-the-loop tool was recorded as "approval timed out" and reported to
the model as a user rejection before a client could render the marker. Validated at declaration
time on the resolved milliseconds, so the string form and `NaN` are covered too.
* `defineAgent` now throws on an `approvalTimeout` that resolves to zero or less.
A tool call that fails with a deterministic dispatch error is persisted as a tool-result row and
the run continues, where it previously failed the run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(templates): make every scaffold deployable, and gate on it

Three templates could not be deployed at all from a fresh scaffold. None of it was visible to
any gate, because the template smoke matrix builds and typechecks but never tried to deploy.

analog: `main` pointed at Nitro's `cloudflare-module` output, which is a single
`export default createHandler(...)` — it re-exports nothing, and nitropack 2.13.4 has no hook that
appends named exports to it (`exports.cloudflare.ts` was fiction; zero hits across its `dist/`).
`wrangler deploy` rejected every scaffold with "Durable Objects … not exported in your entrypoint
file: ShardDO". Replaced with a root `worker.ts` wrapper re-exporting Nitro's handler plus
`ShardDO`, the shape the Nuxt template already uses, and deleted `exports.cloudflare.ts`.

astro: the composed entry was `src/worker.ts`, which `lunora deploy` treats as a SvelteKit-shaped
entry and passes to wrangler POSITIONALLY. The @astrojs/cloudflare adapter writes a deploy redirect
carrying `no_bundle: true`, so that positional was uploaded as the worker verbatim — 1.4 KiB of
untranspiled TypeScript, exit 0, binding table printed. Renamed to `src/server.ts` (matching
solid-v2), so the positional never fires and wrangler ships the adapter-built
`dist/server/entry.mjs` (17 modules) it was always meant to.

nuxt + analog: no `assets` binding. Nitro's Cloudflare runtime serves client assets only via
`env.ASSETS`, so SSR HTML rendered and every `/_nuxt/*` and `/assets/*` request 404'd. Bound each
preset's own `output.publicDir`.

next: `lunora verify|deploy|dev` probe the root `wrangler.jsonc` and require the SHARD binding, but
the root config was the OpenNext SSR worker, so a fresh scaffold failed `lunora verify`. Swapped the
two: the Lunora worker takes `wrangler.jsonc`, the SSR worker becomes `wrangler.opennext.jsonc`,
and every OpenNext command is passed `--config` (build, preview and deploy all accept it).

@lunora/astro only recognised `withLunora(` as the composition seam, so the scaffold's
`.buildFrameworkWorker(host)` — what every class-B template uses — warned "subscriptions will
silently 404" on every build of a correctly composed worker.
* the astro template's composed entry is `src/server.ts`, and `@lunora/astro`'s
default `serverEntry` follows it. The next template's `wrangler.lunora.jsonc` is now the root
`wrangler.jsonc` and its OpenNext config is `wrangler.opennext.jsonc`.

The gate: `scripts/template-build-smoke.sh` now runs each template's own deploy path as a
credential-free dry run and checks four things, because each defect above needs a different one —
the exit code catches analog, the emitted bundle catches astro (a `.ts` file in a worker bundle
means the entry was never transpiled), and the printed binding table catches the missing assets.
Templates that pass `validateWrangler: false` to the Vite plugin keep it; they are gated here at the
deploy boundary instead. Also fixes stale template docs: the nuxt and astro READMEs documented
loader files that do not exist, and the init picker called both single-worker templates "a
standalone Lunora worker".

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sdks): pin the codec behaviours the fixtures never asserted

The case list was not known to be complete, and where it was silent the ports
drifted silently. Enumerating the reference codec branch by branch — every tag,
every payload guard, every re-encode — against the fixtures turned up 58 behaviours
with no case that would fail if a port got them wrong, four of which were already
wrong in every port.

`sdks/README.md` now carries the derived coverage matrix: one row per reference
behaviour, the case that pins it, and for the five that stay unpinned the
measurement that says why.

Found by adding the cases first and recording which ports went red:

- A `set` never de-duplicated. The reference decodes into a real `Set`, so its
  items collapse under SameValueZero like map keys do; all eight carried both
  copies and re-encoded a set the reference cannot emit. Same identity helper,
  now applied to both.
- A duplicate map key replaced the stored KEY as well as its value.
  `Map.prototype.set` keeps the key it holds, so `[[0,"a"],[-0,"b"]]` re-encodes
  with the `0` it first held. Invisible until a signed zero collapsed onto an
  unsigned one; wrong in all eight.
- SameValueZero holds -0 equal to 0, and every port's number formatting kept the
  sign, so a signed zero was its own map key and its own set item.
- A `bigint` digit string was carried verbatim in rust and swift, where the
  reference canonicalises through `BigInt().toString()` — `"007"` re-encoded as
  `"007"`, and the two ends keyed one subscription two ways.
- rust narrowed a negative zero to i64 while building the encoded tree, so the
  stable key spelled it `0`. `stableStringify` reads that tree and has its own
  `-0` branch, so the narrowing handed `{ "a": -0.0 }` the cache key of
  `{ "a": 0 }`. It now stays f64, which spells `-0.0` on the wire where the
  reference spells `0` — the same number to every JSON reader, and the lesser of
  the two divergences the value model forces.

New cases that every port already satisfied are kept as regression pins and named
as such in the matrix: the eight untested typed-array constructors (their tables
were complete, which the paired misalignment rejections prove), the unknown-tag
re-escape, and twenty-one payload-slot rejections.

Deliberately not pinned, each measured: a lone surrogate in a stable key (ruby's
JSON parser rejects the fixture file outright, go's substitutes U+FFFD — neither
can carry the input, and neither can reach the value on a real wire); an `Error`
`name`/`message` that is not a string, where the reference is JS-accidentally
lenient; and `Error` own props carrying `__proto__`, which the reference's encode
side drops through the prototype setter its decode side guards against — a defect
to fix there rather than freeze into eight languages.

Two capability rows added for gaps the manifest may not hold, since it can only
require behaviour every port has: no port merges a row `delta` into a cached list
(all eight replace the value with the row-change envelope), and none handles the
`chunk` or `whisper` frames.

Executed cases, before -> after: python 98 -> 98, go 168 -> 226, ruby 77 -> 77,
rust 9 -> 9, swift 11 -> 11, java 331 -> 389, kotlin 336 -> 394, dart 82 -> 82.
The counters that did not move report suites, not fixture rows; the fixtures grew
from 62 to 108 wire cases and from 12 to 24 stable-key cases in every leg.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(protocol): guard __proto__ in the error branch of encodeWire

`encodeWire`'s `Error` branch built its props object with a plain
`properties[key] = …`, while its own plain-object branch and both decode
branches route `"__proto__"` through `Object.defineProperty`. For that one key
the assignment fires the prototype SETTER instead of creating an own property,
so `["$lunora.wire$","error","E","m",{"__proto__":{"p":1}}]` — which `decodeWire`
correctly reconstructs with `__proto__` as an own data property — re-encoded as
`{}`. The field was silently dropped on every re-encode, and the props object
itself came back wearing a wire-supplied prototype, which `JSON.stringify` hides.

The branch now uses the same `UNSAFE_KEY` guard as its three siblings, so the
one spelling is consistent across all four sites that rebuild a wire object. It
was the only unguarded write left in the file.

`protocol/fixtures/wire-codec.json` gains `error-proto-key`, the `error`-tag twin
of the existing `proto-key` case. All eight non-JS ports already passed it
unchanged — `__proto__` is an ordinary map key everywhere but JS — so this was a
reference-only defect, and the fixture now pins correct behaviour rather than the
bug. `packages/client/__tests__/wire-codec.test.ts` adds the pollution axis the
JSON round trip cannot see: the encoded props object must still have
`Object.prototype`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(cli,config,astro,d1): close nine scaffold, dev and parsing defects

`lunora init` followed a symlinked target. `cwd/<name>` was probed with `existsSync`, which
resolves the link, so a link pointing at an empty directory passed the emptiness check and
became the scaffold target: writes landed outside `cwd`, and the reset path — which empties a
pre-existing target back out — would delete files there the run never wrote. The target is now
probed with `lstat` and a symlink is refused. Every scaffold path routes through that one gate.

A scaffold that threw mid-copy left its partial writes behind. `copyTemplate` writes
sequentially, so an fs failure lands after earlier files are already on disk, and
`runInitCommand` rethrew with the target still there — the retry, with the cause fixed, was then
refused with "target directory not empty". The throw path now resets, and the copy marks the
target complete the moment it finishes, so a failure in the reporting that follows cannot delete
a project that was fully written.

The interactive checklist announced "Project initialized!" as soon as the copy task finished,
which is before the empty-template check can fail the run — an empty remote template printed
success and then exited 1. The header is now a neutral statement of what the tasks did; the one
success line still comes after the check.

`lunora dev --remote` snapshotted `wrangler.jsonc` into the temp config wrangler is spawned with
BEFORE provisioning the bindings the project's code implies, so the worker ran with a config one
binding short. Provisioning — and the target resolve — now happen ahead of the plan, which also
closes the window that could orphan the temp config.

`tuiTasks` waited unconditionally for the task chain to settle on its error path. The Ctrl-C
listener attaches in a layout effect while the chain starts in a passive one, so an interrupt in
between ended the app with nothing left to settle and the CLI hung forever. The wait is now
armed by the chain actually starting, and still covers an in-flight task.

The deploy preflight dereferenced `d1_databases` entries after only an `Array.isArray` check, so
`"d1_databases": [null]` threw a TypeError out of a gate instead of letting the validator report
the malformed config. Nullish entries are dropped at the one normalisation boundary the gates
read through.

`reconcileDurableObjects` replayed the `migrations` list without normalising it, so a stray
`null` record, rename entry or class name threw out of a step that runs on every dev-server
start. It now reuses the validator's own `objectBindingEntries` / `stringEntries`, which already
fold the identical hand-edited list.

`@lunora/astro`'s composition check scanned raw source, so a commented-out or quoted
`withLunora(...)` suppressed the "`/_lunora/*` will be unrouted" warning for an entry that
composed nothing. Comments and string literals are blanked before the probe runs; a template
literal's interpolations are kept, because those are real code.

The `CREATE TRIGGER` probe in `@lunora/d1` allowed only whitespace between the keywords, so
`CREATE /* comment */ TRIGGER` — which SQLite accepts — stopped reading as a trigger and its
body's first `;` was rejected as a second statement.

Reviewed and declined: `containers` stays in `NON_INHERITABLE_KEYS`. wrangler's own config
resolver registers it through `notInheritable(...)` with a `void 0` default, and warns that the
key "is not inherited by environments" — so resolving it to `undefined` for an environment that
omits it is exactly what wrangler does.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix: stop replays, transports and gates from dropping work silently

Six defects that all share a shape: something that looked handled was quietly discarded.

`step.do` memoizes BY NAME, and the tool step's name (`tool:<name>:<id>`) did not change when
its memoized value became an outcome envelope. A run parked across that deploy — approval
hibernation, a long multi-turn — resumes and is handed the OLD raw output back, which the new
code read as an envelope: the tool row persisted as `"undefined"` (poisoning every later turn
AND every later run on the thread) or, for a string/number/null memo, threw `Cannot use 'in'
operator`. The outcome now travels behind a wrapper key, and anything arriving without it is
read as the raw output it was. A distinct wrapper rather than probing the value: `{ ok: true }`
is an ordinary tool result, and a bare probe unwraps it to `true`.

The same tool path persisted a deterministic failure's text raw while the success path capped
it. `outcome.failed` is a server-supplied, unbounded message on a row re-rendered into every
later turn, so it is capped identically now.

The Python client synthesized an `INTERNAL` error envelope for an unreadable error body. That
routes through `parse_rpc_response` as a coded VERDICT, and `INTERNAL` is in neither
`TRANSIENT_ERROR_CODES` nor `RATE_LIMIT_ERROR_CODES` — so the offline queue settled the write
terminally. A 302 from a load balancer or a WAF's HTML page on a 4xx dropped a queued durable
write. Returning the status with no envelope restores the transport branch (`transient=True`)
that the other seven ports take. The redirect refusal itself is unchanged.

`mergeWranglerEnvironment` was exported without its return type, so a consumer could call it
but not name its result. `WranglerEnvironmentMerge` is exported now, and the CLI's composed
worker entry imports `COMPOSED_WORKER_ENTRY` instead of repeating the literal a docblock asked
it to keep in sync by hand.

`.gitignore` appends land BELOW what the file already had and git takes the last match, so
adding `.dev.vars.*` under an existing `!.dev.vars.example` re-ignored a file the templates
ship. Both writers — `lunora deploy`'s secret guard and the `lunora init` overlay — now
re-state their negations after the additions.

The template smoke matrix's TypeScript-in-bundle gate ran `find` on a directory it never
checked existed. `find` exits 1 there, `pipefail` carries it through `head`, and because both
call sites are `if ! run_deploy_dryrun …` — which suppresses errexit — the gate passed
VACUOUSLY on the one run where no bundle was emitted. It now fails with a reason.
* `@lunora/astro`'s `lunora()` integration defaults `serverEntry` to
`src/server.ts`, not `src/worker.ts`. A project on the old name and no explicit `serverEntry`
warned "not found" on every build; it now gets a warning naming the rename, why the old path
is unsafe for Astro (`lunora deploy` passes it to wrangler positionally, and the adapter
redirect's `no_bundle` then uploads it untranspiled), and the option that keeps the old name.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* make every template deployable, and close the SDK, deploy and adapter gaps ([#591](https://github.com/anolilab/lunora/issues/591)) ([2630283](https://github.com/anolilab/lunora/commit/26302835bdd4b02dccbed5e8e6e7b8705ff4f155))

## @lunora/mcp [1.0.0-alpha.111](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.110...@lunora/mcp@1.0.0-alpha.111) (2026-09-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.76

## @lunora/mcp [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.109...@lunora/mcp@1.0.0-alpha.110) (2026-09-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.75
* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.55
* **@lunora/x402:** upgraded to 1.0.0-alpha.51

## @lunora/mcp [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.108...@lunora/mcp@1.0.0-alpha.109) (2026-09-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.74

## @lunora/mcp [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.107...@lunora/mcp@1.0.0-alpha.108) (2026-09-03)

### ⚠ BREAKING CHANGES

* `SubscriptionStore` requires `deleteOwned(id, userId)`. Both
shipped stores implement it; an external store must make the predicate and the
removal atomic rather than reintroduce the read-then-write race. Seeding a
`.unique()` self-referencing column into a non-empty table is now refused.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* close twelve review findings, three fail-open ([#587](https://github.com/anolilab/lunora/issues/587)) ([74c2ac0](https://github.com/anolilab/lunora/commit/74c2ac0028a77c357870ca120e0b76d65627581e))

## @lunora/mcp [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.106...@lunora/mcp@1.0.0-alpha.107) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.73
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.54
* **@lunora/x402:** upgraded to 1.0.0-alpha.50

## @lunora/mcp [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.105...@lunora/mcp@1.0.0-alpha.106) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.72
* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.53
* **@lunora/x402:** upgraded to 1.0.0-alpha.49

## @lunora/mcp [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.104...@lunora/mcp@1.0.0-alpha.105) (2026-09-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.71
* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.52
* **@lunora/x402:** upgraded to 1.0.0-alpha.48

## @lunora/mcp [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.103...@lunora/mcp@1.0.0-alpha.104) (2026-09-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.70
* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.51
* **@lunora/x402:** upgraded to 1.0.0-alpha.47

## @lunora/mcp [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.102...@lunora/mcp@1.0.0-alpha.103) (2026-09-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.69
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.50

## @lunora/mcp [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.101...@lunora/mcp@1.0.0-alpha.102) (2026-09-01)

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

### Bug Fixes

* close the round-2 package audit findings across registry, protocol, client and CI ([#539](https://github.com/anolilab/lunora/issues/539)) ([e3dd702](https://github.com/anolilab/lunora/commit/e3dd70282af1aff606fe03a4ebd29c33d0029ce5)), closes [#540](https://github.com/anolilab/lunora/issues/540)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.68
* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.49
* **@lunora/x402:** upgraded to 1.0.0-alpha.46

## @lunora/mcp [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.100...@lunora/mcp@1.0.0-alpha.101) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.67
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.48
* **@lunora/x402:** upgraded to 1.0.0-alpha.45

## @lunora/mcp [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.99...@lunora/mcp@1.0.0-alpha.100) (2026-08-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.66

## @lunora/mcp [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.98...@lunora/mcp@1.0.0-alpha.99) (2026-08-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.65

## @lunora/mcp [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.97...@lunora/mcp@1.0.0-alpha.98) (2026-08-29)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.64

## @lunora/mcp [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.96...@lunora/mcp@1.0.0-alpha.97) (2026-08-29)

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

* **@lunora/client:** upgraded to 1.0.0-alpha.63
* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.47
* **@lunora/x402:** upgraded to 1.0.0-alpha.44

## @lunora/mcp [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.95...@lunora/mcp@1.0.0-alpha.96) (2026-08-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.62

## @lunora/mcp [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.94...@lunora/mcp@1.0.0-alpha.95) (2026-08-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.61
* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.46
* **@lunora/x402:** upgraded to 1.0.0-alpha.43

## @lunora/mcp [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.93...@lunora/mcp@1.0.0-alpha.94) (2026-08-28)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.45

## @lunora/mcp [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.92...@lunora/mcp@1.0.0-alpha.93) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.44

## @lunora/mcp [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.91...@lunora/mcp@1.0.0-alpha.92) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.43

## @lunora/mcp [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.90...@lunora/mcp@1.0.0-alpha.91) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.42

## @lunora/mcp [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.89...@lunora/mcp@1.0.0-alpha.90) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.60

## @lunora/mcp [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.88...@lunora/mcp@1.0.0-alpha.89) (2026-08-26)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.41

## @lunora/mcp [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.87...@lunora/mcp@1.0.0-alpha.88) (2026-08-26)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.40

## @lunora/mcp [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.86...@lunora/mcp@1.0.0-alpha.87) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.59
* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.39
* **@lunora/x402:** upgraded to 1.0.0-alpha.42

## @lunora/mcp [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.85...@lunora/mcp@1.0.0-alpha.86) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.58
* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.38
* **@lunora/x402:** upgraded to 1.0.0-alpha.41

## @lunora/mcp [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.84...@lunora/mcp@1.0.0-alpha.85) (2026-08-25)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.37

## @lunora/mcp [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.83...@lunora/mcp@1.0.0-alpha.84) (2026-08-25)

### ⚠ BREAKING CHANGES

* **runtime:** `serveStorageObject`'s structural storage parameter now
requires `head` alongside `download`. `@lunora/storage` provides it (with
its own fallback to a 0-length ranged `get()` on a binding with no HEAD);
a hand-rolled double must add it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* refactor(shared): extract memoizePromise, stop poisoning the HMAC key cache

Three lazily-built async singletons had each hand-rolled the same keyed
memo: look the key up, store the PROMISE so concurrent callers coalesce
onto one run, drop the entry if it rejects. `shared/promise-memo.ts` is
the one definition; `@lunora/mcp`'s per-tool charge middleware,
`@lunora/x402`'s per-procedure one, and the per-secret HMAC key cache now
use it.

It also fixes two bugs the copies had between them.

`shared/hmac-url.ts` never evicted on rejection at all, so a single failed
`crypto.subtle.importKey` stayed in the map and every later verify against
that secret was served the original failure for the isolate's whole life.

The two that did evict deleted whatever sat under the key at rejection
time, not necessarily their own entry. A slow first attempt failing after
a healthy retry had taken the slot would delete that retry. The shared
helper compares identity before deleting, so an entry can only ever evict
itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* feat(runtime): store the declared REST cache policy at the edge

`.expose({ rest: true, cache })` emitted `Cache-Control` and `Vary` and
stopped there. A response a Worker GENERATES is not stored by the colo
cache on its own, so the declared policy bought browser revalidation and
nothing else — every request still paid a shard dispatch. `caches.default`
was used exactly zero times in the repo.

`rest-edge-cache` adds the missing half: a `match` before dispatch and a
`waitUntil`-deferred `put` after, wrapped in the guards that make storing
a procedure-backed response safe rather than a cross-user leak.

- Only a genuinely anonymous, effective-`public` exchange is stored,
  reusing the credential check the header path already applies. A
  declared-`private` policy is never stored: it is caller-specific by
  definition and this cache is shared by everyone hitting the colo.
- `Vary` is enforced in the KEY. Cloudflare's cache honours `Vary` for
  `Accept-Encoding` only, so a body that varies on `x-lunora-shard-key`
  would otherwise be handed to a caller with a different key. Every
  varying header's value is folded into the stored URL, which turns the
  hazard into a miss.
- The lookup runs after the rate-limit gate, the order a CDN uses: a hit
  still costs a Worker invocation and is still the caller's request, so it
  is metered — it just skips the shard.
- A cache read or write that rejects is treated as a miss, never as a
  failed request.

`@lunora/platform` gains the `HttpCacheLike` contract and rates `httpCache`
in both matrices: `native` on Cloudflare, `unsupported` on Node, where the
surface degrades to emitting `Cache-Control` alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* fix(runtime): let createWorker reach the REST edge cache, and test the wiring

`buildRestRoutes` took an `edgeCache` dep that `createWorker` never
forwarded, so the documented opt-out was unreachable for anyone going
through the normal entry point — and nothing could inject a double either,
which is why the gap survived review. `restEdgeCache` now plumbs through,
mirroring `restRateLimit`. It is forwarded when PRESENT rather than when
truthy, since `null` is the meaningful opt-out value.

The unit tests covered `rest-edge-cache`'s store/lookup decisions in
isolation but nothing exercised what the route does with them. Added, at
the `createWorker` level where a shard spy can count dispatches:

- a second identical request is served from the cache with NO second shard
  dispatch (this is the whole feature, and it was unasserted)
- a credentialed caller stores nothing and dispatches every time
- the rate-limit gate is consulted BEFORE the cache, so a warm entry does
  not hand a limited caller a free body
- `restEdgeCache: null` keeps the declared `Cache-Control` on the wire
  while storing nothing
- an endpoint with no declared policy is never stored

Plus `defaultHttpCache` (absent `caches`, present, and a throwing accessor),
and one for `serveStorageObject`'s 206 headers coming from the head rather
than the ranged read — a deliberate choice that no test pinned, so nothing
would have caught it flipping.

Each new assertion was mutation-checked: reverting the plumbing, moving the
lookup ahead of the limiter, and swapping the 206 header source each fail
exactly the test that claims to cover them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* fix(runtime): keep paid and per-caller responses out of the edge cache

The edge cache sat upstream of the x402 charge gate, which runs inside
`invokeExposed`. A hit returned before dispatch, so it ran neither the
challenge nor the settlement — and `x-payment` was in no credential list,
so a payer read as anonymous and their 200 was stored. Every later caller
in that colo got the paid body free, together with the payer's
`X-PAYMENT-RESPONSE` receipt, for the whole `maxAge`.

`x-payment` is now a credential header, so a paid exchange is `private` on
the header path and unstorable on the cache path by the same derivation. A
response carrying a settlement receipt is refused separately — a second
lock on a money path.

That derivation is now singular. `effectiveRestScope` is the one answer to
"may a shared cache have this", called by both halves; the store no longer
re-derives scope and credentials for itself, where gaining a credential
source on one side alone would have silently stored a per-caller body.

Also closed, all of them reachable without an attacker:

- `__lunora_vary` was documented as reserved but nothing reserved it. It
  reached the procedure as an argument while `set` overwrote it in the key,
  making it the one query key a caller could vary without varying the key.
  It is now excluded from args and deleted before the key is built.
- A shard response's `x-d1-bookmark` / `x-lunora-shard-key` were stored and
  replayed, so a caller holding a newer bookmark could adopt a stale one and
  lose read-your-writes. Both are dropped from the stored copy.
- `applyRestCache` merges the procedure's own `Vary` into the emitted
  header, but the key folds only the policy's names, so a response could
  advertise more than the key fenced. Storing now requires the advertised
  set to be fenced; `Vary: *` never stores.
- The store path evaluated the key and `clone()` as arguments, outside its
  `.catch`. A policy with a malformed `vary` (`"Accept Language"`) made
  `Headers.get` throw and turned every request to that endpoint into a 500 —
  for a policy that emitted a valid `Vary` header before. Both paths now
  degrade to a miss, as the read path already did.
- `X-Lunora-Edge-Cache` is CORS-exposed, so the browser clients the docs
  point at it can actually read it.

Structurally, the two `undefined`-threading functions become one per-route
builder: what a policy decides on its own is decided once at construction,
and a route that can never edge-cache has no cache code path at all. Only
the cache handle stays late-bound, since `caches.default` cannot be read at
construction time in workerd. The seven exports with no consumers are gone
from the package surface rather than frozen in two snapshots.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

* fix(storage): make head serializable, declared, and stubbed

Three ways the new body-free read did not survive contact with a caller.

`head()` returned `download()`'s `withSha256` Proxy. That Proxy exists to
keep R2's native body accessors alive, and its own docblock says why it must
not be used for a body-free read: a Proxy over a non-extensible host object
cannot advertise the synthetic checksum fields as own keys, so
`JSON.stringify` drops them. A head result is exactly what a query returns,
so `sha256`/`sha256Base64` vanished on the wire. It now uses the same
`toListObject` projection `list()` does. The test could not catch it — it
asserted by property access, which the get trap serves, against an
extensible object literal — so it now round-trips through JSON against a
`preventExtensions`'d double.

`ctx.storage.head` was documented in the capability table and the file-storage
guide but declared on neither `ReadOnlyStorage` nor `Storage`, so calling it
was a type error. It is declared now, returning `StorageObjectHead` — the
richer public mirror an HTTP layer needs, keeping the validator, the base64
digest and `uploaded` as a `Date`.

Codegen's `storageStub` did not list `head`, so an app with no storage
configured met `TypeError: context.storage.head is not a function` on any
ranged request instead of the "no storage configured" message every other
operation gives.

Separately: a `Range` that cannot produce a 206 anyway — absent, multi-range,
malformed — no longer pays for a metadata read it then discards, which also
closes the window where the object could vanish between the two reads and
turn a 200 into a 404. The full-object answer is decidable from the header
alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

* refactor(shared): bound memoizePromise by size, not by callback

`onInsert` was an extension point with one consumer, on a helper whose whole
justification is that three call sites were the same shape. The thing that
one consumer did with it — `evictOldestEntry(map, capacity)` — is what
`evict-oldest`'s contract already assumes: "every caller inserts exactly one
entry immediately after calling". A `maxEntries` bound makes that structural
instead of a promise each caller keeps, with no closure per call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

### Features

* **runtime:** store the declared REST cache policy at the edge ([#476](https://github.com/anolilab/lunora/issues/476)) ([9ababee](https://github.com/anolilab/lunora/commit/9ababeebc68cd74adfef5d923cfa9e1d70f0f690))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.36
* **@lunora/x402:** upgraded to 1.0.0-alpha.40

## @lunora/mcp [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.82...@lunora/mcp@1.0.0-alpha.83) (2026-08-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.57
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.35

## @lunora/mcp [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.81...@lunora/mcp@1.0.0-alpha.82) (2026-08-24)

### Features

* **auth:** upgrade better-auth to 1.7.1 and gate MCP on its OAuth ([#472](https://github.com/anolilab/lunora/issues/472)) ([7f17a35](https://github.com/anolilab/lunora/commit/7f17a35ba36d85163dd099e464a560b874190049))

## @lunora/mcp [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.80...@lunora/mcp@1.0.0-alpha.81) (2026-08-23)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.56
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.34
* **@lunora/x402:** upgraded to 1.0.0-alpha.39

## @lunora/mcp [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.79...@lunora/mcp@1.0.0-alpha.80) (2026-08-23)

### Bug Fixes

* **mcp:** reject encoded dot segments in docs urls ([#459](https://github.com/anolilab/lunora/issues/459)) ([c3f89de](https://github.com/anolilab/lunora/commit/c3f89de8067e2d253093826af6852febd419e690))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.55

## @lunora/mcp [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.78...@lunora/mcp@1.0.0-alpha.79) (2026-08-21)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.33

## @lunora/mcp [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.77...%40lunora%2Fmcp%401.0.0-alpha.78) (2026-08-19)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32

## @lunora/mcp [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.76...%40lunora%2Fmcp%401.0.0-alpha.77) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.54

## @lunora/mcp [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.75...%40lunora%2Fmcp%401.0.0-alpha.76) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.53
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31

## @lunora/mcp [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.74...%40lunora%2Fmcp%401.0.0-alpha.75) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30

## @lunora/mcp [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.73...%40lunora%2Fmcp%401.0.0-alpha.74) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.52

## @lunora/mcp [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.72...%40lunora%2Fmcp%401.0.0-alpha.73) (2026-08-15)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29

## @lunora/mcp [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.71...%40lunora%2Fmcp%401.0.0-alpha.72) (2026-08-14)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.51
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28
* **@lunora/x402:** upgraded to 1.0.0-alpha.38

## @lunora/mcp [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.70...%40lunora%2Fmcp%401.0.0-alpha.71) (2026-08-12)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.50
* **@lunora/x402:** upgraded to 1.0.0-alpha.37

## @lunora/mcp [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.69...%40lunora%2Fmcp%401.0.0-alpha.70) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.49
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27

## @lunora/mcp [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.68...%40lunora%2Fmcp%401.0.0-alpha.69) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.48
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26

## @lunora/mcp [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.67...%40lunora%2Fmcp%401.0.0-alpha.68) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.47
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25
* **@lunora/x402:** upgraded to 1.0.0-alpha.36

## @lunora/mcp [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.66...%40lunora%2Fmcp%401.0.0-alpha.67) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24

## @lunora/mcp [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.65...%40lunora%2Fmcp%401.0.0-alpha.66) (2026-08-10)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.46
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23

## @lunora/mcp [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.64...%40lunora%2Fmcp%401.0.0-alpha.65) (2026-08-09)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.45
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20
* **@lunora/x402:** upgraded to 1.0.0-alpha.34

## @lunora/mcp [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.63...%40lunora%2Fmcp%401.0.0-alpha.64) (2026-08-09)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.19

## @lunora/mcp [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.62...%40lunora%2Fmcp%401.0.0-alpha.63) (2026-08-09)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18
* **@lunora/x402:** upgraded to 1.0.0-alpha.33

## @lunora/mcp [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.61...%40lunora%2Fmcp%401.0.0-alpha.62) (2026-08-08)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17

## @lunora/mcp [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.60...%40lunora%2Fmcp%401.0.0-alpha.61) (2026-08-08)

## @lunora/mcp [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.59...%40lunora%2Fmcp%401.0.0-alpha.60) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.43
* **@lunora/x402:** upgraded to 1.0.0-alpha.32

## @lunora/mcp [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.58...%40lunora%2Fmcp%401.0.0-alpha.59) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.42
* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/x402:** upgraded to 1.0.0-alpha.31

## @lunora/mcp [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.57...%40lunora%2Fmcp%401.0.0-alpha.58) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.41
* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/x402:** upgraded to 1.0.0-alpha.30

## @lunora/mcp [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.56...%40lunora%2Fmcp%401.0.0-alpha.57) (2026-08-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.40
* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/x402:** upgraded to 1.0.0-alpha.29

## @lunora/mcp [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.55...%40lunora%2Fmcp%401.0.0-alpha.56) (2026-08-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.39

## @lunora/mcp [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.54...%40lunora%2Fmcp%401.0.0-alpha.55) (2026-08-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.38
* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/x402:** upgraded to 1.0.0-alpha.28

## @lunora/mcp [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.53...%40lunora%2Fmcp%401.0.0-alpha.54) (2026-08-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.37

## @lunora/mcp [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.52...%40lunora%2Fmcp%401.0.0-alpha.53) (2026-08-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.36

## @lunora/mcp [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.51...%40lunora%2Fmcp%401.0.0-alpha.52) (2026-07-31)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.35

## @lunora/mcp [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.50...%40lunora%2Fmcp%401.0.0-alpha.51) (2026-07-31)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/x402:** upgraded to 1.0.0-alpha.25

## @lunora/mcp [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.49...%40lunora%2Fmcp%401.0.0-alpha.50) (2026-07-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.33

## @lunora/mcp [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.48...%40lunora%2Fmcp%401.0.0-alpha.49) (2026-07-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.32
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/x402:** upgraded to 1.0.0-alpha.24

## @lunora/mcp [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.47...%40lunora%2Fmcp%401.0.0-alpha.48) (2026-07-28)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.23

## @lunora/mcp [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.46...%40lunora%2Fmcp%401.0.0-alpha.47) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.22

## @lunora/mcp [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.45...%40lunora%2Fmcp%401.0.0-alpha.46) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.21

## @lunora/mcp [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.44...%40lunora%2Fmcp%401.0.0-alpha.45) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.20

## @lunora/mcp [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.43...%40lunora%2Fmcp%401.0.0-alpha.44) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.19

## @lunora/mcp [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.42...%40lunora%2Fmcp%401.0.0-alpha.43) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.18

## @lunora/mcp [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.41...%40lunora%2Fmcp%401.0.0-alpha.42) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.17

## @lunora/mcp [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.40...%40lunora%2Fmcp%401.0.0-alpha.41) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.16

## @lunora/mcp [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.39...%40lunora%2Fmcp%401.0.0-alpha.40) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.15

## @lunora/mcp [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.38...%40lunora%2Fmcp%401.0.0-alpha.39) (2026-07-27)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.14

## @lunora/mcp [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.37...%40lunora%2Fmcp%401.0.0-alpha.38) (2026-07-26)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.13

## @lunora/mcp [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.36...%40lunora%2Fmcp%401.0.0-alpha.37) (2026-07-26)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.12

## @lunora/mcp [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.35...%40lunora%2Fmcp%401.0.0-alpha.36) (2026-07-26)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.11

## @lunora/mcp [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.34...%40lunora%2Fmcp%401.0.0-alpha.35) (2026-07-26)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.10

## @lunora/mcp [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.33...%40lunora%2Fmcp%401.0.0-alpha.34) (2026-07-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.31
* **@lunora/x402:** upgraded to 1.0.0-alpha.9

## @lunora/mcp [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.32...%40lunora%2Fmcp%401.0.0-alpha.33) (2026-07-26)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.8

## @lunora/mcp [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.31...%40lunora%2Fmcp%401.0.0-alpha.32) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.30
* **@lunora/x402:** upgraded to 1.0.0-alpha.7

## @lunora/mcp [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.30...%40lunora%2Fmcp%401.0.0-alpha.31) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.29

## @lunora/mcp [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.29...%40lunora%2Fmcp%401.0.0-alpha.30) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.28
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/x402:** upgraded to 1.0.0-alpha.6

## @lunora/mcp [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.28...%40lunora%2Fmcp%401.0.0-alpha.29) (2026-07-23)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.27

## @lunora/mcp [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.27...%40lunora%2Fmcp%401.0.0-alpha.28) (2026-07-21)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.26

## @lunora/mcp [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.26...%40lunora%2Fmcp%401.0.0-alpha.27) (2026-07-20)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.25
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/x402:** upgraded to 1.0.0-alpha.5

## @lunora/mcp [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.25...%40lunora%2Fmcp%401.0.0-alpha.26) (2026-07-19)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.24
* **@lunora/x402:** upgraded to 1.0.0-alpha.4

## @lunora/mcp [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.24...%40lunora%2Fmcp%401.0.0-alpha.25) (2026-07-17)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.23
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/x402:** upgraded to 1.0.0-alpha.3

## @lunora/mcp [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.23...%40lunora%2Fmcp%401.0.0-alpha.24) (2026-07-13)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.22

## @lunora/mcp [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.22...%40lunora%2Fmcp%401.0.0-alpha.23) (2026-07-13)

## @lunora/mcp [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.21...%40lunora%2Fmcp%401.0.0-alpha.22) (2026-07-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.21
* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/x402:** upgraded to 1.0.0-alpha.2

## @lunora/mcp [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.20...%40lunora%2Fmcp%401.0.0-alpha.21) (2026-07-10)


### Dependencies

* **@lunora/x402:** upgraded to 1.0.0-alpha.1

## @lunora/mcp [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.19...%40lunora%2Fmcp%401.0.0-alpha.20) (2026-07-08)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.20
* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/mcp [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.18...%40lunora%2Fmcp%401.0.0-alpha.19) (2026-07-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.19
* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/mcp [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.17...%40lunora%2Fmcp%401.0.0-alpha.18) (2026-07-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.18

## @lunora/mcp [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.16...%40lunora%2Fmcp%401.0.0-alpha.17) (2026-07-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.17
* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/mcp [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.15...%40lunora%2Fmcp%401.0.0-alpha.16) (2026-07-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.16

## @lunora/mcp [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.14...%40lunora%2Fmcp%401.0.0-alpha.15) (2026-07-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.15

## @lunora/mcp [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.13...%40lunora%2Fmcp%401.0.0-alpha.14) (2026-07-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.14

## @lunora/mcp [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.12...%40lunora%2Fmcp%401.0.0-alpha.13) (2026-07-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.13

## @lunora/mcp [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.11...%40lunora%2Fmcp%401.0.0-alpha.12) (2026-07-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.12

## @lunora/mcp [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.10...%40lunora%2Fmcp%401.0.0-alpha.11) (2026-07-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.11

## @lunora/mcp [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.9...%40lunora%2Fmcp%401.0.0-alpha.10) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.10

## @lunora/mcp [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.8...%40lunora%2Fmcp%401.0.0-alpha.9) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.9

## @lunora/mcp [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.7...%40lunora%2Fmcp%401.0.0-alpha.8) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.8

## @lunora/mcp [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.6...%40lunora%2Fmcp%401.0.0-alpha.7) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.7

## @lunora/mcp [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.5...%40lunora%2Fmcp%401.0.0-alpha.6) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.6

## @lunora/mcp [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.4...%40lunora%2Fmcp%401.0.0-alpha.5) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.5

## @lunora/mcp [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fmcp%401.0.0-alpha.3...%40lunora%2Fmcp%401.0.0-alpha.4) (2026-06-29)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.4

## @lunora/mcp [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.2...@lunora/mcp@1.0.0-alpha.3) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.3

## @lunora/mcp [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/mcp@1.0.0-alpha.1...@lunora/mcp@1.0.0-alpha.2) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.2

## @lunora/mcp 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.1
