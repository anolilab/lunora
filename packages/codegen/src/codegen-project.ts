/**
 * Creates and refreshes the ts-morph project codegen reads, and locates its tsconfig.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { Project, ts } from "ts-morph";

import { listLunoraSourceFiles, listSecurityScanFiles } from "./discover/ast";
import { projectConfigCandidatePaths } from "./project-config-path";

const toPosixPath = (path: string): string => path.replaceAll("\\", "/");

/**
 * The exact set discovery reads: every non-`schema.ts` source file (the
 * canonical `listLunoraSourceFiles`, shared with function/migration discovery)
 * plus `schema.ts`, which `discoverSchema` loads separately. Reusing the
 * canonical walker keeps a freshly-built Project's file set in lockstep with a
 * refreshed one instead of forking the rules.
 */
const lunoraSeedFiles = (lunoraDirectory: string): string[] => {
    const paths = listLunoraSourceFiles(lunoraDirectory);
    const schemaPath = join(lunoraDirectory, "schema.ts");

    if (existsSync(schemaPath)) {
        paths.push(schemaPath);
    }

    return paths;
};

/**
 * The `.ts` files under `_generated/` at any depth, already on disk (lazy function
 * modules under `_generated/fn/`, service declarations). `syncProjectFile` overwrites them in
 * place, a no-op when the content is unchanged, instead of creating them (a change)
 * when absent. Listed here so a cold start and a warm refresh hold the same set.
 */
const generatedSeedFiles = (lunoraDirectory: string): string[] => {
    const generatedDirectory = join(lunoraDirectory, "_generated");

    return existsSync(generatedDirectory)
        ? readdirSync(generatedDirectory, { encoding: "utf8", recursive: true })
              .filter((name) => name.endsWith(".ts"))
              .map((name) => join(generatedDirectory, name))
              .filter((path) => statSync(path).isFile())
        : [];
};

/** Declaration files a tsconfig can list: `.d.ts`, `.d.mts` and `.d.cts`. */
const DECLARATION_FILE_RE = /\.d\.(?:ts|mts|cts)$/;

/** JavaScript files, which may be CommonJS modules with no `import` or `export` in them. */
const JAVASCRIPT_FILE_RE = /\.[cm]?jsx?$/;

/**
 * Text that can declare something program-wide or direct the compiler: a `declare`
 * keyword or a triple-slash line. A file with neither declares nothing that needs the
 * full parse below, so only its module status is asked.
 */
const MAY_DECLARE_RE = /\bdeclare\b|\/\/\//;

/**
 * A `.ts` file that opens with a module declaration: `export ...`, or `import` followed
 * by a binding list, a namespace, or a module name. Read from the first token of the
 * code, so a comment cannot answer it. Anything else (`import x = ...`, a directive or
 * an expression first) is left to the parser.
 */
const opensWithModuleSyntax = (text: string): boolean => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
    const first = scanner.scan();

    if (first === ts.SyntaxKind.ExportKeyword) {
        return true;
    }

    if (first !== ts.SyntaxKind.ImportKeyword) {
        return false;
    }

    const second = scanner.scan();

    return second === ts.SyntaxKind.OpenBraceToken || second === ts.SyntaxKind.AsteriskToken || second === ts.SyntaxKind.StringLiteral;
};

/** `require` called, or `exports` / `module.exports` used as a property base. */
const isCommonJsReference = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node)) {
        return ts.isIdentifier(node.expression) && node.expression.text === "require";
    }

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        return node.expression.text === "exports" || (node.expression.text === "module" && node.name.text === "exports");
    }

    return false;
};

/**
 * Whether a JavaScript file is CommonJS. ponytail: a syntactic stand-in for the
 * binder's CommonJS indicator, which is not public API. It also counts uses inside
 * functions, which can only over-include a file, never drop one.
 */
const usesCommonJs = (node: ts.Node): boolean => isCommonJsReference(node) || ts.forEachChild(node, usesCommonJs) === true;

