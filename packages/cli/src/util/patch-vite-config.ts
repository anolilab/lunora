/**
 * AST-patching helper that injects the cirrus/vite plugin into an existing
 * vite.config.ts (or .mts / .js / .mjs). Uses ts-morph to locate the plugins
 * array (or the config object) and MagicString to splice the edit so original
 * formatting and comments are preserved.
 *
 * Handles the three common shapes:
 * - `export default defineConfig({ plugins: [react()] })`
 * - `export default defineConfig({})` (no plugins key yet)
 * - `export default { plugins: [...] }` / `export default {}`
 *
 * Idempotent: returns `changed: false` when `cirrus(` already appears in the
 * source or when no recognisable config shape can be found.
 */
import MagicString from "magic-string";
import type { ObjectLiteralExpression } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

interface PatchViteConfigResult {
    changed: boolean;
    code: string;
    reason?: string;
}

const CIRRUS_CALL = "cirrus()";
const CIRRUS_IMPORT = 'import { cirrus } from "@cirrus/vite";';

/** Hoisted regex — matches a `cirrus(` call anywhere in the source. */
const CIRRUS_CALL_RE = /\bcirrus\s*\(/u;

/** Hoisted check for the cirrus/vite import specifier. */
const CIRRUS_VITE_DOUBLE = '"@cirrus/vite"';
const CIRRUS_VITE_SINGLE = "'@cirrus/vite'";

/**
 * Locate the config object inside a ts-morph SourceFile for a defineConfig
 * call expression whose first argument is an object literal.
 */
const findDefineConfigObject = (sf: ReturnType<InstanceType<typeof Project>["createSourceFile"]>): ObjectLiteralExpression | undefined => {
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
const findPlainExportObject = (sf: ReturnType<InstanceType<typeof Project>["createSourceFile"]>): ObjectLiteralExpression | undefined => {
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

/**
 * Build an in-memory ts-morph project and return the config object for the
 * given source text, or undefined when no recognisable shape is found.
 */
const findConfigObject = (sourceText: string): ObjectLiteralExpression | undefined => {
    const project = new Project({
        compilerOptions: { allowJs: true },
        useInMemoryFileSystem: true,
    });

    const sf = project.createSourceFile("vite.config.ts", sourceText, { overwrite: true });

    return findDefineConfigObject(sf) ?? findPlainExportObject(sf);
};

/**
 * Find the last top-level import declaration and return the position
 * immediately after it. Returns 0 when there are no imports so the new
 * import is prepended at the top.
 */
const importInsertPosition = (sourceText: string): number => {
    const project = new Project({
        compilerOptions: { allowJs: true },
        useInMemoryFileSystem: true,
    });

    const sf = project.createSourceFile("vite.config.ts", sourceText, { overwrite: true });
    const imports = sf.getImportDeclarations();

    if (imports.length === 0) {
        return 0;
    }

    const last = imports[imports.length - 1];

    if (last === undefined) {
        return 0;
    }

    return last.getEnd();
};

/** Splice the import for cirrus/vite into `ms` at the right position. */
const addImport = (ms: MagicString, source: string): void => {
    const insertAt = importInsertPosition(source);

    if (insertAt === 0) {
        ms.prepend(`${CIRRUS_IMPORT}\n`);
    } else {
        ms.appendLeft(insertAt, `\n${CIRRUS_IMPORT}`);
    }
};

/**
 * Insert `cirrus()` into the plugins array that `pluginsProp` points at.
 * When the array is empty, fills it; otherwise prepends before the first
 * element.
 */
const patchPluginsArray = (ms: MagicString, configObject: ObjectLiteralExpression): void => {
    const pluginsProp = configObject.getProperty("plugins");

    if (pluginsProp === undefined) {
        // No plugins key — add one as the first property.
        const properties = configObject.getProperties();
        const openBrace = configObject.getStart() + 1;

        if (properties.length === 0) {
            ms.appendLeft(openBrace, ` plugins: [${CIRRUS_CALL}] `);
        } else {
            const firstProp = properties[0];

            if (firstProp !== undefined) {
                ms.appendLeft(firstProp.getStart(), `plugins: [${CIRRUS_CALL}],\n    `);
            }
        }

        return;
    }

    // Property exists — find its array literal and prepend cirrus().
    const arrayLit = pluginsProp.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)[0];

    if (arrayLit === undefined) {
        return;
    }

    const elements = arrayLit.getElements();

    if (elements.length === 0) {
        ms.appendLeft(arrayLit.getStart() + 1, CIRRUS_CALL);
    } else {
        const firstElement = elements[0];

        if (firstElement !== undefined) {
            ms.appendLeft(firstElement.getStart(), `${CIRRUS_CALL}, `);
        }
    }
};

/**
 * Rewrite `source` so that it contains the cirrus/vite import and has
 * `cirrus()` as the first entry of the Vite `plugins` array (adding the
 * property when the config object exists but lacks it).
 *
 * Returns `{ code: source, changed: false, reason }` for any no-op path.
 */
const patchViteConfig = (source: string): PatchViteConfigResult => {
    if (CIRRUS_CALL_RE.test(source)) {
        return { changed: false, code: source, reason: "cirrus plugin already present" };
    }

    const configObject = findConfigObject(source);

    if (configObject === undefined) {
        return { changed: false, code: source, reason: "could not locate a Vite config plugins array to patch" };
    }

    const ms = new MagicString(source);
    const alreadyImported = source.includes(CIRRUS_VITE_DOUBLE) || source.includes(CIRRUS_VITE_SINGLE);

    if (alreadyImported) {
        patchPluginsArray(ms, configObject);
    } else {
        addImport(ms, source);
        patchPluginsArray(ms, configObject);
    }

    return { changed: true, code: ms.toString() };
};

export type { PatchViteConfigResult };
export { patchViteConfig };
