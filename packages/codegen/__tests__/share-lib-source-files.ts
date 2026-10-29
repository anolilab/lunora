import { createRequire } from "node:module";

import { ts } from "ts-morph";

/**
 * Vitest setup file: every ts-morph `Project` in a worker reuses one parsed and
 * bound copy of TypeScript's lib `.d.ts` files instead of parsing its own.
 *
 * Parsing and binding the libs is most of what a Project's first type query
 * costs, and nearly every spec builds fresh Projects. A lib file is safe to share
 * because it is immutable and the binder caches its result on the SourceFile —
 * the TypeScript language service shares them across programs the same way. The
 * key therefore carries TypeScript's own sharing key for the compiler options,
 * so a Project with different options never sees a lib bound under someone
 * else's. Fixture files are never shared: a file only counts as a lib when both
 * its path and its text match ts-morph's bundled copy.
 *
 * Patching the prototype rather than a codegen factory, because the specs build
 * their Projects with `new Project(...)` directly. Production gains nothing from
 * it: `createCodegenProject` already builds one Project and reuses it.
 */

interface SharedRegistry {
    acquireDocument: (fileName: string, settings: ts.CompilerOptions, snapshot: ts.IScriptSnapshot, version: string, kind?: ts.ScriptKind) => ts.SourceFile;
    createOrUpdateSourceFile: (fileName: string, settings: ts.CompilerOptions, snapshot: ts.IScriptSnapshot, kind?: ts.ScriptKind) => ts.SourceFile;
}

// ts-morph's own copy: `@ts-morph/common` is not a dependency of this package, and a second copy would be patched for nobody.
const requireFromTsMorph = createRequire(createRequire(import.meta.url).resolve("ts-morph"));
const { DocumentRegistry, getLibFiles } = requireFromTsMorph("@ts-morph/common") as {
    DocumentRegistry: { prototype: SharedRegistry };
    getLibFiles: () => { fileName: string; text: string }[];
};

// ts-morph serves its bundled libs from this virtual folder unless a Project sets `libFolderPath`.
const LIB_FOLDER = "/node_modules/typescript/lib/";
const INSTALLED = Symbol.for("lunora.codegen.sharedLibSourceFiles");

const prototype = DocumentRegistry.prototype as SharedRegistry & { [INSTALLED]?: true };

// Setup files run once per spec file, but ts-morph is externalised and stays loaded across them: patch once.
if (prototype[INSTALLED] === undefined) {
    const libTexts = new Map(getLibFiles().map((file) => [LIB_FOLDER + file.fileName, file.text]));
    const settingsKeys = ts.createDocumentRegistry();
    const cache = new Map<string, ts.SourceFile>();

    const shared = (
        fileName: string,
        settings: ts.CompilerOptions,
        snapshot: ts.IScriptSnapshot,
        kind: ts.ScriptKind | undefined,
        parse: () => ts.SourceFile,
    ): ts.SourceFile => {
        const libText = libTexts.get(fileName);

        if (libText === undefined || snapshot.getText(0, snapshot.getLength()) !== libText) {
            return parse();
        }

        const key = `${fileName}|${String(kind)}|${settingsKeys.getKeyForCompilationSettings(settings)}`;
        let sourceFile = cache.get(key);

        if (sourceFile === undefined) {
            sourceFile = parse();
            cache.set(key, sourceFile);
        }

        return sourceFile;
    };

    const { acquireDocument, createOrUpdateSourceFile } = prototype;

    prototype.createOrUpdateSourceFile = function createOrUpdateSharedSourceFile(fileName, settings, snapshot, kind) {
        return shared(fileName, settings, snapshot, kind, () => createOrUpdateSourceFile.call(this, fileName, settings, snapshot, kind));
    };

    prototype.acquireDocument = function acquireSharedDocument(fileName, settings, snapshot, version, kind) {
        return shared(fileName, settings, snapshot, kind, () => acquireDocument.call(this, fileName, settings, snapshot, version, kind));
    };

    prototype[INSTALLED] = true;
}
