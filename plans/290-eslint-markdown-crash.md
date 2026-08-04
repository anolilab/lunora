# Plan 290 — Stop `eslint-plugin-n` crashing the linter on Markdown files

**Baseline:** `071c6a29c` (2026-08-01)
**Status:** DONE — `advisor/290-eslint-markdown-crash` (W1+W2 shipped; W3 drafted below, not filed)
**Priority:** P2 · **Effort:** S · **Risk:** LOW · **Category:** dx

> **Executor instructions**: follow this plan step by step, run every verification
> command, and confirm the expected result before moving on. If a STOP condition
> in §8 occurs, stop and report — do not improvise. When done, update this plan's
> row in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 071c6a29c..HEAD -- 'packages/*/eslint.config.js' 'apps/*/eslint.config.js' pnpm-workspace.yaml`
> Then re-run the reproduction below. If it no longer crashes (a config or
> catalog bump fixed it), state that honestly, mark this plan REJECTED with the
> fixing commit, and stop.

## 0. Headline finding

**Reproduced on baseline HEAD**: running ESLint over a Markdown file in
`packages/advisor` hard-crashes the linter —

```
$ cd packages/advisor && pnpm exec eslint SECURITY_LINT_CANDIDATES.md

Oops! Something went wrong! :(

ESLint: 10.7.0

TypeError: Error while loading rule 'n/no-unsupported-features/node-builtins': Cannot read properties of undefined (reading 'globalScope')
Occurred while linting .../packages/advisor/SECURITY_LINT_CANDIDATES.md
    at Object.create (.../eslint-plugin-n@17.24.0.../lib/rules/no-unsupported-features/node-builtins.js:72:41)
```

This is a crash, not a lint finding: `pnpm run lint:eslint` (and
`lint:affected:eslint`, which gates PRs via `vis affected lint:eslint
--fail-fast`) dies with a TypeError instead of reporting results whenever a
non-ignored Markdown file is in scope. It cannot be silenced by fixing the
file — the rule's `create()` dereferences a scope manager that Markdown
documents do not have.

**Root cause is in this repo's configs, not the preset** (verified, §1):
44 of 55 `packages/*/eslint.config.js` plus all 3 `apps/*/eslint.config.js`
configure `n/no-unsupported-features/node-builtins` in a blanket `rules` block
with **no `files` key**, so it attaches to Markdown files too.
`packages/cli/eslint.config.js` already carries the exact fix (an off-switch in
its Markdown block, :123-136) — this plan replicates it to the other 47
configs.

## 1. Current state (audit)

**The crashing frame** — `eslint-plugin-n@17.24.0`
`lib/rules/no-unsupported-features/node-builtins.js:68-74` (installed copy):

```js
    create(context) {
        const sourceCode = getSourceCode(context)
        const tracker = new ReferenceTracker(
            /** @type {NonNullable<typeof sourceCode.scopeManager.globalScope>} */ (
                sourceCode.scopeManager.globalScope
            )
        )
```

For a Markdown document (linted by `@eslint/markdown`'s language, wired in by
`@anolilab/eslint-config` — its manifest depends on `@eslint/markdown 8.0.2`
and `eslint-plugin-n 17.24.0`), `sourceCode.scopeManager` is `undefined` →
TypeError while _loading_ the rule.

**The blanket block that applies the rule to Markdown** —
`packages/advisor/eslint.config.js` (same shape in 43 other packages + 3
apps), a config entry with `rules` and **no `files`**:

```js
    // Scoped framework / Web-platform allowances (NOT blanket rule-off):
    {
        rules: {
            // Web platform globals present in the workerd + browser deploy runtimes (and
            // modern Node); eslint-plugin-n's Node-version data flags them conservatively.
            "n/no-unsupported-features/node-builtins": [
                "error",
                { ignores: ["crypto", "CryptoKey", "SubtleCrypto", "Storage", "sessionStorage", "localStorage"] },
            ],
            ...
```

**Proof it is the per-package block, not the preset** (differential test, run
at baseline): `packages/agent/eslint.config.js` is one of the 10 package
configs _without_ that block. Linting a synthetic Markdown file via stdin:

```
$ cd packages/agent   && echo "# hi" | pnpm exec eslint --stdin --stdin-filename notes.md   # → clean, no output
$ cd packages/advisor && echo "# hi" | pnpm exec eslint --stdin --stdin-filename notes.md   # → the TypeError above
```

The preset alone does not attach the rule to Markdown; the repo's blanket
block does.

**The fix already exists in one config** — `packages/cli/eslint.config.js:123-136`:

```js
    // Markdown code blocks: don't enforce language tags. The `n` Node-builtins
    // rules reach into the scope manager, which a markdown document has none of —
    // under ESLint 10 they throw "Cannot read properties of undefined (globalScope)"
    // while linting docs (e.g. skills/lunora/SKILL.md). They're meaningless on prose,
    // so turn them off for markdown.
    {
        files: ["**/*.md", "**/*.md/**"],
        rules: {
            "markdown/fenced-code-language": "off",
            "n/no-unsupported-features/es-builtins": "off",
            "n/no-unsupported-features/es-syntax": "off",
            "n/no-unsupported-features/node-builtins": "off",
        },
    },
```

`cli` needed it because its `skills/*/SKILL.md` files are lintable; the same
stdin probe in `packages/cli` is clean.

**Every other config already has the Markdown block to extend** — all 55
package configs (and the 3 app configs) carry a
`files: ["**/*.md", "**/*.md/**"]` entry whose only rule is
`"markdown/fenced-code-language": "off"`. The fix is adding the three `n/` off
lines to that existing block, exactly as cli did.

**Vulnerable-config inventory** (verified with an awk scan over the Markdown
block of each config):

- 44 of 55 `packages/*/eslint.config.js` — every config that sets the blanket
  `n/no-unsupported-features/node-builtins` rule except `cli`. (The 10 without
  the blanket block — agent, angular, auth-ui, container, db, search-core,
  seed, solid, svelte, vue — do not crash and need no change.)
- All 3 app configs: `apps/studio`, `apps/playground`, `apps/docs`.

**Which trees crash _today_**: only configs that both carry the blanket block
AND contain a non-ignored `.md` file. The per-package ignores cover
`**/README.md`, `**/CHANGELOG.md`, `**/*.md/**` (and the preset ignores
`LICENSE.md`), so at baseline the only live crash is
`packages/advisor/SECURITY_LINT_CANDIDATES.md`. Every other vulnerable config
is one committed Markdown file away from the same failure — which is why the
fix goes everywhere, not just advisor.

**Version facts** (for the alternative in §4): catalog pins
`eslint: 10.7.0` and `@anolilab/eslint-config: 28.0.1`
(`pnpm-workspace.yaml` lint catalog, :178/:183); `eslint-plugin-n` is a
transitive dep of the preset at `17.24.0`. The plugin's latest release is
`18.2.2` (peer `eslint >=8.57.1`) — a major bump, controlled by the preset,
not by this repo.

## 2. Existing seams (do not reinvent)

- The `files: ["**/*.md", "**/*.md/**"]` block already present in every
  config — extend it; do not add a second Markdown-scoped entry.
- `packages/cli/eslint.config.js:123-136` — the exact rule set AND the comment
  to replicate (copy the cli comment, dropping the cli-specific
  `skills/lunora/SKILL.md` example or generalizing it).
- Formatting order per repo practice: Prettier first, then ESLint
  (`pnpm exec prettier --write` before any `eslint --fix`); the edit itself is
  append-only inside an object literal, so Prettier should be a no-op.

## 3. The behavioural contract to preserve

- `n/no-unsupported-features/node-builtins` stays **on, with the same
  `ignores` allowances**, for TypeScript/JavaScript source — only Markdown
  scoping changes. The blanket block is untouched.
- The existing test-file relaxation blocks (which already turn the rule off
  for `__tests__/**` etc.) are untouched.
- `markdown/fenced-code-language: "off"` stays in the Markdown block.
- No preset (`@anolilab/eslint-config`) version change, no `eslint-plugin-n`
  addition to any manifest, no catalog change — this plan is config-only.
- The 10 package configs without the blanket rule are not modified (adding
  dead `n/` off-switches there would drift them from their actual rule set).

## 4. Design decisions

**Replicate cli's Markdown off-block into the 47 vulnerable configs.** Chosen
because it is already proven in-repo (cli), it is scoped (no signal lost — the
rule was never meaningful on prose or on fenced snippets, which the configs
separately ignore via `**/*.md/**`), and it needs no dependency movement.

Rejected alternatives, recorded:

- **Scope the blanket block with a `files: ["**/*.{ts,tsx,js,jsx,...}"]`
  key** instead — equivalent effect, but inverts the config idiom used
  everywhere else in these files (broad rules + scoped relaxations), and risks
  under-matching file types the preset lints (`.svelte`, `.vue`, `.astro`
  configs exist). The off-in-markdown-block shape follows the established
  pattern.
- **Bump `eslint-plugin-n` to 18.x** — it is a transitive dep of
  `@anolilab/eslint-config`; forcing it via `overrides` risks preset/plugin
  API mismatch, and whether 18.x even fixes the markdown-scopeManager case is
  unverified. The right venue is a preset upgrade — see next point. Check the
  18.x changelog during execution and record what you find in §9.2.
- **Fix upstream in `@anolilab/eslint-config`** — the preset could scope its
  `n/` rules (or this repo's blanket-block _pattern_ could move into it).
  That is the better long-term home, but it is a different repository; this
  plan's deliverable is the local fix plus an upstream issue (§5 W3). The
  local Markdown off-block stays correct even after an upstream fix lands
  (turning off an already-off rule is inert).

**Fix all 47 configs, not just advisor.** Advisor is the only tree that
crashes _today_, but 46 other configs carry the same latent crash one Markdown
file away (cli proved the failure mode is real — its skills docs hit it
first). A one-package fix re-files this plan the next time someone commits a
`NOTES.md`.

## 5. Workstreams

### W1 (S) — Fix `packages/advisor/eslint.config.js` and verify the live crash

Add to the existing Markdown block (currently only
`"markdown/fenced-code-language": "off"`), matching cli exactly:

```js
    {
        files: ["**/*.md", "**/*.md/**"],
        rules: {
            "markdown/fenced-code-language": "off",
            "n/no-unsupported-features/es-builtins": "off",
            "n/no-unsupported-features/es-syntax": "off",
            "n/no-unsupported-features/node-builtins": "off",
        },
    },
```

with cli's explanatory comment (generalized). **Fail-before demonstration**:
run the §0 repro command _before_ the edit → TypeError (capture it); after the
edit → a normal report or clean exit (exit code 0 or ordinary lint findings —
NOT a TypeError).

**Verify**: `cd packages/advisor && pnpm exec eslint SECURITY_LINT_CANDIDATES.md`
→ no TypeError; then `pnpm --filter "@lunora/advisor" run lint:eslint` → exits
with a lint _result_ (0, or real findings to assess — see §8 risk 2).

### W2 (M) — Replicate into the remaining 43 package configs + 3 app configs

Mechanical edit of the same Markdown block in each of the 46 other vulnerable
configs (list derivation below). The files are near-identical copies; a
scripted edit is acceptable, but diff-review each hunk — a few configs have
framework-specific Markdown blocks with extra context.

Derive the target list (do not trust a stale list):

```bash
for f in packages/*/eslint.config.js apps/*/eslint.config.js; do
  if grep -q 'n/no-unsupported-features/node-builtins' "$f" \
     && ! awk '/files: \["\*\*\/\*\.md"/,/^    },/' "$f" | grep -q 'node-builtins'; then
    echo "$f"
  fi
done
```

At baseline this prints 47 paths (44 packages + 3 apps); after W1, 46.

**Verify**: the derivation loop prints nothing; per-tree stdin probe on a
sample (at minimum `packages/server`, `packages/do`, `apps/studio`):
`echo "# hi" | pnpm exec eslint --stdin --stdin-filename notes.md` → clean.

### W3 (S) — Upstream note

File (or draft for the operator, if issue-filing isn't authorized) an issue
against `@anolilab/eslint-config` describing the incompatibility: its `n/`
ruleset + `@eslint/markdown` language + ESLint 10 → rule-load TypeError when a
consumer applies `n/` rules unscoped; ask for either preset-side `files`
scoping of the `n/` rules or an `eslint-plugin-n` 18.x upgrade once verified.
Link the crash frame (§1). Record the issue URL (or the draft location) in
§9.1.

## 6. Platform parity

**Not applicable.** This plan changes ESLint configuration only; no `ctx.*`
surface, binding, or deploy/runtime capability is touched, so no
`PlatformCapabilities` row changes.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                                   |
| ----- | ---- | ------------------------------------------------------------------------------------------------------ |
| 1     | W1   | §0 repro command: TypeError before (captured), normal lint result after                                |
| 2     | W2   | W2 derivation loop prints nothing; sample stdin probes clean                                           |
| 3     | W3   | Issue URL / draft recorded in §9.1                                                                     |
| 4     | —    | `pnpm run lint:eslint` completes across the repo without any TypeError (findings allowed, crashes not) |

## Commands you will need

| Purpose             | Command                                                                              | Expected                           |
| ------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| Repro (single file) | `cd packages/advisor && pnpm exec eslint SECURITY_LINT_CANDIDATES.md`                | pre: TypeError; post: report/clean |
| Stdin probe         | `echo "# hi" \| pnpm exec eslint --stdin --stdin-filename notes.md`                  | clean (run inside a package dir)   |
| Package lint        | `pnpm --filter "@lunora/advisor" run lint:eslint`                                    | exit with results, no TypeError    |
| Repo lint           | `pnpm run lint:eslint`                                                               | completes, no TypeError            |
| Format configs      | `pnpm exec prettier --check 'packages/*/eslint.config.js' 'apps/*/eslint.config.js'` | exit 0                             |

## Scope

**In scope:**

- The 44 `packages/*/eslint.config.js` files carrying the blanket
  `n/no-unsupported-features/node-builtins` rule without the Markdown
  off-block (per the W2 derivation — includes `packages/advisor`)
- `apps/studio/eslint.config.js`, `apps/playground/eslint.config.js`,
  `apps/docs/eslint.config.js`

**Out of scope:**

- `packages/cli/eslint.config.js` — already correct; do not restyle
- The 10 package configs without the blanket rule (agent, angular, auth-ui,
  container, db, search-core, seed, solid, svelte, vue at baseline)
- Any manifest, catalog, or `pnpm-workspace.yaml` change (no plugin bump)
- The content of `SECURITY_LINT_CANDIDATES.md` or any other Markdown file —
  unless the unmasked lint surfaces trivial findings there (§8 risk 2)
- The `@anolilab/eslint-config` repository itself (issue only)

## Git workflow

- Branch: `advisor/290-eslint-markdown-crash`
- Conventional commit, e.g. `fix(repo): scope n/no-unsupported-features rules off markdown files`
  (enforced types do NOT include `dx`; `fix` fits — the linter crashes).
- Shared checkout: stage the config files explicitly, never `git add -A`.
- Do NOT push or open a PR unless the operator asked for it.

## Test plan

There is no vitest surface; the linter runs are the tests, and the fail-before
evidence is mandatory:

1. **Fail-before**: §0 repro TypeError captured on the pre-fix tree (verbatim
   output in the PR/commit body).
2. **Pass-after**: same command returns a lint report or clean exit.
3. **Breadth**: W2 derivation loop empty; stdin probes clean in ≥ 3 sampled
   trees including one app.
4. **No-regression on source linting**: `pnpm --filter "@lunora/advisor" run lint:eslint`
   and one more package (e.g. `@lunora/server`) produce the same findings on
   `.ts` files as before the change (the blanket rule still fires on source —
   spot-check by temporarily adding a flagged builtin usage to a scratch file
   if in doubt, then revert).

## Done criteria

ALL must hold:

- [ ] `cd packages/advisor && pnpm exec eslint SECURITY_LINT_CANDIDATES.md` exits without a TypeError
- [ ] W2 derivation loop prints no paths
- [ ] `pnpm run lint:eslint` completes with no `TypeError: Error while loading rule` anywhere in its output
- [ ] `grep -c 'n/no-unsupported-features/node-builtins' packages/advisor/eslint.config.js` → 3 (blanket block + test block + new markdown block)
- [ ] Prettier check on all touched configs exits 0
- [ ] Fail-before TypeError output recorded
- [ ] Upstream issue URL or draft recorded (§9.1)
- [ ] `git status` shows no files modified outside the in-scope list
- [ ] `plans/README.md` status row updated

## 8. Risks & STOP conditions

- **STOP** if the crash persists in any tree after its Markdown block carries
  the off-rules — that means the rule reaches Markdown through a path other
  than the blanket block (preset-level application this plan's differential
  test ruled out at baseline). Re-run the §1 agent-vs-advisor stdin
  experiment and report; do not start layering broader `files` rewrites.
- **Risk:** un-crashing the linter can _unmask_ real findings in Markdown
  files that were never successfully linted (advisor's
  `SECURITY_LINT_CANDIDATES.md` has never completed a lint pass under this
  config). With `--max-warnings=0`, new warnings fail the package lint. If
  findings appear: trivial mechanical ones (e.g. another prose-meaningless
  rule) may be turned off in the same Markdown block with a comment; anything
  substantive → STOP and report rather than growing the off-list ad hoc.
- **Risk:** a scripted 46-file edit lands in a config whose Markdown block
  diverges (extra rules, different formatting). Mitigate: the awk-scoped
  derivation targets the exact block; review every hunk; Prettier check
  catches formatting damage.
- **Risk:** another session edits an eslint.config.js concurrently (shared
  checkout). Mitigate: short edit window, explicit staging, re-run the drift
  check before committing.

## 9. Open questions (answer during execution)

1. Upstream issue URL against `@anolilab/eslint-config` (W3) — record here.
2. Does `eslint-plugin-n` 18.x fix the markdown/scopeManager crash (check its
   changelog/source for a `scopeManager` guard)? If yes, note it in the
   upstream issue as the preferred preset-side fix; the local off-block
   remains correct either way.
3. Should the blanket `n/` block (and the whole duplicated per-package config
   body) be hoisted into the preset or a repo-shared fragment? 45+ near-copies
   invited this drift (`cli` fixed, 44 didn't follow). Out of scope here;
   record as a candidate follow-up plan.

---

## 10. Execution record (2026-08-03)

Branch `advisor/290-eslint-markdown-crash`, off `alpha` at `ab0afaf00`.

### Answers to §9

1. **Upstream issue (W3) — FILED**: https://github.com/anolilab/javascript-style-guide/issues/1084
   (draft kept in §11 for the record).
2. **Does `eslint-plugin-n` 18.x fix it? NO.** Checked the rule source at tag
   `v18.2.2` — `create(context)` still does

    ```js
    const tracker = new ReferenceTracker(/** @type {NonNullable<typeof sourceCode.scopeManager.globalScope>} */ (sourceCode.scopeManager.globalScope));
    ```

    The `NonNullable<…>` cast is a **type** assertion with no runtime effect, so
    18.x dereferences `scopeManager` exactly as unguardedly as 17.24.0. The
    rejected "bump the plugin" alternative in §4 would therefore not have worked
    at all — worth stating plainly in the upstream issue, since it removes the
    obvious "just upgrade" answer.

3. **Hoisting the duplicated config body** — still open, still out of scope.
   This execution is more evidence for it: the fix was a byte-identical edit to
   47 near-identical files, and all 47 Markdown blocks hashed to the same value
   beforehand (verified), which is exactly the signature of copy-paste that
   `cli` diverged from and nobody followed.

### What was done

- **W1 + W2 together.** All 47 vulnerable configs (44 packages + `apps/docs`,
  `apps/playground`, `apps/studio`) were patched in one scripted pass. It was
  safe to script because every one of the 47 Markdown blocks was verified
  byte-identical first (`md5` over the awk-extracted block → a single hash for
  all 47), and each file contained exactly one occurrence of the anchor, so the
  replacement could not land ambiguously.
- The comment is cli's, generalised — it drops the cli-specific `SKILL.md`
  example and says plainly that the failure is at rule-LOAD time, so one
  committed `.md` file takes down the whole run.
- `packages/cli` and the 10 configs without the blanket rule were not touched,
  per §3.

### Evidence

| Check                                                       | Before                                      | After                            |
| ----------------------------------------------------------- | ------------------------------------------- | -------------------------------- |
| `cd packages/advisor && eslint SECURITY_LINT_CANDIDATES.md` | `TypeError … (reading 'globalScope')`       | exit 0, no findings              |
| `pnpm --filter "@lunora/advisor" run lint:eslint`           | **exit 2** (crash)                          | **exit 1** (real report)         |
| stdin probe, `packages/server`                              | `TypeError: Error while loading rule 'n/…'` | clean                            |
| stdin probe, `apps/studio`                                  | `TypeError: Error while loading rule 'n/…'` | clean                            |
| §5 W2 derivation loop                                       | 47 paths                                    | empty                            |
| `pnpm run lint:eslint` (whole repo)                         | —                                           | exit 0, 161/161, zero TypeErrors |

The before-column probes were produced by stashing only the relevant config
(tagged stash, applied back by SHA and dropped by tag — the checkout is shared).

### The finding this uncovered — bigger than the plan

Advisor's package lint went from **exit 2 to exit 1**, not to exit 0: the crash
had been masking **21 real source-lint errors** in `src/**/*.ts`. None of them
are in Markdown, so the fix did not create them — an aborted run simply never
reported them.

Chasing why the whole-repo lint stayed green revealed the actual problem. The
repo run prints, for ten projects:

```
> advisor:lint:eslint
✓  advisor:lint:eslint (13 ms)
No command configured for advisor:lint:eslint
```

**vis reports a green tick for a target it never ran.** All ten packages define
a real `lint:eslint` (`eslint . --max-warnings=0`) in their own manifest, so the
script exists — the project graph simply does not wire it up. Running each
directly:

| Package         | `pnpm --filter … run lint:eslint` |
| --------------- | --------------------------------- |
| `replica`       | 303 problems                      |
| `ai`            | 118 problems                      |
| `db`            | 40 problems                       |
| `svelte`        | 24 problems                       |
| `advisor`       | 21 problems                       |
| `auth`          | 7 problems                        |
| `vue`           | 7 problems                        |
| `container`     | 3 problems                        |
| `platform-node` | clean                             |
| `ratelimit`     | clean                             |

**523 errors across 8 packages, behind a green checkmark.** Since CI's required
context is the aggregate lint run, none of it gates anything. This is out of
scope for plan 290 (which is config-only and must not grow into a 523-error
cleanup) but should be filed as its own plan — the gate is the bug, the 523
errors are just what it was hiding.

## 11. Upstream issue draft (W3 — for the operator to file)

**Repo:** `anolilab/javascript-style-guide` (the `@anolilab/eslint-config` home)
**Title:** `n/no-unsupported-features/*` crash the linter on Markdown under ESLint 10

> **What happens**
>
> With `@anolilab/eslint-config` 28.0.1 on ESLint 10.7.0, applying any
> `n/no-unsupported-features/*` rule in a config entry without a `files` key
> makes the rule attach to Markdown documents too. ESLint then dies while
> _loading_ the rule:
>
> ```
> TypeError: Error while loading rule 'n/no-unsupported-features/node-builtins':
> Cannot read properties of undefined (reading 'globalScope')
>     at Object.create (…/eslint-plugin-n/lib/rules/no-unsupported-features/node-builtins.js:72:41)
> ```
>
> A Markdown document has no `scopeManager`, and the rule dereferences
> `sourceCode.scopeManager.globalScope` unconditionally. Because it throws at
> load time, one committed `.md` file takes down the entire lint run — it is a
> crash, not a finding, and cannot be fixed in the file.
>
> **`eslint-plugin-n` 18.x does not fix this.** The same unguarded dereference
> is present at `v18.2.2`; the `NonNullable<…>` there is a type assertion with
> no runtime effect. Upgrading the plugin is not a workaround.
>
> **Ask**
>
> Scope the preset's `n/` rules with a `files` key (or ship a Markdown-scoped
> off-block in the preset), so consumers don't each have to discover this. We
> currently carry a `files: ["**/*.md", "**/*.md/**"]` block turning the three
> `n/no-unsupported-features/*` rules off in 48 configs; it stays correct and
> inert after a preset-side fix.
