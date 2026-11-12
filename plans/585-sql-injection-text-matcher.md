# Plan 585 — `sql_injection_risk` sees SQL text built away from the call, and stops flagging constant text

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/discover/sql-interpolation.ts packages/codegen/__tests__/discover/sql-interpolation.test.ts packages/advisor/src/lints/static/sql-injection-risk.ts`
> Expect no output. Otherwise compare the excerpts below with the live code; on a mismatch, STOP.

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** DONE — APPROVED; PR https://github.com/anolilab/lunora/pull/1565 (branch `fix/improve-585-sql-injection-text`, commits `e90c0d110`, `97c15f36c`). Executor stopped at the example sweep on the pre-existing `examples/privacy` drift (fixed by #1562); the reviewer's full-build sweep showed no finding change.
**Source:** row 47 of the 2026-11-11 audit (advisor lints).

## Status

- **Priority**: P2 · **Effort**: S–M · **Risk**: LOW · **Depends on**: none · **Category**: bug (security-lint false negative)

## 0. Headline finding

`sql_injection_risk` (ERROR) only fires when the string building is written
inline as the first argument of `ctx.sql.query` / `ctx.sql.unsafe`. SQL text
built in a `const` first, a raw argument passed as the text, a parenthesised or
cast concatenation, or a `[...].join(" ")` is never flagged. In the other
direction, a template that only interpolates a module constant
(`` `SELECT * FROM ${TABLE}` ``) IS flagged. The lint's description also talks
about a "tagged-template", which `ctx.sql` is not.

## 1. Current state (audit)

- `packages/codegen/src/discover/sql-interpolation.ts:35` —
  `const isStringBuildingText = (expression: TsNode): boolean => Node.isBinaryExpression(expression) || Node.isTemplateExpression(expression);`
- `:38-51` — `interpolationInCall` reads `call.getArguments()[0]` and records a row only when
  `isStringBuildingText(text)` holds. No unwrapping, no `const` hop, no taint check.
- `:12-18` (JSDoc) states correctly that `ctx.sql` is NOT a tagged template:
  `query(text, params)` / `unsafe(text, params)` bind only `params`.
- `packages/advisor/src/lints/static/sql-injection-risk.ts:6-23` — JSDoc and
  `description` say "`ctx.sql` tagged-template … interpolates"; `title` is
  "Possible SQL injection in ctx.sql interpolation"; `remediation` says "bound placeholder".
- Docs rows that repeat the wrong wording:
  `apps/docs/src/content/docs/concepts/advisors.mdx:78` and
  `apps/docs/src/content/docs/concepts/security.mdx:396`.
  `packages/advisor/docs/index.mdx:66` ("Unsafe interpolation in a `ctx.sql` string") is fine; leave it.

## 2. Existing seams (use them)

- `unwrapExpression` (`packages/codegen/src/discover/ast.ts:695`) strips `(x)`, `x as T`, `x satisfies T`, `x!`.
- `isArgumentDerived` (`packages/codegen/src/argument-taint.ts:243`) — the shared "derived from handler `args`" predicate.
- Test file to extend: `packages/codegen/__tests__/discover/sql-interpolation.test.ts`
  (fixtures are source strings written into a temp `lunora/` dir, then
  `discoverSqlInterpolation(project, join(workdir, "lunora"))`). Follow its exact structure.

## 3. Behavioural contract to preserve

- The four existing tests keep passing unchanged (template with `args`, concat with a
  parameter, `.unsafe` with a parameter → flagged; fixed text + params → not flagged).
- IR row shape `{ file, line, scope }` is unchanged; `line` is the line of the text argument.

## 4. Design decisions

- **"Constant text" decides, not syntax.** A text is safe when it is provably constant:
  string / numeric literals, no-substitution templates, and templates, `+`, or an
  array-literal `.join(...)` whose every part is constant, and identifiers bound by a
  `const` whose initializer is constant (followed through at most 3 nested `const`s).
  Anything else that builds a string is flagged. Chosen over "flag only when
  argument-derived": request input often reaches SQL through helpers and parameters the
  taint predicate cannot follow, and the fix (move the value into `params`) is always available.
- **A non-building text** (a bare identifier or member access that is not constant) is
  flagged only when `isArgumentDerived` holds — e.g. `ctx.sql.query(args.sql)`. A plain
  parameter `q` passed through is left alone, to keep the false-positive rate down.
- One `const` hop for the text itself (`const q = …; ctx.sql.query(q)`), matching the
  single-hop policy of the other feeders.

## 5. Steps

### Step 1: the matcher

In `packages/codegen/src/discover/sql-interpolation.ts`:

1. Add `isConstantText(node: TsNode | undefined, depth = 3): boolean`:
    - `node = unwrapExpression(node)`; `undefined` → `false`.
    - `Node.isStringLiteral`, `Node.isNoSubstitutionTemplateLiteral`, `Node.isNumericLiteral` → `true`.
    - `Node.isTemplateExpression` → every `span.getExpression()` is constant (`node.getTemplateSpans()`).
    - `Node.isBinaryExpression` with operator `+` (`node.getOperatorToken().getKind() === SyntaxKind.PlusToken`) → both sides constant. Any other binary → `false`.
    - `Node.isIdentifier` and `depth > 0` → the symbol's first declaration (`node.getSymbol()?.getDeclarations()[0]`) is a `VariableDeclaration` whose name node is an `Identifier`, whose statement kind is `const` (use the existing `isConstDeclaration` from `./ast`), and whose initializer `isConstantText(initializer, depth - 1)`.
    - A call `X.join(...)` where `X` (unwrapped) is an array literal whose every element is constant and every call argument is constant → `true`.
    - otherwise `false`.
2. Add `isBuiltText(node)`: after `unwrapExpression`, true for `TemplateExpression`, a `+` `BinaryExpression`, or a call whose callee is a property access named `join` or `concat`.
3. Replace `isStringBuildingText` with `isRiskyText(text: TsNode): boolean`:
    - `const value = unwrapExpression(text)`; if `isConstantText(value)` → `false`.
    - if `isBuiltText(value)` → `true`.
    - if `value` is an `Identifier`: resolve one `const` hop (same rule as above); if the initializer exists and `isBuiltText(unwrapExpression(initializer))` and not constant → `true`.
    - otherwise → `isArgumentDerived(value)`.
4. Use `isRiskyText` in `interpolationInCall`. Update the two JSDoc blocks (`isStringBuildingText`'s and `discoverSqlInterpolation`'s) to describe the new rule in two or three sentences. Imports: no `.js` extension.

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0;
`pnpm --filter "@lunora/codegen" exec vitest run __tests__/discover/sql-interpolation.test.ts` → the 4 existing tests pass.

### Step 2: tests (new shapes caught AND nearby safe shapes kept quiet)

Add to `sql-interpolation.test.ts`, one `it` per fixture, each with `expect.assertions`:

Flagged (`toHaveLength(1)`):

- `CONST_HOP`: `const q = \`SELECT * FROM t WHERE a = '${args.a}'\`; return ctx.sql.query(q);`
- `RAW_ARG`: `return ctx.sql.query(args.sql);`
- `CAST_CONCAT`: `return ctx.sql.query(("SELECT * FROM t WHERE a = '" + name + "'") as string);`
- `JOIN`: `return ctx.sql.query(["SELECT * FROM t WHERE a =", args.a].join(" "));`

