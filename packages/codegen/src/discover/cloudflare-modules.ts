import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { CallExpression, ImportDeclaration, ImportEqualsDeclaration, SourceFile } from "ts-morph";
import { Node, Project, SyntaxKind, ts } from "ts-morph";

import { descendantsOfKind, listLunoraSourceFiles } from "./ast";

/** The scheme of the Workers runtime's built-in modules: `cloudflare:workers`, `cloudflare:email`, `cloudflare:sockets`, … */
const CLOUDFLARE_SCHEME = "cloudflare:";

/** Type declarations, never bundled: `.d.ts`, and the module-format `.d.mts` and `.d.cts`. */
const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"] as const;

/** Every extension the worker bundle takes, tried in this order for an extensionless specifier. */
const BUNDLED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * The TypeScript files a JavaScript extension in a specifier may name: under
 * `moduleResolution: "bundler"` (and NodeNext) `./x.js` is written for `./x.ts`.
 */
const SOURCE_FOR_EMITTED: Readonly<Record<string, ReadonlyArray<string>>> = {
    ".cjs": [".cts"],
    ".js": [".ts", ".tsx"],
    ".jsx": [".tsx"],
    ".mjs": [".mts"],
};

/** One app module that loads `cloudflare:*` built-ins, and which. */
interface CloudflareModuleImport {
    /** The importing file, relative to the project root (`lunora/mail/index.ts`). */
    module: string;
    /** The `cloudflare:*` specifiers it loads, in source order, each once. */
    specifiers: ReadonlyArray<string>;
}

/**
 * Whether an import declaration loads its module at runtime. Only a whole
 * `import type { … } from …` is erased. Under `verbatimModuleSyntax`, which the
 * repo base and several templates set, `import { type Env } from "m"` is kept as
 * `import {} from "m"` and still loads `m`, so inline `type` specifiers count.
 * The rule does not read the app's tsconfig: a false refusal costs one keyword
 * (`import type`) to fix, and a missed one fails at boot.
 */
const loadsAtRuntime = (declaration: ImportDeclaration): boolean => !declaration.isTypeOnly();

/** `import env = require("m")`'s module, the TypeScript CommonJS form a `.cts` helper uses; none when type-only. */
const requireEqualsSpecifier = (declaration: ImportEqualsDeclaration): string | undefined => {
    const reference = declaration.getModuleReference();

    if (declaration.isTypeOnly() || !Node.isExternalModuleReference(reference)) {
        return undefined;
    }

    const expression = reference.getExpression();

    return expression !== undefined && Node.isStringLiteral(expression) ? expression.getLiteralValue() : undefined;
};

/**
 * The module an `import("…")` or `require("…")` call loads, when its argument is a
 * literal. A dynamic import fails only when it runs (the mail starter's
 * `cloudflare:email` send), but it still names a module the target does not have,
 * so it is refused with the rest; a `require` is what a `.cjs` or `.cts` helper the
 * walk reaches loads with. Any callee spelled `require` counts, whatever binds it:
 * a loader made locally (`const require = createRequire(import.meta.url)`) loads
 * the module as surely as the global one, so this fails closed, and a local
 * function of that name that loads nothing is refused until it is renamed. A method named
 * `require` counts the same way, whatever it is called on: `module.require` is Node's own
 * loader, and an object's `require` is assumed to be one. A backtick literal with no
 * substitutions is as static as a quoted one.
 */
const loadCallSpecifier = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();
    const [argument] = call.getArguments();
    const loads =
        callee.getKind() === SyntaxKind.ImportKeyword ||
        (Node.isIdentifier(callee) && callee.getText() === "require") ||
        (Node.isPropertyAccessExpression(callee) && callee.getName() === "require");

    if (!loads || argument === undefined) {
        return undefined;
    }

    if (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) {
        return argument.getLiteralValue();
    }

    // ``import(`cloudflare:${name}`)`` names some built-in, which one known only at runtime: refused
    // on its static head, reported as `cloudflare:*`. A head naming anything else, or no literal at
    // all (`import(name)`), is not resolved: there is no file to follow.
    if (Node.isTemplateExpression(argument)) {
        const head = argument.getHead().getLiteralText();

        return head.startsWith(CLOUDFLARE_SCHEME) ? `${head}*` : undefined;
    }

    return undefined;
};

