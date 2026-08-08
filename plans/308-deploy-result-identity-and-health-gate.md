# Plan 308 — `lunora deploy` reports what it deployed, and proves it answers

**Baseline:** `370994075` (2026-08-08)
**Status:** DONE — shipped on `feat/plan-308-deploy-identity`

## 0. Headline finding

`lunora deploy` already parses the deployed URL out of wrangler's output
(`packages/cli/src/util/auto-link.ts`) — but the gate that enables it turns it
**off in exactly the two cases that need it most**:

```ts
// packages/cli/src/commands/deploy/handler.ts:1340
const shouldAutoLink = !isJsonFormat(options.format) && options.dryRun !== true && options.preview !== true && readLinkedProject(cwd) === undefined;
```

`--format json` — the machine-readable path an automation uses — never captures
the URL, and `DeployCommandResult` (`handler.ts:179-201`) has no field to carry
one anyway. So `lunora deploy --format json` returns a document that cannot tell
a caller _where the thing it just deployed lives_. `--preview` is likewise
excluded, and the code says so out loud: "see the preview URL in the wrangler
output above" (`handler.ts:1413`) — i.e. the CLI hands a machine-readable
command back to a human to read with their eyes.

Separately: nothing after a successful deploy proves the new version answers.
The probe exists (`runHealthProbeStep`, `verify/handler.ts:97`, against
`/_lunora/health`), but only as an opt-in flag on a _different_ command.

## 1. Current state (audit)

**URL capture (partially built, gated off where it counts):**

- `autoLinkFromDeployOutput` (`util/auto-link.ts`) parses a `*.workers.dev`
  origin (falling back to the first https URL) out of captured stdout and writes
  `.lunora/project.json` via `writeLinkedProject`. Best-effort; never throws.
- `handler.ts:1346` sets `captureStdout: shouldAutoLink` and `:1373` calls the
  linker with `result.stdout`.
- `shouldAutoLink` (`:1340`) is false when: `--format json`, `--dry-run`,
  `--preview`, **or the checkout is already linked**.
- `SpawnDescriptor.captureStdoutSilently` (`util/spawn.ts`) exists precisely for
  "capture without teeing to stdout, so `--format json` stays one document" —
  and is not used by the deploy path.

**What the result document carries** (`handler.ts:179-201`): `code`,
`descriptor`, `error?`, `mintedSecretsFile?`, `schemaDrift?`, `validation`. No
`url`, no version id, no timestamp, no `dryRun`/`preview` discriminator.

**Downstream consequences of the missing identity:**

- `deploy --migrate` refuses rather than defaulting: "`--migrate requires
--migrate-url <https://your-worker> — the deploy target URL is not captured
automatically, refusing to default to localhost`" (`handler.ts:843-850`). It
  resolves from the _link file_ (`resolveWorkerUrl`, `util/resolve-target.ts:37`),
  not from the deploy that just ran — so a first deploy in a fresh CI checkout
  has no URL at the moment it needs one.
- The deploy summary asks the human to type it back in: "`url: run \`lunora link
  --url <https://your-worker>\` to record it`" (`util/deploy-summary.ts:52`).
- A checkout that is already linked never re-captures (`readLinkedProject(cwd)
=== undefined` in the gate), so a URL that _changed_ — custom domain added,
  worker renamed, environment repointed — leaves a stale link that
  `run` / `logs` / `insights` / `--migrate` then silently target.

**Health:** `/_lunora/health` (aggregate, 503 on a downed critical dependency)
and `/_lunora/health/ready` (readiness gate) are auto-registered by the runtime
(`packages/runtime/src/health-routes.ts:32-33`, `create-worker.ts:4433`).
`lunora verify --health-url` probes the first one once, no retry
(`verify/handler.ts:97-116`). `lunora deploy` never probes anything.

## 2. Existing seams (do not reinvent)

- **`autoLinkFromDeployOutput` + `parseDeployedUrl`** (`util/auto-link.ts`) —
  the URL extractor. This plan changes _when_ it runs and _what else_ consumes
  its result; it should not grow a second parser.