/** A top-level `declare global` block, which is a global declaration wherever it sits. */
const isGlobalAugmentation = (statement: ts.Statement): boolean =>
    ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === "global";

/** What codegen needs to know about one tsconfig source file, from its text. */
interface SourceAnalysis {
    /** The module names it augments: top-level `declare module "x"`. */
    augments: string[];
    /** Whether it declares a global or carries a triple-slash directive, which apply program-wide. */
    hasGlobal: boolean;
    /** Whether the file is a module, whose declarations stay in its own scope rather than the program's. */
    isModule: boolean;
}

/** Each file's analysis, keyed on a hash of its text so an unchanged file is not parsed again. */
const analysisCache = new Map<string, { analysis: SourceAnalysis; key: string }>();

/** Classifies one file. The text-only fast paths answer most files without a parse. */
const computeAnalysis = (path: string, text: string, forceModules: boolean): SourceAnalysis => {
    if (!MAY_DECLARE_RE.test(text) && (forceModules || opensWithModuleSyntax(text))) {
        return { augments: [], hasGlobal: false, isModule: true };
    }

    // The parser decides everything the fast paths cannot, so a comment, string,
    // regex, JSX text or property name never reads as module syntax.
    const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
    const hasReference = sourceFile.referencedFiles.length > 0 || sourceFile.typeReferenceDirectives.length > 0 || sourceFile.libReferenceDirectives.length > 0;

    return {
        augments: sourceFile.statements.flatMap((statement) =>
            ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name) ? [statement.name.text] : [],
        ),
        hasGlobal: hasReference || sourceFile.statements.some((statement) => isGlobalAugmentation(statement)),
        // `moduleDetection: "force"` makes every non-declaration file a module, so the
        // parser's own answer is not consulted under it.
        isModule: forceModules || ts.isExternalModule(sourceFile) || (JAVASCRIPT_FILE_RE.test(path) && usesCommonJs(sourceFile)),
    };
};

/** The analysis of one tsconfig source file, reused while its text is unchanged. */
const analyzeSource = (path: string, text: string, forceModules: boolean): SourceAnalysis => {
    const key = `${forceModules ? "force" : "auto"}:${createHash("sha256").update(text).digest("hex")}`;
    const cached = analysisCache.get(path);

    if (cached?.key === key) {
        return cached.analysis;
    }

    const analysis = computeAnalysis(path, text, forceModules);

    analysisCache.set(path, { analysis, key });

    return analysis;
};

/** The parsed tsconfig, keyed on its own mtime and size. */
interface TsconfigInfo {
    /** Every file the tsconfig names or includes, whether or not it exists. */
    fileNames: string[];
    /** Whether `moduleDetection` is `"force"`. */
    forceModules: boolean;
}

/**
 * The tsconfig's file list and `moduleDetection`, read by the tsconfig parser. Held per
 * Project (see `tsconfigInfos`), not per process: a Project dropped because a tsconfig
 * the user extends changed must not keep serving the old list on the next create.
 * ponytail: the `include` globs run once per Project. A source file created later that
 * they match is seen by the next Project, not the next save. A file named in `files` is
 * seen at once, since it is listed (absent or not) and checked for existence each refresh.
 */
const readTsconfig = (tsconfigPath: string): TsconfigInfo => {
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (): void => {} };
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, host);

    return {
        fileNames: parsed?.fileNames ?? [],
        forceModules: parsed?.options.moduleDetection === ts.ModuleDetectionKind.Force,
    };
};

/** The tsconfig each Project was built from, so a refresh reuses it rather than re-globbing. */
const tsconfigInfos = new WeakMap<Project, TsconfigInfo>();

/** A tsconfig source that augments modules, and the module names it augments. */
interface AugmentationCandidate {
    augments: string[];
    path: string;
}

/** The files a Project starts from, and the augmentations it adds only once a `lunora/` source reaches their module. */
interface ProgramSeeds {
    augmentations: AugmentationCandidate[];
    files: string[];
}

