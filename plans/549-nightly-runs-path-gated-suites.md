# Plan 549 — Run the path-gated celld, MySQL, SDK conformance and SaaS e2e suites in the nightly

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):** `git diff --stat 4a7c48bfd..HEAD -- .github/workflows/nightly.yml .github/workflows/test.yml`
> must print nothing. Any change is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE (review APPROVED after revision 1, finished by a second executor; branch `ci/improve-549-nightly-path-gated`, commit `b4889fa4b`; lint-only locally; not merged)
**Priority / effort / risk:** P2 / S / LOW. **Category:** ci. **Depends on:** none.

## 0. Headline finding

`.github/workflows/nightly.yml` says "Everything here runs unfiltered — every package's tests, all
workerd suites, e2e", because PR jobs are path-gated and unchanged packages go stale between merges.
Four path-gated suites in `test.yml` have no nightly twin, so nothing unfiltered ever runs them: the
celld TCK, the MySQL parity suites, the eight non-JS SDK conformance legs, and the SaaS-kit e2e.

## 1. Current state (audit)

- `nightly.yml` (326 lines): header comment lines 1-4; jobs `test-full` (:22), `test-workerd` (:61),
  `e2e` (:153, `timeout-minutes: 30`, runs `pnpm e2e` and `pnpm run e2e:examples`, uploads
  `tests/e2e/playwright-report` and `tests/e2e/playwright-report-examples`), `templates-full` (:220),
  `report-failure` (:269) with `"needs": ["test-full", "test-workerd", "e2e", "templates-full"]` (:273)
  and an issue-body table listing one row per job (~:303-307). Comments above each copied job say
  "test.yml's `X` without the paths-filter gate" — follow that convention.
- `test.yml` jobs to mirror (all have `"if": "needs.files-changed.outputs.<x> == 'true'"` and
  `"needs": "files-changed"`, which the nightly copy drops):
    - `test-celld` (:503-561) — env `CELLD_VERSION`, `CELLD_SHA256`, `MOTO_VERSION`; installs celld,
      starts moto, builds `platform-celld`, runs `--project celld`.
    - `test-mysql` (:575-652) — includes the "Assert the run covers every suite using the MySQL harness"
      step and the "Assert the suites executed their cases" step; copy both.
    - `sdk-conformance` (:1046-1289) — an 8-leg matrix; includes "Assert the matrix covers every SDK on
      disk"; copy the whole job.
    - `e2e` (:654-739) — `timeout-minutes: 45` (comment: the saas kit adds a cold boot), a "Run SaaS kit
      E2E suite" step (`pnpm run e2e:saas`, env `CI: "true"`), and the report upload includes
      `tests/e2e/playwright-report-saas`.
- Workflow files are JSON-style YAML (every key double-quoted), pinned actions by SHA with a version
  comment, and `harden-runner` first. Copy steps verbatim.
- Local lint: `actionlint` is installed at `/opt/homebrew/bin/actionlint`; on the baseline it reports
  exactly one finding for `nightly.yml` — line 180, `step must run script with "run" section …
[syntax-check]` on the `"parallel":` step (a jactionlint extension CI accepts). `zizmor` is not
  installed locally; CI runs it (`.github/workflows/zizmor.yml`).

## 2-4. Seams, contract, decisions

- Hand copies, matching the existing nightly convention, chosen over making `test.yml` callable
  (`workflow_call`) or scheduled — that would change the PR-required workflow. Accept the drift risk;
  the comment above each copy names its source job.
- The nightly is never a required check; adding jobs adds no PR cost.

## 5. Workstream — steps

**Commands:**

| Purpose       | Command                                                  | Expected                                             |
| ------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Install       | `pnpm install`                                           | exit 0                                               |
| Baseline lint | `actionlint .github/workflows/nightly.yml; echo exit=$?` | one `syntax-check` finding at the `"parallel":` step |
| Format check  | `pnpm exec oxfmt --check .github/workflows/nightly.yml`  | exit 0                                               |

**Scope.** In scope: `.github/workflows/nightly.yml` only. Out of scope: `test.yml`, every script.

**Step 1 — baseline.** Install; run the baseline lint and record its output verbatim.

**Step 2 — copy the jobs.** After the `e2e` job, add `test-celld`, `test-mysql` and `sdk-conformance`
copied verbatim from `test.yml` (step order, comments, env, pinned SHAs), removing only the `"if"` and
`"needs"` keys, keep test.yml's own comment block above each job verbatim, and put a one-line comment above that, in the form "test.yml's <job> without the paths-filter gate".
In `sdk-conformance`'s "Assert the matrix covers every SDK on disk" message, leave the text as is.

**Step 3 — extend the nightly `e2e` job.** Set `"timeout-minutes": 45` with test.yml's comment; add the
"Run SaaS kit E2E suite" step (verbatim, with its comment) after the examples step; add
`tests/e2e/playwright-report-saas` to the upload `path` list.

**Step 4 — report-failure.** Add `"test-celld"`, `"test-mysql"`, `"sdk-conformance"` to its `"needs"`
array, and three table rows to the issue body in the same `"| <name> | ${{ needs.<job>.result }} |"`
form: "celld integration", "MySQL integration", "SDK conformance". Update the header comment (lines 1-4)
to list the new suites.

**Step 5 — verify.** Run oxfmt `--check` (if it reports a diff, run `pnpm exec oxfmt .github/workflows/nightly.yml`
and re-check), then actionlint.
Verify: actionlint prints exactly the baseline finding plus SC2016 on the `# jactionlint ignore=SC2016` step (the `"parallel":` step, at whatever line it now
sits) and nothing else; `grep -c '^    "[a-z-]*":$' .github/workflows/nightly.yml` is 3 higher than at
baseline; `grep -n "e2e:saas\|playwright-report-saas" .github/workflows/nightly.yml` prints two lines.

No red-without-fix step applies (CI config; it cannot run locally). Say so in the report.

**Step 6 — commit.** Stage `.github/workflows/nightly.yml` by path. Message:

```
ci: run celld, MySQL, SDK conformance and SaaS e2e nightly

The nightly claims to run everything the path-gated PR jobs skip, but these
four suites had no nightly twin. Hand copies of the test.yml jobs without the
paths-filter gate, wired into the failure report.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase     | Work                | Gate                                                                |
| --------- | ------------------- | ------------------------------------------------------------------- |
| 0         | Steps 1-6           | actionlint shows only the baseline finding; oxfmt check clean       |
| 1 (owner) | first scheduled run | the four new jobs go green on a nightly (cannot be checked locally) |

## 8. STOP conditions

- **STOP** on drift.
- **STOP** if actionlint reports any finding other than the baseline `"parallel":` one and SC2016 on the copied
  step that carries `# jactionlint ignore=SC2016` (plain actionlint flags the same step in `test.yml:635`;
  CI's jactionlint honours the directive). Revision 1 decision.
- **STOP** if a copied job references a secret, an `outputs` of `files-changed`, or another job that
  does not exist in `nightly.yml` (search the copy for `needs.` and `secrets.`).
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. (Owner) A drift guard comparing the nightly copies to their `test.yml` sources would stop the
   divergence the nightly's own e2e comment describes; not in this plan.

## Done criteria

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only `.github/workflows/nightly.yml`.
- [ ] actionlint output equals the baseline finding only; oxfmt `--check` exits 0.
- [ ] `report-failure` `needs` lists seven jobs.
- [ ] One commit with the message above.