- **`SpawnDescriptor.captureStdoutSilently`** (`util/spawn.ts`) — capture in
  JSON mode without corrupting the single stdout document. Already documented
  for this exact hazard.
- **`runHealthProbeStep`** (`verify/handler.ts:97`) — the probe. Lift it to a
  shared util (`util/health-probe.ts`) so `verify` and `deploy` share one
  implementation and one error-message shape.
- **`readLinkedProject` / `writeLinkedProject` / `LinkedProject`**
  (`packages/config/src/linked-project.ts`) — the `.lunora/project.json` record.
  It already carries `env`, `linkedAt`, `workerName`, `workerUrl`.
- **`isJsonFormat` / `printJson`** (`util/output-format.ts:46`) — the JSON
  contract.
- **`resolveWorkerUrl`'s environment guard** (`util/resolve-target.ts:37-49`) —
  a link recorded for one `--env` must never stand in for another. Any new write
  path must preserve that invariant, not route around it.

## 3. The behavioural contract to preserve

- `--format json` emits **exactly one** JSON document on stdout. Capturing
  wrangler's stdout must use `captureStdoutSilently`, never `captureStdout`.
- Link writes stay **best-effort**: a failed capture, parse, or write must never
  change the deploy's exit code (`auto-link.ts` is explicit about this).
- The `resolveWorkerUrl` env guard holds: a `production` link never supplies its
  URL to a `--env staging` command.
- `--dry-run` publishes nothing, so it must never write a link, never report a
  URL, and must be distinguishable in the JSON document from a real deploy.
- Additive JSON fields only — existing keys keep their names and meanings.

## 4. Design decisions

- **Capture on every successful real deploy, not only unlinked ones.** Chosen
  over today's first-deploy-only rule because the failure it prevents (a stale
  link silently misrouting `--migrate` at a decommissioned URL) is worse than
  the one it causes (overwriting a hand-set link).
- **…but never silently overwrite a hand-written link.** When a link already
  exists for this `env` and the parsed URL differs, **warn and keep the existing
  value**; do not rewrite. Chosen over overwrite (surprising, and `lunora link`
  is an explicit user act) and over silence (the stale-link failure above). The
  warning names both URLs and the one command that resolves it.
- **A `deployment` object in the result document, not loose top-level keys.**
  `{ url, workerName, env, versionId?, dryRun, preview, deployedAt }` — one
  nested object keeps the discriminators next to the identity they qualify, and
  leaves room for a version id without another top-level field per release.
- **`dryRun` and `preview` are reported as booleans in the document, always.**
  A consumer must be able to tell "nothing went live" from "went live" without
  inferring it from a missing `url`.
- **Health probe is opt-in via `--health-check`, not on by default.** Chosen
  over always-on: `deploy` must stay usable against a worker whose health route
  is admin-gated or unreachable from CI, and a default-on network step turns a
  successful deploy into a red build for an unrelated reason. The flag is what
  a release pipeline opts into deliberately.
- **The probe retries with a bounded budget; it does not poll forever.** A
  fresh deploy propagates, so a single immediate probe is a coin flip. Fixed
  attempt budget with a fixed delay, not exponential backoff — the wait is
  seconds, and a predictable ceiling is what a CI timeout can be set against.
- **Probe `/_lunora/health/ready`, falling back to `/_lunora/health`.** The
  readiness gate is the one that answers "can this version serve"; the aggregate
  is the one that exists on older deployments. `verify` keeps its current
  aggregate-only behaviour unless the shared util makes both trivial.

## 5. Workstreams

**S — result identity.** Add `deployment?: { deployedAt, dryRun, env?, preview,
url?, versionId?, workerName? }` to `DeployCommandResult` (`handler.ts:179`).
Populate from the captured output + `readWranglerName`. Emit in the JSON
document; the pretty summary keeps its current shape but reads the URL from the
result rather than from the link file.

