# Plan 307 — `lunora doctor` emits a stable machine-readable report

**Baseline:** `370994075` (2026-08-08)
**Status:** DONE (branch `feat/plan-307-doctor-json`)

## 0. Headline finding

`lunora doctor` is the only project-preflight command with **no options at all**
(`packages/cli/src/commands/doctor/index.ts:19` — `options: []`) and findings
that carry **no identifier** (`Finding` is `{ level, message, fix? }`,
`handler.ts:17-23`). Every other gate in the CLI — `deploy`, `verify`, `build`,
`logs`, `codegen`, `insights` — already takes `--format json`. So the one
command whose entire job is "tell me what is wrong with this project" is the one
an agent or CI job cannot consume: it must scrape prose from stderr, and the
prose is not a contract.

## 1. Current state (audit)

- `runDoctor` (`handler.ts:401-420`) runs 8 checks and returns
  `{ code, findings }`; `code` is 1 iff any finding is `fail`.
- `execute` (`handler.ts:456-462`) calls `renderReport`, which prints
  `[FAIL] <message>` / `fix: <hint>` lines through the logger. Nothing else is
  emitted; `DoctorResult` never leaves the process.
- The 8 checks are `checkWrangler`, `checkD1Placeholders`,
  `checkEmailDestination`, `checkDevVariables`, `checkAdminToken`,
  `checkVersionSkew`, `checkVectorMetadataIndexes`, `checkDeclaredExports`
  (`handler.ts:70`, `:131`, `:154`, `:177`, `:206`, `:318`, `:106`, `:233`).
  Between them they push ~20 distinct findings, each identified only by its
  English sentence.
- `checkVersionSkew` (`handler.ts:318`) already detects **dependency** version
  drift across `@lunora/*` + `lunorash`. It does not detect the _other_ skew
  that bites in practice: a globally-installed `lunora` binary shadowing the
  project's pinned one, so the report describes a project the running CLI is not
  the right version for.
- No check has a fix that the command can apply itself; `fix` is always prose
  for a human to execute.

## 2. Existing seams (do not reinvent)

- **`packages/cli/src/util/output-format.ts:46`** — `validateOutputFormat`,
  `isJsonFormat`, `loggerForFormat`, `printJson`. This is the whole `--format
json` contract, already used by `deploy` (`deploy/handler.ts:1384-1400`):
  validate the flag, route human logging to stderr, print exactly one JSON
  document to stdout. Reuse it verbatim — do not invent a second JSON path.
- **`runDoctor`** is already a pure, logger-free core returning a structured
  result. The only change it needs is a field per finding; the rendering split
  is already correct.
- **`packages/cli/src/util/logger.ts`** — the `Logger` interface `renderReport`
  writes through.
- `TARGET_OPTION` (`packages/cli/src/util/deploy-target.ts`) if the checks ever
  need to differ per platform target; not required by this plan.

## 3. The behavioural contract to preserve

- Exit code stays 1 iff any finding is `fail`, 0 otherwise — in both formats.
- Default (`pretty`) output is byte-identical to today. This plan adds a format,
  it does not restyle the existing report.
- `--format json` puts **exactly one** JSON document on stdout and nothing else;
  all progress/human text goes to stderr (the rule `deploy` already follows).
- `runDoctor` stays pure and exported (`handler.ts:464`) — the doctor core is
  consumed by tests directly and must not gain a logger dependency.

## 4. Design decisions

- **A `code` field on `Finding`, not a code table keyed by message.** Chosen
  over deriving stable ids from message text (fragile: a copy-edit silently
  renames a diagnostic) and over a central registry object (a second place to
  forget to update). The code lives at the push site, next to the message it
  names.
- **`kebab-case` string codes namespaced by check** (`wrangler-missing`,
  `d1-placeholder-id`, `dev-vars-missing-secret`, `version-skew-cores`, …),
  not numbers. Numbers imply an ordering and get renumbered; strings survive
  reordering and read in a diff.
- **Codes are a public contract, snapshot-tested.** A committed fixture listing
  every code the doctor can emit, asserted by a test. Chosen over documenting
  them in Markdown only — prose drifts, a failing test does not. This is what
  makes the codes safe for an agent to branch on.
- **No `--fix` in this plan.** Applying fixes means writing to `wrangler.jsonc`
  and `.dev.vars`, which `lunora add` / `env generate` / `init` already own.
  Deferred as an open question rather than half-built here.
- **CLI-shadow detection is a new check, not an extension of
  `checkVersionSkew`.** Different failure (wrong binary vs wrong dependency
  tree), different fix, so it gets its own code and its own function.

