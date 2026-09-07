/**
 * AST-merge helper for `lunora add` registry items that ship a schema
 * extension. Mirrors the table/cron generators in
 * `.vis/templates/_helpers/insert-*.ts` — it loads `lunora/schema.ts` into a
 * ts-morph in-memory project and chains a `.extend(<key>.extension)` onto the
 * existing `defineSchema(...)` call, plus the matching managed import.
 *
 * Ownership / idempotency: both the import and the `.extend(...)` are wrapped in
 * `// lunora:add:<key>` managed-block markers. Re-running `add` for the same
 * item detects the marker and is a no-op, so user edits elsewhere in the file
 * survive untouched. ts-morph itself doesn't model leading-comment trivia as
 * editable nodes, so we operate on the raw text for the markers and only use
 * ts-morph to locate the `defineSchema(...)` call + verify the structure.
 *
 * Kept dependency-light: `ts-morph` is already a (lazily-loaded) dependency of
 * `@lunora/cli`; this module is only imported from the `add` command's reconcile
 * path, never at CLI start.
 */
import type { CallExpression, Node as TsNode, SourceFile } from "ts-morph";
import { Node, Project, SyntaxKind } from "ts-morph";

type InsertSchemaExtensionResult =
    { ok: true; text: string } | { ok: false; reason: "already-applied" | "invalid-identifier" | "no-define-schema" | "non-object-argument" };

/**
 * A valid JavaScript identifier. The item key is spliced into `schema.ts` as a
 * bare binding (`import { ${key} }`, `.extend(${key}.extension)`), so a leading
 * digit or a hyphen — both permitted by the registry's path-oriented item-name
 * regex — would emit uncompilable source (`import { 2fa }`, `.extend(rate-limit.extension)`).
 * Reject those here as defense-in-depth, independent of the caller's validation.
 */
const VALID_JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** Marker that brackets the managed import + `.extend()` for a given item key. */
const startMarker = (key: string): string => `// lunora:add:${key}:start`;
const endMarker = (key: string): string => `// lunora:add:${key}:end`;

/**
 * The default module specifier a freshly-added item is imported from. The item
 * ships `lunora/<key>/schema.ts` exporting `<key>` (the plugin object whose
 * `.extension` is the schema extension). Relative to `lunora/schema.ts` that is
 * `./<key>/schema`.
 */
const extensionImportSpecifier = (key: string): string => `./${key}/schema`;

/**
 * Whether the file already binds `key` at module scope — through any import
 * clause (default, namespace, or named, under its local alias) or a top-level
 * declaration. The spliced import introduces `key` as a lexical binding, so any
 * existing one makes the merged file uncompilable.
 */
const bindsIdentifier = (sourceFile: SourceFile, key: string): boolean => {
    if (sourceFile.getLocal(key) !== undefined) {
        return true;
    }

    return sourceFile
        .getImportDeclarations()
        .some(
            (declaration) =>
                declaration.getDefaultImport()?.getText() === key ||
                declaration.getNamespaceImport()?.getText() === key ||
                declaration.getNamedImports().some((named) => (named.getAliasNode() ?? named.getNameNode()).getText() === key),
        );
};

/**
 * Locate the `defineSchema(...)` call so we can append a `.extend()` to the end
 * of its (possibly already chained) expression — whether it's bound to a
 * `const schema = …` or sits behind an `export default …`.
 */
const findDefineSchemaCall = (callExpressions: ReadonlyArray<CallExpression>): CallExpression | undefined => {
    for (const call of callExpressions) {
        if (call.getExpression().getText() === "defineSchema") {
            return call;
        }
    }

    return undefined;
};

/**
 * The outermost expression of the `defineSchema(...).extend(...)…` call chain.
 * Walk up only through chain links where `node` is the callee/receiver (a
 * `.method()` continuation), never an enclosing call that merely takes the chain
 * as an argument — so the `.extend(...)` is spliced at the true end of the chain
 * regardless of whether it's a `const schema = …` binding or an `export default …`.
 */
const outermostChainExpression = (defineSchemaCall: CallExpression): TsNode => {
    let node: TsNode = defineSchemaCall;

    for (let parent = node.getParent(); parent !== undefined; parent = node.getParent()) {
        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
            node = parent;
        } else if (Node.isCallExpression(parent) && parent.getExpression() === node) {
            node = parent;
        } else {
            break;
        }
    }

    return node;
};

/**
 * Append `.extend(<key>.extension)` and a managed import to an existing
 * `lunora/schema.ts`. Idempotent: a second call for the same `key` returns
 * `already-applied` and leaves the text unchanged.
 * @param source the current `lunora/schema.ts` contents
 * @param key the registry item key (e.g. `"ratelimit"`)
 */
const insertSchemaExtension = (source: string, key: string): InsertSchemaExtensionResult => {
    // The key becomes a bare JS identifier in the emitted import + `.extend(...)`;
    // reject anything that isn't a valid identifier so we never write source that
    // can't compile (e.g. a hyphenated or digit-leading registry item name).
    if (!VALID_JS_IDENTIFIER.test(key)) {
        return { ok: false, reason: "invalid-identifier" };
    }

    // Idempotency gate: if the managed block already exists, do nothing.
    if (source.includes(startMarker(key))) {
        return { ok: false, reason: "already-applied" };
    }

    const project = new Project({
        compilerOptions: { allowJs: true },
        useInMemoryFileSystem: true,
    });

    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });

    // Second idempotency gate, and the one that matters in practice: the markers
    // only exist in files a previous `add` wrote, and NO template or registry item
    // ships them — `templates/standalone/lunora/schema.ts` already imports and
    // chains `ratelimit` by hand. Splicing in a second `import { ratelimit }`
    // there produced a hard `SyntaxError: Identifier 'ratelimit' has already been
    // declared` while the command reported "merged .extend(...)" and exited 0.
    // Read off the AST rather than the raw text so a `ratelimit` inside a comment
    // or string does not count as a binding.
    if (bindsIdentifier(sourceFile, key)) {
        return { ok: false, reason: "already-applied" };
    }

    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    const defineSchemaCall = findDefineSchemaCall(callExpressions);

    if (!defineSchemaCall) {
        return { ok: false, reason: "no-define-schema" };
    }

    const tablesArgument = defineSchemaCall.getArguments()[0];

    if (tablesArgument?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return { ok: false, reason: "non-object-argument" };
    }

    // Splice the chained `.extend(...)` in via raw-text insertion at the end of
    // the full `defineSchema(...).extend(...)…` chain (before the statement
    // terminator `;`). Works for both `const schema = defineSchema(...)` and
    // `export default defineSchema(...)` — we resolve the chain end from the call
    // itself rather than a variable binding. We avoid ts-morph's `replaceWithText`
    // here because re-printing a chained expression with trailing line-comments
    // confuses the parser on a second pass; raw splicing keeps the managed markers
    // as plain trivia. A trailing newline after the end-marker keeps the `;` on its own line.
    const insertAt = outermostChainExpression(defineSchemaCall).getEnd();
    const chainText = `\n    ${startMarker(key)}\n    .extend(${key}.extension)\n    ${endMarker(key)}\n`;

    sourceFile.insertText(insertAt, chainText);

    // Add the managed import for the extension. Insert at the top, bracketed by
    // the same markers so it's clearly owned + removable.
    const importText = `${startMarker(key)}\nimport { ${key} } from "${extensionImportSpecifier(key)}";\n${endMarker(key)}\n`;

    sourceFile.insertText(0, importText);

    return { ok: true, text: sourceFile.getFullText() };
};

export type { InsertSchemaExtensionResult };
export { insertSchemaExtension };
