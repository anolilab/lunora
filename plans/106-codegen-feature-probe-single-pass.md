# Plan 106: Collapse codegen feature-usage detection into one AST pass per file

> **Executor instructions**: Follow step by step; run each verify. STOP
> conditions halt you. Update `plans/README.md` when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/codegen/src/discover-feature-usage.ts`

## Status

- **Priority**: P3 (low leverage — see "Why")
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf / tech-debt
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

`discoverFeatureUsage` detects which `@lunora/*` features each `lunora/` source
uses. For every context-bearing feature that isn't import-matched, it calls
`readsContextProperty`, which runs **two full-file descendant traversals**
(`getDescendantsOfKind(PropertyAccessExpression)` + `getDescendantsOfKind(
VariableDeclaration)`) — once per feature. With ~15 context features, a source
that imports none of the packages is walked up to ~30 times where a single pass
would do: O(files × features × nodes) instead of O(files × nodes).

**Leverage caveat (read before starting)**: prior measurement (Wave 3 plan 063)
showed warm dev-loop codegen is ~18–20ms total and the fresh-run cost is
dominated by ts-morph Project construction, not this traversal. So this is a
_modest_ cleanup, not a hot-path win. It is worth doing as a clean, semantics-
preserving refactor covered by golden tests, but do not over-invest, and do not
claim a large speedup.

## Current state

`packages/codegen/src/discover-feature-usage.ts:126-147` — per-call double walk:

```ts
const readsContextProperty = (sourceFile: SourceFile, property: string): boolean => {
    const reachesContext = (receiver: Node): boolean => Node.isIdentifier(receiver) && receiver.getText() === "ctx";
    const directAccess = sourceFile
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .some((access) => access.getName() === property && reachesContext(access.getExpression()));
    if (directAccess) return true;
    return sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).some((declaration) => {
        const initializer = declaration.getInitializer();
        const nameNode = declaration.getNameNode();
        if (initializer === undefined || !reachesContext(initializer) || !Node.isObjectBindingPattern(nameNode)) return false;
        return nameNode.getElements().some((element) => element.getPropertyNameNode()?.getText() === property || element.getName() === property);
    });
};
```

The per-file loop (`discover-feature-usage.ts:179-195`) calls it inside a
per-feature loop:

```ts
for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
    const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
    const importSpecifiers = new Set(sourceFile.getImportDeclarations().map((d) => d.getModuleSpecifierValue()));
    for (const key of keys) {
        // ~15 feature keys
        if (usage[key]) continue;
        const probe = PROBES[key];
        if (importSpecifiers.has(probe.moduleSpecifier)) {
            usage[key] = true;
            continue;
        }
        if (probe.contextProperty !== undefined && readsContextProperty(sourceFile, probe.contextProperty)) {
            usage[key] = true;
        }
    }
    if (keys.every((key) => usage[key])) break;
}
```

`PROBES` (`discover-feature-usage.ts:66+`) maps each feature key to
`{ contextProperty, moduleSpecifier }`. `readsContextProperty` semantics to
preserve exactly:

- direct: `ctx.<property>` (a `PropertyAccessExpression` named `<property>` whose
  receiver is the `ctx` identifier).
- destructured: `const { <property> } = ctx` (an object-binding-pattern var
  declaration initialized from `ctx`, whose element property-name or name is
  `<property>`). Parameter-position destructuring is intentionally NOT matched
  (comment at `:120-125`).

## Commands you will need

| Purpose       | Command                                           | Expected |
| ------------- | ------------------------------------------------- | -------- |
| Build (deps)  | `pnpm --filter "@lunora/codegen..." run build`    | exit 0   |
| Typecheck     | `pnpm --filter "@lunora/codegen" run lint:types`  | exit 0   |
| Test (golden) | `pnpm --filter "@lunora/codegen" run test`        | all pass |
| Lint          | `pnpm --filter "@lunora/codegen" run lint:eslint` | exit 0   |

## Scope

**In scope**:

- `packages/codegen/src/discover-feature-usage.ts` — replace the per-feature
  double-walk with a single per-file traversal that collects the set of
  context-property names read (direct + destructured), then resolves each
  `PROBES` entry against that set + the import-specifier set.

**Out of scope**:

- `PROBES` contents / feature list.
- Any other codegen discovery pass.
- ts-morph Project construction (the actual dominant cost — not this plan).

## Git workflow

- Branch: `advisor/106-codegen-feature-probe-single-pass`
- Commit: `perf(codegen): detect context-feature usage in one AST pass per file`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Build a single-pass context-property collector

Add a helper that walks each source file once (a single `forEachDescendant`, or
one `getDescendantsOfKind(PropertyAccessExpression)` + one
`getDescendantsOfKind(VariableDeclaration)` — two walks total _per file_, not per
feature) and returns `Set<string>` of context-property names read:

```ts
const contextPropertiesRead = (sourceFile: SourceFile): Set<string> => {
    const reachesContext = (receiver: Node): boolean => Node.isIdentifier(receiver) && receiver.getText() === "ctx";
    const names = new Set<string>();
    for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (reachesContext(access.getExpression())) names.add(access.getName());
    }
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const initializer = declaration.getInitializer();
        const nameNode = declaration.getNameNode();
        if (initializer === undefined || !reachesContext(initializer) || !Node.isObjectBindingPattern(nameNode)) continue;
        for (const element of nameNode.getElements()) {
            const name = element.getPropertyNameNode()?.getText() ?? element.getName();
            if (name) names.add(name);
        }
    }
    return names;
};
```

This preserves the exact matching semantics of `readsContextProperty` (direct +
destructured, no parameter-position).

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0.

### Step 2: Rewire the per-file loop

Compute `const props = contextPropertiesRead(sourceFile)` once per file, then:

```ts
for (const key of keys) {
    if (usage[key]) continue;
    const probe = PROBES[key];
    if (importSpecifiers.has(probe.moduleSpecifier)) {
        usage[key] = true;
        continue;
    }
    if (probe.contextProperty !== undefined && props.has(probe.contextProperty)) usage[key] = true;
}
```

Remove `readsContextProperty` (now unused) or keep it only if referenced
elsewhere (grep first).

**Verify**: `pnpm --filter "@lunora/codegen" run test` → all pass (golden output
byte-identical — this is the critical gate).

## Test plan

- The codegen **golden tests** are the safety net: feature-usage drives worker
  gating (`ai`/`payments`) and studio nav flags, which appear in generated output
  / feature results. If the goldens pass unchanged, semantics are preserved.
- If `discover-feature-usage` has a dedicated unit test, ensure it still passes
  (grep `packages/codegen/__tests__` for `discoverFeatureUsage` /
  `readsContextProperty`). Add a case if one is missing for the destructured path
  (`const { ai } = ctx` → `ai` detected) to lock the semantics.
- Verification: `pnpm --filter "@lunora/codegen" run test` → all pass.

## Done criteria

- [ ] `discoverFeatureUsage` walks each source file's descendants a constant number of times (not per-feature); `readsContextProperty`'s per-feature double-walk is gone.
- [ ] Feature detection results are identical (golden tests pass byte-identical).
- [ ] `pnpm --filter "@lunora/codegen" run lint:types` + `run test` + `run lint:eslint` exit 0.
- [ ] `git status` shows only `packages/codegen/src/discover-feature-usage.ts` (+ optional test).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Any golden test output changes — the refactor altered detection semantics
  (likely the destructured-name matching or the `getPropertyNameNode` vs
  `getName` order). STOP and reconcile until goldens are byte-identical.
- `readsContextProperty` is referenced by another module/test — don't delete it
  blindly; keep it or update all callers.

## Maintenance notes

- If a new context feature is added to `PROBES`, it automatically works with the
  single-pass collector (no per-feature walk to add) — that's a side benefit.
- Do not present this as a meaningful codegen speedup in the changelog; it's a
  clean-up of redundant per-feature traversal. The real codegen cost is ts-morph
  Project construction (out of scope; see Wave 3 plan 063).