## 5. Workstreams

**S — `Finding.code`.** Add a required `code: string` to `Finding`
(`handler.ts:17`); fill it at all ~20 push sites. Type-level: make it a union of
the literal codes so a typo fails `lint:types` rather than shipping.

**Done.** 17 codes in a `DOCTOR_CODES` `as const` array; `DoctorCode` is
`(typeof DOCTOR_CODES)[number]`, so the union has exactly one source. Filled at
all 16 pre-existing push sites plus the new `cli-shadowed`.

**S — `--format json`.** Declare the option in `doctor/index.ts` (copy the
description string from `deploy/index.ts`), thread it through `execute`, and
gate `renderReport` behind `isJsonFormat`. Document shape:

```jsonc
{
    "ok": false,
    "code": 1,
    "summary": { "fail": 1, "warn": 2, "info": 3, "pass": 4 },
    "findings": [{ "code": "d1-placeholder-id", "level": "fail", "message": "…", "fix": "…" }],
}
```

`ok` is redundant with `code` on purpose — it is the field a shell-free consumer
reaches for first.

**Done.** `ok` and `summary` were added to `DoctorResult` itself rather than to
a second JSON-only type — one shape means `printJson(result)` needs no mapping
layer, and `renderReport`'s summary line now reads `result.summary` instead of
re-filtering the findings. The format plumbing follows `verify` exactly: an
exported `runDoctorCommand({ cwd, format, logger })` validates the flag, picks
the logger via `loggerForFormat`, renders, then `printJson` in json mode;
`execute` is a three-line wrapper. Rendering happens in **both** formats — in
json mode it lands on stderr, which is what makes the phase-1 gate assertable.

**S — code snapshot test.** A test that collects every code from the union type
(or a `DOCTOR_CODES` const the union derives from) and asserts it against a
committed sorted list. Adding a code is then a deliberate one-line fixture
update; removing or renaming one fails loudly.

**Done, with one deviation.** The committed fixture _is the docs table_ — the
test parses the code column out of `packages/cli/docs/index.mdx` and asserts it
equals `DOCTOR_CODES`. A separate fixture file would have made three artefacts
to keep in step (const, fixture, docs table) where the plan explicitly wanted
two; asserting the docs directly collapses it to two and makes the docs the
thing that fails, which is the one that was going to rot. A second test asserts
`DOCTOR_CODES` is itself sorted and duplicate-free. Verified to bite: adding a
code locally without touching the table fails the suite.

**S — `checkCliShadow`.** Compare the resolved `lunora` executable against the
project's `node_modules/.bin/lunora`, resolving symlinks on both sides
(`node:fs.realpathSync`) so a pnpm-linked bin does not read as a mismatch. Emit
`warn` + code `cli-shadowed` when they differ, with the fix naming the
project-local invocation (`pnpm exec lunora …`). Skip silently when the project
has no local install — that is a global-only project, not a defect.

**Done — but the plan's comparison is wrong and was not used.** pnpm does not
symlink `node_modules/.bin/*`; it writes a **POSIX shell shim** (verified:
`file node_modules/.bin/vitest` → "POSIX shell script text executable"). So
`realpathSync("node_modules/.bin/lunora")` resolves to the shim script itself,
never to the `dist/bin.mjs` that `process.argv[1]` names — path equality would
have emitted `cli-shadowed` on **every pnpm project**, which is precisely the
false positive §8 warns about. The shipped check tests _containment_ instead:
realpath the project's installed CLI package dirs (`node_modules/@lunora/cli`,
`node_modules/lunorash`) and ask whether the running module lives inside one.
That holds for pnpm's symlinked package dirs, npm/yarn's hoisted ones, and a
launch through the bin shim alike. `RunDoctorOptions` gained an optional
`executablePath` (defaulting to `process.argv[1]`) — the same test seam `cwd`
already provides, since a test cannot relocate the running process. Three
fixtures: pnpm-symlinked layout reports clean, an outside binary warns exactly
once and never fails, no local install skips silently.

**S — docs.** The CLI reference page for `doctor` gains the `--format json`
example and the code table. The table is generated from the same const the
snapshot test reads, or it is a third place to forget.

**Done.** `packages/cli/docs/index.mdx` gained the CLI-shadow bullet, the
`--format json` invocation, a "Machine-readable output" section with the
document shape, and the 17-row code table the snapshot test asserts against.

## 6. Platform parity

Not applicable. This plan touches no `ctx.*` surface, no provider binding, and
no deploy/runtime capability — `lunora doctor` is a local, read-only CLI report,
and every check it performs is already target-agnostic or reads `wrangler.jsonc`
directly.