Not flagged (`toHaveLength(0)`):

- `MODULE_CONST_TEMPLATE`: module-level `const TABLE = "users";` then `ctx.sql.query(\`SELECT * FROM ${TABLE} WHERE id = $1\`, [id])`
- `CONST_TEXT_HOP`: `const q = "SELECT * FROM users WHERE id = $1"; return ctx.sql.query(q, [id]);`
- `CONSTANT_JOIN`: `ctx.sql.query(["SELECT *", "FROM users", "WHERE id = $1"].join(" "), [id])`
- `PARAM_PASSTHROUGH`: `export const run = async (ctx, q) => ctx.sql.query(q);` (plain parameter, not `args`)

**Verify**: the test-file command → all pass (4 old + 8 new).

### Step 3: red without the fix

`git stash` is forbidden. Commit Steps 1–2 first (message below), then put the old matcher back with
`git show 79b0c5a6a:packages/codegen/src/discover/sql-interpolation.ts > packages/codegen/src/discover/sql-interpolation.ts`,
run the test file, and confirm: the 4 new "flagged" tests FAIL and `MODULE_CONST_TEMPLATE` FAILS
(the old matcher flags it). Then restore with `git checkout -- packages/codegen/src/discover/sql-interpolation.ts`
and re-run → all pass.

Commit (Steps 1–2): `fix(codegen): follow sql text through consts and casts for sql_injection_risk`.

### Step 4: reword the lint and docs

