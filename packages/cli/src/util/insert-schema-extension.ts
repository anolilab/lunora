/**
 * AST-merge helper for `lunora add` registry items that ship a schema
 * extension. Mirrors the table/cron generators in
 * `.vis/templates/_helpers/insert-*.ts` — it loads `lunora/schema.ts` into a
 * ts-morph in-memory project and chains a `.extend(&lt;key>.extension)` onto the
 * existing `defineSchema(...)` call, plus the matching managed import.
 *
 * Ownership / idempotency: both the import and the `.extend(...)` are wrapped in
 * `// lunora:add:&lt;key>` managed-block markers. Re-running `add` for the same
 * item detects the marker and is a no-op, so user edits elsewhere in the file
 * survive untouched. ts-morph itself doesn't model leading-comment trivia as
 * editable nodes, so we operate on the raw text for the markers and only use
 * ts-morph to locate the `defineSchema(...)` call + verify the structure.
 *
 * Kept dependency-light: `ts-morph` is already a (lazily-loaded) dependency of
 * `@lunora/cli`; this module is only imported from the `add` command's reconcile
 * path, never at CLI start.
 */
import type { CallExpression } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

type InsertSchemaExtensionResult = { ok: true; text: string } | { ok: false; reason: "already-applied" | "no-define-schema" | "non-object-argument" };

/** Marker that brackets the managed import + `.extend()` for a given item key. */
const startMarker = (key: string): string => `// lunora:add:${key}:start`;
const endMarker = (key: string): string => `// lunora:add:${key}:end`;

/**
 * The default module specifier a freshly-added item is imported from. The item
 * ships `lunora/&lt;key>/schema.ts` exporting `&lt;key>` (the plugin object whose
 * `.extension` is the schema extension). Relative to `lunora/schema.ts` that is
 * `./&lt;key>/schema`.
 */
const extensionImportSpecifier = (key: string): string => `./${key}/schema`;

/**
 * Locate the `export const schema = defineSchema(...)` call so we can append a
 * `.extend()` to the end of its (possibly already chained) expression.
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
 * Append `.extend(&lt;key>.extension)` and a managed import to an existing
 * `lunora/schema.ts`. Idempotent: a second call for the same `key` returns
 * `already-applied` and leaves the text unchanged.
 * @param source the current `lunora/schema.ts` contents
 * @param key the registry item key (e.g. `"ratelimit"`)
 */
const insertSchemaExtension = (source: string, key: string): InsertSchemaExtensionResult => {
    // Idempotency gate: if the managed block already exists, do nothing.
    if (source.includes(startMarker(key))) {
        return { ok: false, reason: "already-applied" };
    }

    const project = new Project({
        compilerOptions: { allowJs: true },
        useInMemoryFileSystem: true,
    });

    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    const defineSchemaCall = findDefineSchemaCall(callExpressions);

    if (!defineSchemaCall) {
        return { ok: false, reason: "no-define-schema" };
    }

    const tablesArgument = defineSchemaCall.getArguments()[0];

    if (tablesArgument?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return { ok: false, reason: "non-object-argument" };
    }

    // Walk up from the `defineSchema(...)` call to the full chained expression
    // (it may already end in `.extend(...)` from a previous item) and to the
    // VariableStatement so we can find the `= ` initializer to append onto.
    const variableDeclaration = defineSchemaCall.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);

    if (!variableDeclaration) {
        return { ok: false, reason: "no-define-schema" };
    }

    const initializer = variableDeclaration.getInitializer();

    if (!initializer) {
        return { ok: false, reason: "no-define-schema" };
    }

    // Splice the chained `.extend(...)` in via raw-text insertion at the end of
    // the initializer expression (before the statement terminator `;`). We avoid
    // ts-morph's `replaceWithText` here because re-printing a chained expression
    // with trailing line-comments confuses the parser on a second pass; raw
    // splicing keeps the managed markers as plain trivia. A trailing newline
    // after the end-marker keeps the statement's `;` on its own line.
    const insertAt = initializer.getEnd();
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