/**
 * The module specifiers a file loads at runtime, in source order, each once:
 * static imports, re-exports and `import("…")` calls with a literal argument.
 * Type-only declarations erase, so neither their module nor anything it imports
 * is bundled.
 */
const runtimeSpecifiersOf = (sourceFile: SourceFile): string[] => {
    const found = new Set<string>();
    const note = (specifier: string | undefined): void => {
        if (specifier !== undefined) {
            found.add(specifier);
        }
    };

    for (const declaration of sourceFile.getImportDeclarations()) {
        if (loadsAtRuntime(declaration)) {
            note(declaration.getModuleSpecifierValue());
        }
    }

    // The same rule as imports: `export { type X } from "m"` keeps `export {} from "m"` under
    // `verbatimModuleSyntax`, so only a whole `export type { … } from …` is erased.
    for (const declaration of sourceFile.getExportDeclarations()) {
        if (!declaration.isTypeOnly()) {
            note(declaration.getModuleSpecifierValue());
        }
    }

    for (const declaration of descendantsOfKind(sourceFile, SyntaxKind.ImportEqualsDeclaration)) {
        note(requireEqualsSpecifier(declaration));
    }

    for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
        note(loadCallSpecifier(call));
    }

    return [...found];
};

/** Whether `path` is an existing file (not a directory). */
const isFile = (path: string): boolean => {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
};

/**
 * The `exports` conditions only a Worker build matches. The Node target has no
 * bundler of its own to read conditions from (its driver has no toolchain; the
 * app runs in the operator's own Node process), so the walk cannot pick the one
 * entry Node would and stays fail-closed over every other condition. It drops
 * only these: a dual package's `workerd` or `worker` entry is the half a Node
 * process never loads, and importing `cloudflare:workers` there is the point of it.
 */
const WORKER_ONLY_CONDITIONS: ReadonlySet<string> = new Set(["browser", "worker", "workerd"]);

/**
 * Every string target in a `package.json` `exports` value: its `"."` entry, or
 * top-level conditions, and every nested condition or fallback array beneath,
 * less the {@link WORKER_ONLY_CONDITIONS} branches. A `null` anywhere is "no
 * target", which `exports` uses to block a path, so it contributes nothing
 * rather than being walked.
 */
const exportTargets = (value: unknown, atRoot = true): string[] => {
    if (typeof value === "string") {
        return [value];
    }

    if (value === null || typeof value !== "object") {
        return [];
    }

    const entries = value as Record<string, unknown>;

    if (atRoot && Object.hasOwn(entries, ".")) {
        return exportTargets(entries["."], false);
    }

    return Object.entries(entries)
        .filter(([condition]) => !WORKER_ONLY_CONDITIONS.has(condition))
        .flatMap(([, target]) => exportTargets(target, false));
};

/** Whether `path` is an existing directory. */
const isDirectory = (path: string): boolean => {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
};

/**
 * The entry paths a local package directory's `package.json` names: `main`,
 * `module`, and every `exports` target. Raw, relative to the directory; each is
 * expanded by {@link runtimeCandidates} like any other path. Empty when the
 * directory has no readable manifest.
 */
const packageEntries = (directory: string): string[] => {
    let manifest: Record<string, unknown>;

    try {
        manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
        return [];
    }

    return [...[manifest.main, manifest.module].filter((entry): entry is string => typeof entry === "string"), ...exportTargets(manifest.exports)];
};

/** Whether `path` names a type declaration file, which is never bundled. */
const isDeclaration = (path: string): boolean => DECLARATION_EXTENSIONS.some((extension) => path.endsWith(extension));

/**
 * Every file the bundler could load for a path, the one rule a relative import,
 * an alias and a package entrypoint all go through, so no entry path can expand
 * differently from another. That is the exact file; for a JavaScript extension
 * (`.js`, `.mjs`, `.cjs`, `.jsx`), that file and the TypeScript sources it may be
 * written for (`.ts`/`.tsx`, `.mts`, `.cts`); with no extension, the path with
 * every runtime extension; for a directory, its `index.*` and every
 * `package.json` entry fed back through this same rule (a `main: "./dist"` is a
 * directory too). A declaration (`.d.ts`, `.d.mts`, `.d.cts`) stands for its
 * implementation and is never returned itself.
 *
 * All of them, not the first that exists, so the answer does not depend on the
 * bundler's resolution order (esbuild tries `.tsx` before `.ts`, for one). When
 * two candidates share a base name, a `cloudflare:*` import in either is
 * reported: that fails closed, at the cost of a false refusal when only the other
 * one is bundled, which an explicit path fixes. `seen` makes a package entry that
 * names its own directory terminate.
 */