- `packages/advisor/src/lints/static/sql-injection-risk.ts`: rewrite the JSDoc, `description`,
  `remediation`, `title` and `detail` to describe the real sink. Use:
    - description: "A `ctx.sql.query(text, params)` / `ctx.sql.unsafe(text, params)` call builds its SQL `text` from non-constant values. The driver binds only `params` and runs `text` verbatim, so request input in the text reopens SQL injection."
    - remediation: "Keep the SQL text constant and pass every value through the `params` array (`$1`, `$2`, …) so the driver binds it. Never build SQL text from request input."
    - title: "Possible SQL injection in ctx.sql text"
    - detail: `` `ctx.sql` in ${callSiteWhere(interpolation)} builds its SQL text from a non-constant value instead of passing it in \`params\` — a SQL-injection vector. Keep the text constant and bind the value through \`params\`. ``
      Keep `name`, `level`, `facing`, `categories`, `source`, `cacheKey`, `metadata` unchanged.
- `apps/docs/src/content/docs/concepts/advisors.mdx:78`: replace the row's description cell with
  "A `ctx.sql.query` / `.unsafe` call builds its SQL text from non-constant values. Pass request input in the `params` array instead." Keep the table's column alignment (run `pnpm exec prettier --write` on the file).
- `apps/docs/src/content/docs/concepts/security.mdx:396`: replace the cell with
  "Keep `ctx.sql` text constant and pass request input in the `params` array, never by concatenation." and run prettier on it.

**Verify**: `pnpm --filter "@lunora/advisor" run test` → all pass (includes `docs-lint-reference.test.ts`);
`grep -n "tagged-template" packages/advisor/src/lints/static/sql-injection-risk.ts apps/docs/src/content/docs/concepts/advisors.mdx` → no matches.
Commit: `docs(advisor): describe sql_injection_risk as the query text sink`.

### Step 5: in-repo rollout

Build the CLI closure: `pnpm --filter "lunorash..." run build`. Then for EVERY directory under
`examples/` that has a `codegen` script: `cd examples/<name> && pnpm run codegen`, and afterwards
`git status --short examples`. If any `_generated` file changed, look at the diff: a changed
`LUNORA_ADVISORIES` entry naming `sql_injection_risk` is a NEW FINDING — STOP and report it
(file, line, the code) instead of committing; the reviewer decides. Any other `_generated` change → STOP and report.

**Verify**: `git status --short` → clean after the codegen runs.

## Commands you will need

| Purpose       | Command (from the worktree root)                                                                  | Expected           |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------ |
| Install       | `pnpm install --frozen-lockfile`                                                                  | exit 0             |
| Build deps    | `pnpm --filter "@lunora/codegen..." run build`                                                    | exit 0             |
| Codegen tests | `pnpm --filter "@lunora/codegen" run test`                                                        | all pass           |
| Advisor tests | `pnpm --filter "@lunora/advisor" run test`                                                        | all pass           |
| Lint / types  | `pnpm --filter "@lunora/codegen" run lint:eslint`, `… run lint:types`, same for `@lunora/advisor` | exit 0, 0 warnings |
| Format        | `pnpm exec oxfmt --check <changed .ts files>`; `pnpm exec prettier --check <changed .mdx files>`  | exit 0             |

## Scope

In scope: `packages/codegen/src/discover/sql-interpolation.ts`,
`packages/codegen/__tests__/discover/sql-interpolation.test.ts`,
`packages/advisor/src/lints/static/sql-injection-risk.ts`,
`apps/docs/src/content/docs/concepts/advisors.mdx` (line 78 only),
`apps/docs/src/content/docs/concepts/security.mdx` (line 396 only),
and `examples/*/lunora/_generated/*` ONLY if regenerated by the example's own `pnpm run codegen` AND the reviewer approved it.
Out of scope: `argument-taint.ts`, any other feeder or lint, `packages/advisor/docs/index.mdx`.

## Done criteria

- [ ] codegen and advisor `lint:eslint`, `lint:types`, `test` exit 0
- [ ] 8 new tests; the 4 new flagged ones and `MODULE_CONST_TEMPLATE` fail against the old matcher
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only in-scope files
- [ ] all example codegen runs leave `git status` clean (or a STOP report listing new findings)

## STOP conditions

- Excerpts do not match the live code.
- An example's regenerated `_generated` output changes (report the diff; do not commit it).
- An existing test in `sql-interpolation.test.ts` or `context-root-feeders.test.ts` starts failing.
- A verification fails twice after a reasonable fix.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding changes.

## 7. Phasing & ordering

One phase. Gate: the new tests, red against the old matcher, green with the fix.

## Maintenance notes

- Rollout: `sql_injection_risk` (ERROR) will now also fire on SQL text built in a `const`,
  passed straight from `args`, wrapped in parens/casts, or assembled with `.join`/`.concat`;
  it stops firing on templates that interpolate only constants. The reviewer's sweep over
  in-repo apps records the result in the PR.
- Reviewers: check `isConstantText` cannot recurse unboundedly (depth parameter).
