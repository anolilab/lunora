/**
 * AST-patching helper that injects the lunora/vite plugin into an existing
 * vite.config.ts (or .mts / .js / .mjs). Uses ts-morph to locate the plugins
 * array (or the config object) and MagicString to splice the edit so original
 * formatting and comments are preserved.
 *
 * Handles the three common shapes:
 * - `export default defineConfig({ plugins: [react()] })`
 * - `export default defineConfig({})` (no plugins key yet)
 * - `export default { plugins: [...] }` / `export default {}`
 *
 * Idempotent: returns `changed: false` when `lunora(` already appears in the
 * source or when no recognisable config shape can be found.
 */
// eslint-disable-next-line import/no-named-as-default -- magic-string's default export IS the MagicString class; this is the documented, idiomatic import
import MagicString from "magic-string";
import type { ObjectLiteralExpression, SourceFile } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

interface PatchViteConfigResult {
    changed: boolean;
    code: string;
    reason?: string;
}

const LUNORA_CALL = "lunora()";
const LUNORA_IMPORT = 'import { lunora } from "@lunora/vite";';

/** Hoisted regex — matches a `lunora(` call anywhere in the source. */
const LUNORA_CALL_RE = /\blunora\s*\(/u;

/** Hoisted check for the lunora/vite import specifier. */
const LUNORA_VITE_DOUBLE = '"@lunora/vite"';
const LUNORA_VITE_SINGLE = "'@lunora/vite'";

/**
 * Locate the config object inside a ts-morph SourceFile for a defineConfig
 * call expression whose first argument is an object literal.
 */
const findDefineConfigObject = (sf: SourceFile): ObjectLiteralExpression | undefined => {
    for (const statement of sf.getStatements()) {
        if (statement.getKind() !== SyntaxKind.ExportAssignment) {
            continue;
        }

        const expr = statement.asKindOrThrow(SyntaxKind.ExportAssignment).getExpression();

        if (expr.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const call = expr.asKindOrThrow(SyntaxKind.CallExpression);

        if (call.getExpression().getText() !== "defineConfig") {
            continue;
        }

        const argument = call.getArguments()[0];

        if (argument?.getKind() === SyntaxKind.ObjectLiteralExpression) {
            return argument.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        }
    }

    return undefined;
};

/**
 * Locate a plain `export default { ... }` object literal (no defineConfig
 * wrapper).
 */
const findPlainExportObject = (sf: SourceFile): ObjectLiteralExpression | undefined => {
    for (const statement of sf.getStatements()) {
        if (statement.getKind() !== SyntaxKind.ExportAssignment) {
            continue;
        }

        const expr = statement.asKindOrThrow(SyntaxKind.ExportAssignment).getExpression();

        if (expr.getKind() === SyntaxKind.ObjectLiteralExpression) {
            return expr.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        }
    }

    return undefined;
};

/** Parse the config source into a single in-memory ts-morph SourceFile. */
const parseConfigSource = (sourceText: string): SourceFile =>
    new Project({
        compilerOptions: { allowJs: true },
        useInMemoryFileSystem: true,
    }).createSourceFile("vite.config.ts", sourceText, { overwrite: true });

/**
 * Splice the import for lunora/vite into `ms`: immediately after the last
 * top-level import, or prepended at the top when there are none.
 */
const addImport = (ms: MagicString, sf: SourceFile): void => {
    const insertAt = sf.getImportDeclarations().at(-1)?.getEnd() ?? 0;

    if (insertAt === 0) {
        ms.prepend(`${LUNORA_IMPORT}\n`);
    } else {
        ms.appendLeft(insertAt, `\n${LUNORA_IMPORT}`);
    }
};

/**
 * Insert `lunora()` into the plugins array that `pluginsProp` points at.
 * When the array is empty, fills it; otherwise prepends before the first
 * element.
 */
const patchPluginsArray = (ms: MagicString, configObject: ObjectLiteralExpression): string | undefined => {
    const pluginsProp = configObject.getProperty("plugins");

    if (pluginsProp === undefined) {
        // No plugins key — add one as the first property.
        const properties = configObject.getProperties();
        const openBrace = configObject.getStart() + 1;

        if (properties.length === 0) {
            ms.appendLeft(openBrace, ` plugins: [${LUNORA_CALL}] `);

            return undefined;
        }

        const firstProp = properties[0];

        if (firstProp === undefined) {
            return "could not locate the start of the Vite config object's first property";
        }

        ms.appendLeft(firstProp.getStart(), `plugins: [${LUNORA_CALL}],\n    `);

        return undefined;
    }

    // Property exists — find its array literal and prepend lunora().
    const arrayLit = pluginsProp.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)[0];

    if (arrayLit === undefined) {
        return "the Vite config's `plugins` is not an array literal — add `lunora()` to it by hand";
    }

    const elements = arrayLit.getElements();

    if (elements.length === 0) {
        ms.appendLeft(arrayLit.getStart() + 1, LUNORA_CALL);

        return undefined;
    }

    const firstElement = elements[0];

    if (firstElement === undefined) {
        return "could not locate the first entry of the Vite config's `plugins` array";
    }

    ms.appendLeft(firstElement.getStart(), `${LUNORA_CALL}, `);

    return undefined;
};

/**
 * Rewrite `source` so that it contains the lunora/vite import and has
 * `lunora()` as the first entry of the Vite `plugins` array (adding the
 * property when the config object exists but lacks it).
 *
 * Returns `{ code: source, changed: false, reason }` for any no-op path.
 */
const patchViteConfig = (source: string): PatchViteConfigResult => {
    if (LUNORA_CALL_RE.test(source)) {
        return { changed: false, code: source, reason: "lunora plugin already present" };
    }

    const sf = parseConfigSource(source);
    const configObject = findDefineConfigObject(sf) ?? findPlainExportObject(sf);

    if (configObject === undefined) {
        return { changed: false, code: source, reason: "could not locate a Vite config plugins array to patch" };
    }

    const ms = new MagicString(source);

    if (!source.includes(LUNORA_VITE_DOUBLE) && !source.includes(LUNORA_VITE_SINGLE)) {
        addImport(ms, sf);
    }

    // The splice can decline (a `plugins` that is not an array literal — a spread,
    // a helper call, an imported constant). That used to be a bare `return` from
    // the splice, leaving `changed: true` over a `code` identical to the input:
    // the caller wrote the file back and reported the config patched, and the
    // project's dev server then ran with no Lunora plugin at all.
    const declined = patchPluginsArray(ms, configObject);

    if (declined !== undefined) {
        return { changed: false, code: source, reason: declined };
    }

    return { changed: true, code: ms.toString() };
};

export type { PatchViteConfigResult };
export { patchViteConfig };
