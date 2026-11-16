# Plan 554 — Move file-level `eslint-disable` blocks into the lint config

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO (plan only — each rule needs a lint-config decision reviewed on its own, per AGENTS.md)
**Priority / effort / risk:** P3 / M / LOW. **Category:** tech-debt.

## 0. Headline finding

AGENTS.md: "An `eslint-disable` is line-scoped and carries its reason … A file-level disable is not
accepted; if a whole file seems to need one, the rule is wrong for that file and the change belongs in
the lint config, reviewed on its own." At the baseline, `packages/*/src` holds 146 block
`/* eslint-disable … */` comments starting a line, and 43 `/* eslint-enable` (some disables are
re-enabled ranges, the rest run to end of file).

## 1. Current state (counts at `4a7c48bfd`)

Command: `grep -rnE '^/\* eslint-disable ' packages/*/src | wc -l` → 146;
`grep -rnE '^/\* eslint-enable' packages/*/src | wc -l` → 43. By rule (a comment can list several):

| Rule                                                                                     | Count    |
| ---------------------------------------------------------------------------------------- | -------- |
| `no-secrets/no-secrets`                                                                  | 48       |
| `unicorn/prevent-abbreviations`                                                          | 43       |
| `import/exports-last`                                                                    | 11       |
| `no-restricted-syntax`                                                                   | 9        |
| `sonarjs/deprecation`                                                                    | 7        |
| `jsdoc/check-indentation`                                                                | 6        |
| others (`unicorn/no-null`, `@typescript-eslint/method-signature-style`, `no-bitwise`, …) | < 5 each |

## 4. Design decisions (per rule, owner)

- `no-secrets/no-secrets` (48): almost certainly high-entropy literals (hashes, base64 fixtures,
  test vectors). Option: a per-file-glob override in the package's `eslint.config.js`, or tune the
  rule's `tolerance`/`ignoreContent`. Each instance must be checked to NOT be a real secret first.
- `unicorn/prevent-abbreviations` (43): decide repo-wide `replacements`/`allowList` for the recurring
  abbreviations (`ctx`, `args`, `db`, …) in the shared config instead of per-file disables.
- `import/exports-last` (11): files whose structure needs interleaved exports; decide per file, or
  disable the rule for a glob.
- The rest: convert to line-scoped disables with reasons, or fix the code.

## 5. Workstreams

0. (S) Inventory script output per file (which rule, whether re-enabled, range length).
1. (M) One PR per rule family, starting with `no-secrets` (security review included), then
   `prevent-abbreviations`, each removing the file-level comments and adding the config change.
2. (S) A guard: an ESLint rule or a `scripts/check-*.js` that fails on a new top-of-file
   `/* eslint-disable` without a matching `eslint-enable` in `packages/*/src`.

## 6. Platform parity

Not applicable.

## 7. Gates

`pnpm run lint` green after each PR; the guard fails on a re-introduced file-level disable (verify it
goes red on a test file).

## 8. Risks

- **STOP** in the `no-secrets` PR if any disabled literal is a real credential: report location and
  type only, and rotate.

## 9. Open questions

1. Should block disables with a matching `eslint-enable` (range-scoped) be allowed? The AGENTS.md text
   says line-scoped; the 43 enables suggest current practice tolerates ranges.