**Done.** `DeployedIdentity` (exported from `handler.ts` and the package index)
carries `{ deployedAt, dryRun, env?, preview, url?, workerName? }` — **no
`versionId`**, see Q1. Built in `completeDeploy` once wrangler exits 0, present
on dry runs and previews too. `renderDeploySummary` grew a `url?` input that
wins over the link file. Snapshot delta committed in `api-snapshots/cli.api.md`.

**S — capture in JSON and preview modes.** Split `shouldAutoLink` into two
decisions: _should we capture_ (yes on any successful non-dry-run wrangler
invocation, silently when `isJsonFormat`) and _should we write the link_ (the
existing rules, plus the mismatch warning from §4). This is the core fix —
`--format json` and `--preview` both start reporting a URL.

**Done.** `buildDeploySpawn` owns the split: `captureStdout` (tees) in pretty
mode, `captureStdoutSilently` in json mode, neither on a dry run. In json mode
the buffered output is replayed to **stderr** after the spawn, so `--format
json` still shows the wrangler log in CI without touching the document —
`stdoutToStderr` no longer applies there (nothing is inherited to redirect).

**M — link refresh + mismatch warning.** Rework `autoLinkFromDeployOutput` to
take the existing link into account: write when absent, warn-and-keep when
present-and-different, no-op when present-and-equal. Keep it best-effort and
keep the `env` scoping.

**Done.** It now takes the parsed `url` (the handler needs it for `deployment`
anyway, so `parseDeployedUrl` runs once) instead of raw `output`. A link
recorded for a DIFFERENT `--env` counts as a mismatch, not a target to
overwrite — the file holds one link, and clobbering the production one with a
staging URL is the failure `resolveWorkerUrl`'s guard exists to prevent.

**M — `--health-check`.** Lift `runHealthProbeStep` into
`util/health-probe.ts`, give it an attempt budget + delay + injectable fetch and
clock, and call it from `deploy` after a successful real deploy when the flag is
set, using the URL this run just captured (falling back to the link, then
refusing with a clear message when neither exists). A failed probe fails the
deploy command's exit code — that is the point of the flag — and the reason
lands in the JSON document. `verify` switches to the shared util.

**Done.** `probeHealth` in `util/health-probe.ts`: ordered `paths` (a 404 falls
through to the next, anything else is the verdict), `attempts`/`delayMs`,
injectable `fetchImpl` + `sleep`. Deploy probes `[ready, aggregate]` 5× at 2s;
`verify` keeps its single aggregate probe by taking the defaults, so its message
shape and call signature are byte-identical. The probe runs BEFORE `--migrate`
— a worker that can't serve is not one to migrate — and its verdict lands in
`result.healthCheck { error?, ok, url }`.

**S — docs.** CLI reference for `deploy`: the new flag, the `deployment` object,
and one worked CI example (`deploy --format json --health-check`, then read
`.deployment.url` for the smoke step).

**Done.** `packages/cli/docs/index.mdx` — cheat-sheet line, a `--health-check`
subsection, a "Machine-readable output" subsection with the annotated document
and the `jq -r '.deployment.url'` smoke-step example, plus the rewritten
link/preview paragraphs.

## 6. Platform parity

Not applicable to the `ctx.*` matrix — this plan adds no runtime surface and no
provider binding. One target-facing note: the URL parser and the health probe
are Cloudflare-shaped (`*.workers.dev`, `wrangler deploy` stdout). The
`@lunora/platform-node` deploy driver in `@lunora/config` has its own notion of
a deployed endpoint; this plan does not extend to it, and the parser must stay
behind the Cloudflare deploy path rather than being presented as target-neutral.
`/_lunora/health` itself is runtime-level and therefore available on any host
that mounts the runtime.

## 7. Phasing & ordering