/**
 * The seeds for `lunoraDirectory`: the `lunora/` sources, the security-scan entries, the
 * `_generated/` files, the tsconfig's declarations, and the tsconfig's global
 * declarations. A global declaration is a script, a `declare global` or a triple-slash
 * directive, which apply program-wide with no import edge from `lunora/`. Each tsconfig
 * source is read and analysed here, so a refresh sees edits to them.
 */
const programSeeds = (lunoraDirectory: string, tsconfig: TsconfigInfo | undefined): ProgramSeeds => {
    const { fileNames = [], forceModules = false } = tsconfig ?? {};
    const lunoraPrefix = `${toPosixPath(lunoraDirectory)}/`;
    const declarations: string[] = [];
    const globals: string[] = [];
    const augmentations: AugmentationCandidate[] = [];

    for (const path of fileNames) {
        if (!existsSync(path)) {
            continue;
        }

        if (DECLARATION_FILE_RE.test(path)) {
            declarations.push(path);
            continue;
        }

        if (toPosixPath(path).startsWith(lunoraPrefix)) {
            continue;
        }

        const analysis = analyzeSource(path, readFileSync(path, "utf8"), forceModules);

        if (!analysis.isModule || analysis.hasGlobal) {
            globals.push(path);
        } else if (analysis.augments.length > 0) {
            augmentations.push({ augments: analysis.augments, path });
        }
    }

    return {
        augmentations,
        files: [
            ...new Set([
                ...lunoraSeedFiles(lunoraDirectory),
                ...listSecurityScanFiles(lunoraDirectory).map(({ filePath }) => filePath),
                ...generatedSeedFiles(lunoraDirectory),
                ...declarations,
                ...globals,
                ...projectConfigCandidatePaths(lunoraDirectory).filter((path) => existsSync(path)),
            ]),
        ],
    };
};

/**
 * The key a module name is matched by: the file the compiler resolves it to, from the file
 * that names it. That makes `"./router"` in one file, `"../dir/router"` in another and a
 * tsconfig path alias such as `"@/router"` match when they reach the same file. A name
 * that does not resolve (a package not installed) is matched as written.
 */
const moduleKey = (specifier: string, fromPath: string, options: ts.CompilerOptions): string =>
    ts.resolveModuleName(specifier, fromPath, options, ts.sys).resolvedModule?.resolvedFileName ?? specifier;

/**
 * The module keys the reached files import, read from each file's text by the scanner.
 * Imports inside `node_modules` are skipped: a package augmenting a module it imports is
 * the one case this does not follow.
 */
const importedModuleKeys = (project: Project, reached: ReadonlySet<string>): Set<string> => {
    const options = project.getCompilerOptions();
    const keys = new Set<string>();

    for (const path of reached) {
        const sourceFile = project.getSourceFile(path);

        if (sourceFile === undefined) {
            continue;
        }

        for (const { fileName } of ts.preProcessFile(sourceFile.getFullText(), true, false).importedFiles) {
            keys.add(moduleKey(fileName, sourceFile.getFilePath(), options));
        }
    }

    return keys;
};

/**
 * The files of `project` reached from `roots` by imports and references, outside
 * `node_modules`, as POSIX paths. Edges come from the compiler's own resolution, read
 * from each file's text, rather than ts-morph's reference container: that container
 * holds stale entries after a refresh, and walking it made the next program build throw.
 */