const runtimeCandidates = (target: string, seen: Set<string> = new Set()): string[] => {
    if (seen.has(target)) {
        return [];
    }

    seen.add(target);

    const declaration = DECLARATION_EXTENSIONS.find((extension) => target.endsWith(extension));

    if (declaration !== undefined) {
        return runtimeCandidates(target.slice(0, -declaration.length), seen);
    }

    const written = BUNDLED_EXTENSIONS.find((extension) => target.endsWith(extension));
    const files =
        written === undefined
            ? [target, ...BUNDLED_EXTENSIONS.map((extension) => target + extension)]
            : [target, ...(SOURCE_FOR_EMITTED[written] ?? []).map((source) => target.slice(0, -written.length) + source)];
    const found = files.filter((file) => isFile(file));

    if (isDirectory(target)) {
        found.push(...BUNDLED_EXTENSIONS.map((extension) => join(target, `index${extension}`)).filter((file) => isFile(file)));

        for (const entry of packageEntries(target)) {
            found.push(...runtimeCandidates(resolve(target, entry), seen));
        }
    }

    return [...new Set(found)].filter((file) => !isDeclaration(file));
};

/** Every file a relative specifier may name, by {@link runtimeCandidates}. */
const resolveRelative = (fromFile: string, specifier: string): string[] => runtimeCandidates(resolve(dirname(fromFile), specifier));

/**
 * The path an alias specifier named, recovered from the one file TypeScript
 * resolved it to, so {@link runtimeCandidates} can expand it as it expands a
 * relative path. TypeScript's answer carries its own extension (`.ts` for
 * `@shared/bridge.js`, or a declaration), so the file's stem is taken and given the
 * extension the specifier wrote, or none when it wrote none; a directory the
 * specifier named is restored when TypeScript answered with its `index` file.
 */
const aliasTarget = (resolvedFile: string, specifier: string): string => {
    const resolvedExtension = [...DECLARATION_EXTENSIONS, ...BUNDLED_EXTENSIONS].find((extension) => resolvedFile.endsWith(extension)) ?? "";
    const stem = resolvedFile.slice(0, resolvedFile.length - resolvedExtension.length);
    const written = BUNDLED_EXTENSIONS.find((extension) => specifier.endsWith(extension));

    if (written !== undefined) {
        return stem + written;
    }

    return basename(stem) === "index" && !specifier.endsWith("index") ? dirname(stem) : stem;
};

/**
 * Codegen's own output and installed packages are never the app's to fix: a
 * relative import into `_generated/` (which loads `cloudflare:workers` itself for
 * a sharded schema) or `node_modules` is not followed. Judged on the path from the
 * project root, never the absolute one, so a checkout that happens to live under
 * a directory with either name (`/tmp/_generated/app`) is still walked. A `..`
 * segment, for an import that leaves the root, is not a directory name.
 */
const isOutsideAppCode = (root: string, path: string): boolean =>
    relative(root, path)
        .split(sep)
        .some((segment) => segment === "_generated" || segment === "node_modules");

/**
 * The file a non-relative specifier names through an alias the project
 * supports: `#lunora/*` from `package.json` `imports`, or a tsconfig `paths`
 * entry. Resolved exactly as the rest of discovery resolves an import (the
 * project's own compiler options and resolution host). A package the specifier
 * names is dropped here, where resolution says so; whether the file is followed
 * is the same {@link isFollowable} rule a relative import's target meets, so a
 * helper outside `lunora/`, or outside the project root, is followed either way.
 */
const resolveAlias = (project: Project, filePath: string, specifier: string): string[] => {
    // TypeScript 6 resolves `package.json` `imports` (`#lunora/*`) under its default options too,
    // so a project with no tsconfig needs no second resolution mode.
    const resolved = ts.resolveModuleName(specifier, filePath, project.getCompilerOptions(), project.getModuleResolutionHost()).resolvedModule;

    if (resolved === undefined || resolved.isExternalLibraryImport === true) {
        return [];
    }

    // Every file the named path may be, by the same rule as a relative import.
    return runtimeCandidates(aliasTarget(resolved.resolvedFileName, specifier));
};