| Phase | Work                            | Gate                                                                                                               |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0     | `deployment` on the result      | Test: `--format json` on a stubbed spawner yields one parseable document containing `deployment.url`               |
| 1     | Silent capture in JSON mode     | Test: stdout is exactly one JSON document (no wrangler text interleaved) while `deployment.url` is still populated |
| 2     | Preview capture                 | Test: `--preview --format json` reports the preview URL; `handler.ts:1413`'s "read it above" message is gone       |
| 3     | Link refresh + mismatch warning | Three tests: absent → written; equal → no write, no warning; different → warning, original value preserved on disk |
| 4     | `--health-check` + shared util  | Tests: probe passes → exit 0; probe 503s on every attempt → non-zero exit + reason in the document; `verify` green |
| 5     | Docs                            | `pnpm run lint:prettier` clean                                                                                     |

**All phases done.** Gates: `pnpm --filter "@lunora/cli" run test` → 88 files /
1191 tests passed; `lint:types`, `lint:eslint` (`--max-warnings=0`),
`lint:prettier` clean; `pnpm run api:check` green after `api:update`.

One plan correction: §7 phase 2 expects `handler.ts:1413`'s "read it above"
message to be **gone**. It is replaced, not deleted — a preview whose output
carried no URL still needs a success line, so it now reads `preview version
uploaded — <url>` and falls back to a bare `preview version uploaded`.

## 8. Risks & STOP conditions

- **STOP** if wrangler's deploy output stops containing a URL in a supported
  version (or moves it behind its own machine-readable flag). Prefer wrangler's
  own structured output over regex-scraping the moment it is available on the
  pinned version — re-scope rather than hardening the regex further.
- **Risk:** capturing stdout changes wrangler's TTY behaviour (progress
  rendering, colour) for the non-JSON path. Mitigate: keep `captureStdout`
  (which tees) for pretty mode and `captureStdoutSilently` only for JSON mode —
  the split the spawn util already anticipates.
- **Risk:** the mismatch warning fires on every deploy for projects whose URL
  legitimately varies (preview/temporary origins). Mitigate: only compare for
  real, non-preview, non-temporary deploys of the same `env`.
- **Risk:** `--health-check` flakes on cold propagation and reads as a broken
  deploy. Mitigate: bounded retry (§4), and the failure message must state that
  the deploy _succeeded_ and the probe did not — those are different facts.

## 9. Open questions (answered during execution)

1. **No — shipped without `versionId`.** `wrangler deploy --help` on the pinned
   4.114.0 offers no `--format`/`--json` and no structured deploy output; the
   only version id is the `Current Version ID: <uuid>` line in the human prose,
   and scraping a second value out of prose is exactly what §8's STOP condition
   warns against. `DeployedIdentity` therefore has no `versionId`, and the docs
   point at `lunora deployments list` for it. Revisit if wrangler ships
   structured output.
2. **No.** `--health-check` probes the origin the deploy just published to (then
   the link for this `--env`, then refuses). A public origin that differs from
   the deploy origin is already served by `lunora verify --health-url <url>`,
   which now runs the same probe — a second URL flag on `deploy` would be a
   config knob with one existing caller.
3. **Parseable, but no link.** `--temporary` prints the same `*.workers.dev`
   origin, so `deployment.url` reports it — but the account is deleted in ~60
   minutes, so writing it as the checkout's recorded target would silently
   misroute `run` / `logs` / `--migrate` afterwards. The link write is skipped
   for `--temporary` (tested).
4. **No `--relink`.** The mismatch warning names the exact `lunora link --url
<new> [--env <name>]` to run. A flag for it would be a second way to do the
   same thing, on the rare path.
5. **Verify keeps the aggregate probe.** It validates a checkout rather than
   gating a release, so "is this deployment healthy right now" is the whole
   question — one attempt, one route, unchanged message shape. The shared util
   makes both trivially available if that ever changes.

### Follow-up not taken here

`deploy --migrate` still requires `--migrate-url` (or a link) rather than
defaulting to the URL this run captured: the preflight refusal runs _before_
wrangler, so the captured URL does not exist yet at the point of the gate.
Deferring that gate until after the spawn is a real change to when a `--migrate`
run can abort, and is outside §5's workstreams. The stale message ("the deploy
target URL is not captured automatically") was corrected to say why the gate
cannot use it.