const reachedFiles = (project: Project, roots: string[]): Set<string> => {
    const options = project.getCompilerOptions();
    const resolvedImports = new Map<string, string | undefined>();
    const reached = new Set<string>();
    const pending = [...roots];

    const neighbours = (filePath: string, text: string): string[] => {
        const directory = dirname(filePath);
        const info = ts.preProcessFile(text, true, true);
        const found = info.referencedFiles.map(({ fileName }) => join(directory, fileName));

        for (const { fileName } of info.importedFiles) {
            const key = `${directory}\0${fileName}`;

            if (!resolvedImports.has(key)) {
                resolvedImports.set(key, ts.resolveModuleName(fileName, filePath, options, ts.sys).resolvedModule?.resolvedFileName);
            }

            const resolved = resolvedImports.get(key);

            if (resolved !== undefined) {
                found.push(resolved);
            }
        }

        return found;
    };

    while (pending.length > 0) {
        const path = pending.pop();

        if (path === undefined || toPosixPath(path).includes("/node_modules/") || reached.has(toPosixPath(path))) {
            continue;
        }

        reached.add(toPosixPath(path));

        const sourceFile = project.getSourceFile(path);

        if (sourceFile !== undefined) {
            pending.push(...neighbours(sourceFile.getFilePath(), sourceFile.getFullText()));
        }
    }

    return reached;
};

/**
 * Settles which augmentations the program holds, then drops every file it no longer
 * reaches. Each round, the files reached from the seeds and the augmentations chosen so
 * far import modules, and a candidate whose module one of them imports is chosen and
 * loaded if absent. Loading one can reach more files, so this repeats until none is
 * chosen. A candidate whose module is no longer imported is not chosen, so a refresh
 * drops it along with what only it imported.
 */
const settleProgram = (project: Project, roots: string[], candidates: AugmentationCandidate[]): void => {
    const options = project.getCompilerOptions();
    const chosen: string[] = [];
    let reached: Set<string>;

    for (;;) {
        project.resolveSourceFileDependencies();
        reached = reachedFiles(project, [...roots, ...chosen]);

        const pending = candidates.filter((candidate) => !chosen.includes(candidate.path));

        if (pending.length === 0) {
            break;
        }

        const keys = importedModuleKeys(project, reached);
        const matching = pending.filter((candidate) => candidate.augments.some((name) => keys.has(moduleKey(name, candidate.path, options))));

        if (matching.length === 0) {
            break;
        }

        for (const candidate of matching) {
            if (project.getSourceFile(candidate.path) === undefined) {
                project.createSourceFile(candidate.path, readFileSync(candidate.path, "utf8"), { overwrite: true });
            }
        }

        chosen.push(...matching.map((candidate) => candidate.path));
    }

    for (const sourceFile of project.getSourceFiles()) {
        if (!sourceFile.isInNodeModules() && !reached.has(sourceFile.getFilePath())) {
            project.removeSourceFile(sourceFile);
        }
    }
};

/**
 * Walk up from `startPath` until we find a `tsconfig.json` or hit the file
 * system root. Returns the absolute path to the tsconfig, or `undefined`.
 *
 *
 * Exported (see the bottom-of-file `export { findTsconfig }`) so a long-lived
 * caller (the Vite dev-loop's cached-Project invalidation) can ask "which
 * tsconfig would `createCodegenProject` resolve right now?" without
 * duplicating the walk — recomputing it per call is a handful of `existsSync`
 * checks, negligible next to a Project rebuild.
 */
export const findTsconfig = (startPath: string): string | undefined => {
    let directory = existsSync(startPath) ? startPath : dirname(startPath);

    while (directory && directory !== dirname(directory)) {
        const candidate = join(directory, "tsconfig.json");

        if (existsSync(candidate)) {
            return candidate;
        }

        directory = dirname(directory);
    }

    return undefined;
};

/**
 * What a tsconfig resolves to once its `extends` chain is applied: the compiler settings and the file list TypeScript
 * computes from it. A change in any config the chain reaches shows up here, where the selected file's own bytes would not.
 */
export const tsconfigFingerprint = (tsconfigPath: string): string => {
    const host: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined };
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, host);

    if (parsed === undefined) {
        return "";
    }

    return JSON.stringify({ fileNames: parsed.fileNames.toSorted((left, right) => left.localeCompare(right)), options: parsed.options });
};