## 7. Phasing & ordering

| Phase | Work                             | Gate                                                                                              |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| 0     | `Finding.code` + literal union   | `pnpm --filter "@lunora/cli" run lint:types` green with the union in place (a missing code fails) |
| 1     | `--format json` + `ok`/`summary` | New test: `--format json` stdout parses as one document and stderr carries the human lines        |
| 2     | Code snapshot fixture            | Test fails when a code is added without updating the fixture (assert by adding one locally)       |
| 3     | `checkCliShadow`                 | Test with a fixture cwd whose local bin realpath differs → exactly one `cli-shadowed` warn        |
| 4     | Docs                             | `pnpm run lint:prettier` clean; the code table matches the fixture                                |

**All five gates met.** `pnpm --filter "@lunora/cli" run test` → 87 files, 1181
tests passed (24 in `doctor.test.ts`, up from 13). `lint:types` clean. Prettier
then ESLint clean on all four touched files. `pnpm run api:check` green with no
snapshot delta. Manual smoke on a scratch project confirms the two formats:
`--format json` emits one document on stdout with the human report on stderr,
plain `lunora doctor` is unchanged.

## 8. Risks & STOP conditions

- **STOP** if `Finding` turns out to be re-exported and consumed outside the CLI
  (`handler.ts:464` exports the type) — a required `code` would then be a
  breaking change for that consumer. Check `api-snapshots/cli.api.md` first; if
  `Finding` is in the public surface, `pnpm run api:update` after a fresh build
  is part of this plan, not an afterthought.
- **Risk:** `checkCliShadow` false-positives under pnpm's symlinked bins and
  makes every run warn. Mitigate: compare `realpathSync` on both sides, and add
  the pnpm-linked layout as an explicit test fixture that must report clean.
- **Risk:** the JSON document grows a field later and breaks a consumer.
  Mitigate: additive-only changes; the snapshot fixture makes a removal visible.

## 9. Open questions (answered during execution)

1. **Does `Finding` appear in `api-snapshots/cli.api.md`? — No.** Neither
   `Finding`, `DoctorResult`, nor `runDoctor` is in the CLI's public surface;
   the package exports the binary plus `runCli`/`COMMANDS`, and the doctor
   handler is reached only through the lazy command loader. `pnpm run api:check`
   after a fresh `pnpm --filter "@lunora/cli" run build` reports "Public API
   surface matches all 47 committed snapshots" with no snapshot edit. The §8
   STOP condition therefore does not apply, and the required `code` breaks no
   external consumer. (The doctor's own contract is still guarded — by the
   docs-table test, not by the api snapshot.)
2. **Should `pass` findings be in the JSON document? — Yes, include them.**
   The document then describes everything that was checked rather than only what
   went wrong, which is what lets a consumer distinguish "the export check passed"
   from "the export check did not run" — a distinction `summary.pass` alone
   cannot make, and one that matters because most checks skip silently when their
   input is absent. Cost is a handful of extra objects. A test asserts
   `summary.pass` equals the number of `pass` findings actually present, so the
   two cannot disagree.
3. **Is `--fix` worth a follow-up plan? — Yes, but a small one, and only for
   three codes.** `d1-placeholder-id` cannot be fixed offline (it needs
   `wrangler d1 create`). `wrangler-missing` / `wrangler-shard-binding-missing`
   are already `lunora init` / `lunora dev`'s job, and `dev-vars-missing-secret`
   is already `lunora dev`'s. That leaves `declared-export-missing` (append one
   `export * from …` line to the worker entry), `vector-metadata-index-required`
   (shell out to the wrangler command the finding already prints verbatim), and
   `cli-shadowed` (re-exec through the local install). Only the first is a file
   write nothing else owns; the honest scope of a `--fix` plan is that one
   check, which makes it hard to justify as its own flag rather than as a step
   in the generators. Recommendation: skip the flag, and instead have
   `declared-export-missing` name the exact line to paste (it already does).
4. **Should `lunora verify` embed the doctor findings? — No, keep them
   separate.** They fail for different reasons and on different inputs: `verify`
   is a build gate (codegen + `tsc`) whose failure means the code is wrong, while
   `doctor` is a configuration gate whose failures are mostly `warn`/`info` and
   frequently deliberate. Embedding would either promote doctor warnings into
   verify's exit code (blocking CI on a mixed alpha channel) or bury them in a
   result nobody reads. Both already emit the same `--format json` envelope, so
   an agent wanting one answer runs two commands and merges two documents — a
   cheaper coupling than a shared exit code.