/**
 * Whether the walk follows into a file, for a relative and an alias target alike:
 * anything but a declaration file (`.d.ts`, `.d.mts`, `.d.cts`), `node_modules` or
 * `_generated/` output.
 */
const isFollowable = (root: string, file: string): boolean =>
    !DECLARATION_EXTENSIONS.some((extension) => file.endsWith(extension)) && !isOutsideAppCode(root, file);

/** The files a module's specifiers may reach, relative or through an alias, that the walk follows. */
const appFilesReachedFrom = (project: Project, root: string, filePath: string, specifiers: ReadonlyArray<string>): string[] =>
    specifiers
        .filter((specifier) => !specifier.startsWith(CLOUDFLARE_SCHEME))
        .flatMap((specifier) => (specifier.startsWith(".") ? resolveRelative(filePath, specifier) : resolveAlias(project, filePath, specifier)))
        .filter((file) => isFollowable(root, file));

/**
 * One key per file: its real path, so a file reached through a symlinked
 * directory and through its own path is walked once, and a link back into an
 * ancestor cannot make the walk go round forever.
 */
const fileKey = (path: string): string => {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
};

/**
 * Every app module the worker bundle would load from `lunora/` that loads a
 * `cloudflare:*` built-in, for the platform gate to refuse on a target that has
 * none.
 *
 * The walk starts from the modules codegen reads and follows their relative
 * imports, static and dynamic, into whatever file they reach, because that is
 * what the bundle contains. A file matched by `codegen.exclude` is followed into
 * (exclusion keeps it out of function discovery, not out of the bundle), and so
 * is a `.tsx`, `.mts`, `.cts` or JavaScript helper, which the lister never lists.
 * Every reached file is examined: the diagnostic names each module, so there is
 * no early exit once one is found.
 */
const discoverCloudflareModuleImports = (project: Project, lunoraDirectory: string, workerEntry?: string): CloudflareModuleImport[] => {
    // Paths are shown from the project root, so the `lunora/` prefix tells the reader where to look.
    const root = dirname(lunoraDirectory);
    // The lister leaves out the root `schema.ts`, which `discoverSchema` reads on its own, but
    // the generated shard imports it, so it and whatever it imports are in the bundle too.
    const rootSchema = join(lunoraDirectory, "schema.ts");
    // The walk starts where the bundle does: the `lunora/` modules, the root schema, and the one
    // worker entry the caller resolved. Anything else reaches the bundle only through an import
    // from those, so a file nothing imports (an unused `main`, a helper beside the entry) is not
    // judged.
    const pending = [
        ...new Set([
            ...listLunoraSourceFiles(lunoraDirectory),
            ...[rootSchema, ...(workerEntry === undefined ? [] : [workerEntry])].filter((file) => isFile(file)),
        ]),
        // The roots meet the rule a followed file does: a declaration is never bundled, so its
        // type-only `cloudflare:workers` import (`lunora/env.d.ts`) is not the app's to answer for.
    ].filter((file) => !isDeclaration(file));
    // Files the walk reads that the shared Project does not already hold are parsed here, in a
    // Project of its own, and never added to the shared one: every later pass over the shared
    // Project (suppression directives, for one) would otherwise judge them as app code, on every
    // target. The walk reads syntax only, so it needs no program of their own.
    const scratch = new Project({ compilerOptions: { allowJs: true }, skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    const seen = new Set(pending.map((file) => fileKey(file)));
    const found: CloudflareModuleImport[] = [];

    for (let filePath = pending.shift(); filePath !== undefined; filePath = pending.shift()) {
        const specifiers = runtimeSpecifiersOf(project.getSourceFile(filePath) ?? scratch.getSourceFile(filePath) ?? scratch.addSourceFileAtPath(filePath));
        const cloudflare = specifiers.filter((specifier) => specifier.startsWith(CLOUDFLARE_SCHEME));

        if (cloudflare.length > 0) {
            found.push({ module: relative(root, filePath) || basename(filePath), specifiers: cloudflare });
        }

        for (const file of appFilesReachedFrom(project, root, filePath, specifiers)) {
            const key = fileKey(file);

            if (!seen.has(key)) {
                seen.add(key);
                pending.push(file);
            }
        }
    }

    return found;
};

export type { CloudflareModuleImport };
export { discoverCloudflareModuleImports };