/**
 * Construct the ts-morph `Project` codegen discovers over. Prefers the user's
 * `tsconfig.json` (when one is found walking up from `lunoraDirectory`) so
 * cross-file type resolution and path aliases work; falls back to an isolated
 * project otherwise. This is the exact construction `runCodegen` uses
 * when no `project` is injected — exported so a long-lived caller (the Vite
 * dev-loop) can build one once and reuse it across runs via
 * {@link refreshCodegenProject} instead of re-parsing the user's whole TS
 * program on every save.
 *
 * The program is seeded with the `lunora/` sources, the tsconfig's ambient and global
 * declarations, and whatever those import. The app's UI and tests reach it only by
 * being imported, which is all type resolution needs, so a project whose tsconfig
 * includes a whole frontend does not pay to parse it on a cold run.
 */
export const createCodegenProject = (lunoraDirectory: string): Project => {
    const tsconfigPath = findTsconfig(lunoraDirectory);

    if (tsconfigPath === undefined) {
        return new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    }

    const project = new Project({ skipAddingFilesFromTsConfig: true, tsConfigFilePath: tsconfigPath, useInMemoryFileSystem: false });
    const tsconfig = readTsconfig(tsconfigPath);

    tsconfigInfos.set(project, tsconfig);

    const seeds = programSeeds(lunoraDirectory, tsconfig);

    // `createSourceFile` from the text, not `addSourceFilesAtPaths`: adding a file that
    // sits directly in the project root (`lunora.config.ts`, a root
    // `worker-configuration.d.ts`) before the program exists makes ts-morph walk the
    // root's directory tree — `node_modules` included — and the run never finishes.
    for (const path of seeds.files) {
        project.createSourceFile(path, readFileSync(path, "utf8"), { overwrite: true });
    }

    // Registers the files those seeds import (a validator shared from `src/`) as Project
    // files, which a full tsconfig program gets from `include`. Without it
    // `refreshCodegenProject` cannot see them, and a reused Project keeps serving the
    // first copy it parsed. It builds the program here instead of on the first type
    // query — the same work, in a different place.
    settleProgram(project, seeds.files, seeds.augmentations);

    return project;
};

/**
 * Synchronise a reused `createCodegenProject` Project with the current on-disk state of
 * `lunoraDirectory`, so the next `runCodegen` sees the same files a freshly-constructed
 * Project would — without re-parsing the whole TS program.
 *
 * The seeds are re-read and created or refreshed; every other file the Project holds is
 * refreshed from disk too (a deleted one drops out). Then the Project keeps exactly the
 * files reached from the seeds and the augmentations whose module is still imported. A
 * file a `lunora/` source stops importing is therefore dropped, and one it still imports
 * stays put, so the program is rebuilt only when the files it holds actually change.
 * `node_modules` is left alone: its `.d.ts` set dominates the file count and never
 * changes mid dev-loop.
 */
export const refreshCodegenProject = (project: Project, lunoraDirectory: string): void => {
    const tsconfigPath = findTsconfig(lunoraDirectory);
    const seeds = programSeeds(lunoraDirectory, tsconfigInfos.get(project) ?? (tsconfigPath === undefined ? undefined : readTsconfig(tsconfigPath)));

    for (const path of seeds.files) {
        const existing = project.getSourceFile(path);

        if (existing === undefined) {
            // From the text, as the cold start does: a root-level file added from disk
            // walks the project root's tree, `node_modules` included.
            project.createSourceFile(path, readFileSync(path, "utf8"), { overwrite: true });
        } else {
            existing.refreshFromFileSystemSync();
        }
    }

    const seedPaths = new Set(seeds.files);

    // Before the reachability walk, so it reads current text. A file deleted from disk
    // is forgotten by ts-morph here; one that cannot be read at all is dropped, so a
    // permission change cannot wedge the dev loop.
    for (const sourceFile of project.getSourceFiles()) {
        if (seedPaths.has(sourceFile.getFilePath()) || sourceFile.isInNodeModules()) {
            continue;
        }

        try {
            sourceFile.refreshFromFileSystemSync();
        } catch {
            project.removeSourceFile(sourceFile);
        }
    }

    settleProgram(project, seeds.files, seeds.augmentations);
};
