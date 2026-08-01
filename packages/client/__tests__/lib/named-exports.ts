import { Node, Project, ts } from "ts-morph";

/**
 * AST-based reader for the named VALUE exports of a TypeScript/TSX barrel.
 *
 * Shared by this package's `adapter-export-parity.test.ts` and auth-ui's
 * `__tests__/core/port-parity.test.ts` — both used to hand-roll the same
 * `EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}/g` + "as alias" regex pair to
 * answer the same question ("what does this barrel actually export?"). Repo
 * convention (AGENTS.md's "no `.js` extensions" note) is an AST-aware
 * codemod over a regex for exactly this class of problem: the regex only
 * ever matched `export { ... }` blocks, so it was silently blind to
 * `export * from "./x"`. Every barrel either test reads happens to use
 * explicit `export { ... }` today, which is why the regex "worked" — right
 * up until the day one of them is refactored to a star re-export, at which
 * point it would under-report with no error at all. `ts-morph`'s
 * `getExportedDeclarations()` resolves star re-exports, `export { x } from`,
 * and `export { a as b }` aliases uniformly, to the name an importer would
 * actually write, so there is nothing left for a barrel shape to hide from.
 *
 * Lives here (`@lunora/client`) rather than in either consumer's own
 * `__tests__` tree for the same reason the adapter manifest itself does —
 * see that file's header comment: `@lunora/client` is the shared, no-new-
 * dependency-edge core the adapters already sit on, so a second package
 * reading this one's test helper by relative path (no dependency edge
 * either) generalizes the same pattern rather than picking a side.
 */

// One `Project` reused across calls: ts-morph's parse/bind cost is real, and
// both consuming test files call this once per (feature, adapter) cell, many
// of which share the same underlying `index.ts`. `addSourceFileAtPath` is
// idempotent — a repeat path returns the already-parsed `SourceFile` — so
// reuse doubles as a cache.
//
// `jsx`/`experimentalDecorators` matter even though this helper never reads a
// component's JSX body: `getExportedDeclarations()` has to resolve through
// whatever `export { x } from "./y"` points at, and several barrels
// (`packages/react/src/index.ts` re-exporting `Authenticated` from
// `auth-gates.tsx`, `useLunora` from `lunora-provider.tsx`) point at `.tsx`.
// Without a `jsx` compiler option, the checker fails to resolve the target
// declaration at all — not a parse error, no diagnostic, just an export name
// present in the map with a silently empty declaration list — so the name
// was dropped as if it were type-only. `experimentalDecorators` covers the
// Angular port's decorator-based files the same way.
const project = new Project({
    compilerOptions: { experimentalDecorators: true, jsx: ts.JsxEmit.ReactJSX },
    skipAddingFilesFromTsConfig: true,
});

/** True for a declaration that exists only at the type level (never at runtime). */
const isTypeOnlyDeclaration = (node: Node): boolean => {
    if (Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node)) {
        return true;
    }

    if (Node.isExportSpecifier(node)) {
        return node.isTypeOnly() || node.getExportDeclaration().isTypeOnly();
    }

    if (Node.isImportSpecifier(node)) {
        return node.isTypeOnly() || node.getImportDeclaration().isTypeOnly();
    }

    return false;
};

/**
 * Every name `filePath` exports as a VALUE (never `export type`), following
 * `export { a as b }` aliases and `export * from` / `export { x } from`
 * re-export chains through to the name an importer would actually write.
 *
 * Throws if `filePath` does not exist. Callers that need to treat "this
 * module doesn't exist yet" as a soft failure (a feature that hasn't been
 * ported to this adapter at all) should catch around the call.
 */
export const namedValueExportsOf = (filePath: string): Set<string> => {
    const source = project.addSourceFileAtPath(filePath);
    const names = new Set<string>();

    for (const [name, declarations] of source.getExportedDeclarations()) {
        if (name !== "default" && declarations.some((declaration) => !isTypeOnlyDeclaration(declaration))) {
            names.add(name);
        }
    }

    return names;
};
