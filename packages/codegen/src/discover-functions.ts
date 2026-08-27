import type {
    ArrowFunction,
    CallExpression,
    FunctionExpression,
    Identifier,
    ImportDeclaration,
    ObjectLiteralExpression,
    Project,
    SourceFile,
    Symbol as TsSymbol,
    Type,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-ast";
import type { ExposeCacheIR, FunctionIR, ValidatorIR } from "./ir";
import { isServerSurfaceModule } from "./module-specifiers";
import { parseObjectShape, parseValidator } from "./parse-validator";
import sanitizeNamespace from "./paths";

const FUNCTION_KINDS = new Set(["action", "mutation", "query", "stream"]);

/**
 * Detects a standalone `any` type token in a rendered type (degraded
 * type-checker mode). The negative lookahead excludes a property *key* named
 * `any` (`{ any: string }` / `{ any?: T }`) — a key is always followed by `:` /
 * `?:`, a real `any` type never is. String-literal type members (`kind: "any"`,
 * `"any" | "all"`) are removed via {@link STRING_LITERAL_SPAN_RE} before this
 * runs, so a discriminant literal `"any"` no longer degrades the whole type.
 */
const ANY_TOKEN_RE = /\bany\b(?!\s*(?:\?\s*)?:)/u;

/**
 * String / template literal *type* spans in a rendered type. Their text is data,
 * not a type token, so an `any` inside one (`kind: "any"`) must not trip
 * degraded-mode detection; callers strip these before testing {@link ANY_TOKEN_RE}.
 */
const STRING_LITERAL_SPAN_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gu;

/** JS identifier allowlist — mirrors `emit.ts`'s `IDENTIFIER_RE`, gating raw splice of a property name. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

/**
 * Render an expanded object-type property key for splicing into generated TS:
 * bare when it's a JS identifier, otherwise JSON-quoted (a valid TS member name).
 * Mirrors `emit.ts`'s `renderPropertyKey` so this expansion path can't inject a
 * non-identifier property name (e.g. `"a; b"`) verbatim into `_generated/*`.
 */
const renderExpandedPropertyKey = (propertyName: string): string => (IDENTIFIER_RE.test(propertyName) ? propertyName : JSON.stringify(propertyName));

/**
 * Internal factory names exported from `@lunora/server`, mapped to the kind
 * they register. A call to one of these marks the function `internal`: callable
 * server-side via `ctx.run*` but absent from the client-facing `api`.
 */
const INTERNAL_FACTORIES: Record<string, "action" | "mutation" | "query"> = {
    internalAction: "action",
    internalMutation: "mutation",
    internalQuery: "query",
};

/**
 * Lifecycle factory names exported from `@lunora/server`, mapped to the moment
 * they fire on. A call to one of these registers an internal mutation tagged
 * with its `lifecycle` so emit collects it into the `LUNORA_LIFECYCLE_HOOKS`
 * manifest: `connect`/`disconnect` are dispatched per socket, `init` once per
 * Durable Object instance before any handler runs, and `reactor` after each
 * write flush whose tables the reactor's watched read touched.
 */
type LifecycleMoment = "connect" | "disconnect" | "init" | "reactor";

const LIFECYCLE_FACTORIES: Record<string, LifecycleMoment> = {
    onConnect: "connect",
    onDisconnect: "disconnect",
    onQueryChange: "reactor",
    onShardInit: "init",
};

interface DiscoveredFunction {
    args: Record<string, ValidatorIR>;
    /** Set when the builder chain includes `.expose({ rest: true })` (plan 167). */
    expose?: { cache?: ExposeCacheIR; rest?: boolean };
    kind: string;
    lifecycle?: LifecycleMoment;
    /** The `.output(validator)` declaration, when the chain has one. */
    output?: ValidatorIR;
    returnType: string;
    visibility: "internal" | "public";
}

/**
 * Module specifiers a registration factory (`query`/`mutation`/`action`/their
 * `internal*` twins) may legitimately come from — see
 * {@link isServerSurfaceModule} for the three accepted forms and why omitting one
 * silently drops the function from `LUNORA_FUNCTIONS` instead of erroring.
 */
const isLunoraSurfaceModule = isServerSurfaceModule;

/**
 * Resolve a callee identifier through its import declaration, returning the
 * **imported** name (i.e. the name as exported from `@lunora/server` or the
 * generated `_generated/server` re-export). This handles aliasing like
 * `import { query as q }` where the call site uses `q` but the registration kind
 * is `query`. Returns `undefined` when the identifier is not imported from the
 * Lunora surface, so we don't accidentally pick up a local `const query = ...`.
 */
const resolveCalleeKind = (identifier: Identifier): string | undefined => {
    const symbol = identifier.getSymbol();

    // No type-checker info at all (no tsconfig wired up). Fall back to the
    // surface text — preserves the prior behaviour for users that haven't
    // configured ts-morph with a real project.
    if (!symbol) {
        return identifier.getText();
    }

    const declarations = symbol.getDeclarations();

    for (const declaration of declarations) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        const importDeclaration = declaration.getImportDeclaration();
        const moduleSpecifier = importDeclaration.getModuleSpecifierValue();

        // Only trust identifiers imported from the Lunora surface (the public
        // package or the generated `_generated/server` re-export).
        if (!isLunoraSurfaceModule(moduleSpecifier)) {
            return undefined;
        }

        // `import { query as q }` → declaration.getNameNode() is `query`,
        // declaration.getAliasNode() is `q`. The kind we care about is the
        // exported name, not the local alias.
        return declaration.getNameNode().getText();
    }

    // Symbol exists but no `@lunora/server` import specifier among its
    // declarations — it's a local binding (`const query = ...`) or imported
    // from somewhere else. Reject so we don't pick it up as a registration.
    return undefined;
};

/**
 * Resolve a builder-terminal chain's root identifier (`query`/`mutation`/...) to
 * its visibility, walking leftward through the `.input()` / `.use()` / `.output()`
 * steps to the root and resolving it by import name via {@link resolveCalleeKind}.
 * Returns `"public"` / `"internal"` for a Lunora builder root, or `undefined`
 * when the chain doesn't root at one (so an unrelated `obj.query(...)` method call
 * isn't mistaken for a registration). Import-name based, so it doesn't depend on
 * the `@lunora/server` types being installed/resolvable.
 */
const resolveBuilderRootKind = (receiver: Node, followedLocal = false): "internal" | "public" | undefined => {
    let current: Node = receiver;

    // Each builder step (`x.input({...})`, `x.use(...)`, `x.output(...)`) is a
    // CallExpression whose callee is a PropertyAccess; descend to its receiver.
    while (Node.isCallExpression(current)) {
        const inner = current.getExpression();

        if (!Node.isPropertyAccessExpression(inner)) {
            return undefined;
        }

        current = inner.getExpression();
    }

    if (!Node.isIdentifier(current)) {
        return undefined;
    }

    const rootName = resolveCalleeKind(current);

    if (rootName === undefined) {
        // The root identifier didn't resolve to an imported Lunora factory. It
        // may instead be a LOCAL const bound to a partially-applied builder
        // (`const b = mutation.input({...}); export const x = b.mutation(...)`).
        // Follow the const's initializer ONE hop and re-resolve, so the chain
        // is still discovered under degraded types (where the `__lunoraProcedure`
        // brand can't resolve). Bounded to a single hop so a `const a = b; const
        // b = a;` cycle can't loop.
        if (followedLocal) {
            return undefined;
        }

        const declaration = current.getSymbol()?.getValueDeclaration();

        if (declaration && Node.isVariableDeclaration(declaration)) {
            const initializer = declaration.getInitializer();

            return initializer ? resolveBuilderRootKind(initializer, true) : undefined;
        }

        return undefined;
    }

    if (FUNCTION_KINDS.has(rootName)) {
        return "public";
    }

    return INTERNAL_FACTORIES[rootName] ? "internal" : undefined;
};

/** Read a property off an object literal as a string literal, or `undefined` when absent / not statically readable. */
const stringProperty = (literal: ObjectLiteralExpression, name: string): string | undefined => {
    const property = literal.getProperty(name);

    if (property === undefined || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer !== undefined && Node.isStringLiteral(initializer) ? initializer.getLiteralValue() : undefined;
};

/** Read a property off an object literal as a numeric literal, or `undefined` when absent / not statically readable. */
const numberProperty = (literal: ObjectLiteralExpression, name: string): number | undefined => {
    const property = literal.getProperty(name);

    if (property === undefined || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer !== undefined && Node.isNumericLiteral(initializer) ? initializer.getLiteralValue() : undefined;
};

/**
 * Read the `cache: { … }` sub-object of an `.expose(...)` argument into
 * {@link ExposeCacheIR}. Only literal fields are recorded — a computed `maxAge`
 * is simply omitted, so the emitted spec under-documents rather than states
 * something the runtime won't do. Returns `undefined` when there is no readable
 * `cache` object at all.
 */
const cacheFromExposeLiteral = (literal: ObjectLiteralExpression): ExposeCacheIR | undefined => {
    const property = literal.getProperty("cache");

    if (property === undefined || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    if (initializer === undefined || !Node.isObjectLiteralExpression(initializer)) {
        return undefined;
    }

    const scope = stringProperty(initializer, "scope");
    const maxAge = numberProperty(initializer, "maxAge");
    const staleWhileRevalidate = numberProperty(initializer, "staleWhileRevalidate");
    const tag = stringProperty(initializer, "tag");
    const vary = stringProperty(initializer, "vary");

    const read: ExposeCacheIR = {
        ...(maxAge === undefined ? {} : { maxAge }),
        ...(scope === "private" || scope === "public" ? { scope } : {}),
        ...(staleWhileRevalidate === undefined ? {} : { staleWhileRevalidate }),
        ...(tag === undefined ? {} : { tag }),
        ...(vary === undefined ? {} : { vary }),
    };

    // Nothing readable (every field computed) is reported as absent rather than as
    // an empty object, so a consumer can't mistake "unreadable" for "declared".
    return Object.keys(read).length === 0 ? undefined : read;
};

/**
 * Read the argument of a located `.expose(...)` call into the IR tag. An
 * unreadable argument (not an object literal, or a computed `rest`) yields `{}` —
 * "exposed, details unknown" — which is the safe default: the function is still
 * treated as tagged, just without a `rest === true` that would publish it.
 */
const exposeFromArgument = (argument: Node | undefined): { cache?: ExposeCacheIR; rest?: boolean } => {
    if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        return {};
    }

    const cache = cacheFromExposeLiteral(argument);
    const restProperty = argument.getProperty("rest");

    if (restProperty !== undefined && Node.isPropertyAssignment(restProperty)) {
        return { ...(cache === undefined ? {} : { cache }), rest: restProperty.getInitializer()?.getText() === "true" };
    }

    return cache === undefined ? {} : { cache };
};

/**
 * Walk a builder-terminal chain (`c.input(...).expose({ rest: true }).query(...)`)
 * leftward looking for a `.expose({ ... })` modifier, and read its `rest` flag and
 * optional `cache` block from the object-literal argument. Returns the tag when
 * found, else `undefined` (RPC-only — the default). Mirrors
 * {@link resolveBuilderRootKind}'s chain descent so it works under degraded types
 * (no `@lunora/server` install).
 */
const exposeFromBuilderChain = (receiver: Node): { cache?: ExposeCacheIR; rest?: boolean } | undefined => {
    let current: Node = receiver;

    while (Node.isCallExpression(current)) {
        const inner = current.getExpression();

        if (!Node.isPropertyAccessExpression(inner)) {
            return undefined;
        }

        if (inner.getName() === "expose") {
            return exposeFromArgument(current.getArguments()[0]);
        }

        current = inner.getExpression();
    }

    return undefined;
};

/** Inspect a `query({ args, handler })` call and pull out the args validator map. */
const argsFromCall = (call: CallExpression): Record<string, ValidatorIR> => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return {};
    }

    const argsProperty = first.getProperty("args");

    if (!argsProperty || !Node.isPropertyAssignment(argsProperty)) {
        return {};
    }

    const initializer = argsProperty.getInitializer();

    if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
        return {};
    }

    return parseObjectShape(initializer);
};

/**
 * The one user-land module a generated file DOES import from. `emitApi` /
 * `emitFunctions` emit `import type { Doc, Id } from "./dataModel.js"` for
 * whichever of the two a rendered body references (see `referencedDataModelImports`),
 * so a bare `Doc`/`Id` reference resolves there and must be printed, not expanded.
 */
const GENERATED_DIRECTORY_SEGMENT = "/_generated/";

/**
 * Whether every declaration of `type` lives in a script-mode file — i.e. the
 * name is GLOBAL, resolving from anywhere without an import. `lib.*.d.ts` and an
 * app's own ambient `declare global` are the whole population.
 *
 * A file with a module symbol declares module-scoped names, so a `.d.ts` inside
 * `node_modules` is emphatically not global. Assuming otherwise is what put
 * unimported package types into `_generated/` as TS2304 (issue #509).
 */
const isGloballyDeclared = (type: Type): boolean => {
    const declarations = [type.getSymbol(), type.getAliasSymbol()].flatMap((candidate) => candidate?.getDeclarations() ?? []);

    return declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().getSymbol() === undefined);
};

/**
 * How `_generated/` can name a type the checker would print bare: the module
 * specifier to qualify it with, and the name that module exports it under.
 *
 * The two differ for a DEFAULT import, where the local binding is an alias the
 * exporting module never agreed to — `import Boxed from "./def"` has to be
 * written `import("./def").default`, not `import("./def").Boxed`.
 */
interface QualifiedImport {
    /** The name the module exports it under — `"default"` for a default export. */
    exportName: string;
    /** The specifier as the user wrote it, except that a directory module is pointed at its `index` (see {@link resolveEmittedSpecifier}). */
    specifier: string;
}

/**
 * `ModuleDeclaration.getName()` keeps the quotes for a string-literal module
 * name (`"virtual:thing"`), which is what distinguishes an ambient MODULE from a
 * `declare global` / namespace block.
 */
const AMBIENT_MODULE_NAME_RE = /^(?<quote>["'])(?<specifier>.*)\k<quote>$/su;

/**
 * The specifier of the ambient `declare module "…"` block `declaration` sits
 * inside, or `undefined` when it is not in one.
 *
 * A script-mode `.d.ts` normally declares globals — which is why one is exempt
 * from the bare-name rule — but it can also carry `declare module "spec" { … }`
 * blocks whose members are MODULE-scoped and reachable only through an import.
 * That is the ordinary packaging of `declare module "*.svg"`, of a hand-written
 * shim for an untyped dependency, and of older DefinitelyTyped layouts, so the
 * file-level test alone let those names out bare (issue #511).
 *
 * Nearest ancestor wins, and a `declare global` block is skipped by the quoting
 * rule rather than by name — `global` is an identifier there, never a literal.
 */
const ambientModuleSpecifier = (declaration: Node): string | undefined => {
    for (const ancestor of declaration.getAncestors()) {
        if (Node.isModuleDeclaration(ancestor)) {
            const match = AMBIENT_MODULE_NAME_RE.exec(ancestor.getName());

            if (match?.groups?.specifier !== undefined) {
                return match.groups.specifier;
            }
        }
    }

    return undefined;
};

/**
 * Per-module export lookup, memoised.
 *
 * `getExport` reads the module symbol's OWN export table, which does not list an
 * `export * from "…"` re-export — and a star re-export is exactly how the
 * umbrella republishes `@lunora/server`, so for the commonest spelling the cheap
 * lookup always misses. `getExportSymbols` asks the checker instead and sees
 * through it, at the cost of materialising every export of the module.
 *
 * That is why this is cached rather than merely guarded. The caller's
 * already-imported check does not bound it: a namespace import (`import * as t`)
 * makes the check unconditionally true, so without a cache every candidate name
 * would rebuild `lunorash/server`'s whole export table, inside a per-property
 * recursion, once per inference pass.
 *
 * Keyed on the module's compiler symbol, which is replaced wholesale when a file
 * is re-parsed — so a stale entry cannot outlive the program it was read from.
 */
const MODULE_EXPORT_CACHE = new WeakMap<object, Map<string, TsSymbol | undefined>>();

const moduleExport = (moduleFile: SourceFile, name: string): TsSymbol | undefined => {
    const moduleSymbol = moduleFile.getSymbol();

    if (moduleSymbol === undefined) {
        return undefined;
    }

    let byName = MODULE_EXPORT_CACHE.get(moduleSymbol.compilerSymbol);

    if (byName === undefined) {
        byName = new Map<string, TsSymbol | undefined>();
        MODULE_EXPORT_CACHE.set(moduleSymbol.compilerSymbol, byName);
    }

    if (!byName.has(name)) {
        byName.set(name, moduleSymbol.getExport(name) ?? moduleFile.getExportSymbols().find((symbol) => symbol.getName() === name));
    }

    return byName.get(name);
};

/** Whether `importDeclaration` reaches `name` by name — named, or through a namespace alias `_generated/` does not have either. */
const bindsByName = (importDeclaration: ImportDeclaration, name: string): boolean =>
    importDeclaration.getNamespaceImport() !== undefined || importDeclaration.getNamedImports().some((entry) => entry.getName() === name);

/**
 * Whether `importDeclaration` brings `name` in from an ambient
 * `declare module "…"` block.
 *
 * Matched on the specifier TEXT, because an ambient module declaration has no
 * source file for `getModuleSpecifierSourceFile()` to resolve to — the symbol
 * identity check every other path uses has nothing to compare against here.
 */
const matchesAmbientModule = (importDeclaration: ImportDeclaration, ambientSpecifier: string, name: string): QualifiedImport | undefined => {
    const specifier = importDeclaration.getModuleSpecifierValue();

    return specifier === ambientSpecifier && bindsByName(importDeclaration, name) ? { exportName: name, specifier } : undefined;
};

/**
 * Whether `importDeclaration`'s DEFAULT binding resolves to `declaration`.
 *
 * A default import's local name says nothing about the export it came from, so
 * this matches by resolving the binding rather than by comparing names — and the
 * name it must be written under is `default`, whatever the local alias is.
 */
const matchesDefaultImport = (importDeclaration: ImportDeclaration, declaration: Node): QualifiedImport | undefined => {
    const defaultImport = importDeclaration.getDefaultImport();

    if (defaultImport === undefined) {
        return undefined;
    }

    const bound = defaultImport.getSymbol();

    return (bound?.getAliasedSymbol() ?? bound)?.getDeclarations().includes(declaration) === true
        ? { exportName: "default", specifier: importDeclaration.getModuleSpecifierValue() }
        : undefined;
};

/** Whether `importDeclaration` brings `name` in from the module that declares it, through any re-export chain. */
const matchesNamedImport = (importDeclaration: ImportDeclaration, declaration: Node, name: string): QualifiedImport | undefined => {
    if (!bindsByName(importDeclaration, name)) {
        return undefined;
    }

    const moduleFile = importDeclaration.getModuleSpecifierSourceFile();
    const exported = moduleFile === undefined ? undefined : moduleExport(moduleFile, name);
    const target = exported?.getAliasedSymbol() ?? exported;

    return target?.getDeclarations().includes(declaration) === true ? { exportName: name, specifier: importDeclaration.getModuleSpecifierValue() } : undefined;
};

/** A specifier resolved from the handler's own directory rather than from a package name. */
const RELATIVE_SPECIFIER_RE = /^\.\.?(?:$|\/)/u;

/** A specifier whose final segment already names the directory's index module, with or without an extension. */
const INDEX_SEGMENT_RE = /(?:^|\/)index(?:\.\w+)?$/u;

/** A written-out trailing slash, dropped so the appended `/index` does not double it. */
const TRAILING_SLASH_RE = /\/$/u;

/** A TypeScript source extension written into an import specifier — legal in the app's own source, not in generated output (see {@link resolveEmittedSpecifier}). */
const TS_EXTENSION_RE = /\.(?<extension>[cm]?tsx?)$/u;

/** What each TypeScript source extension is written as once emitted. */
const EMITTED_EXTENSIONS = new Map([
    ["cts", "cjs"],
    ["mts", "mjs"],
    ["ts", "js"],
    ["tsx", "js"],
]);

/**
 * Rewrite the specifier a handler wrote into one that also resolves from
 * `_generated/`.
 *
 * The qualifier is the user's own import text, and there are two spellings that
 * resolve where they were written and nowhere else. Both are TS2307/TS5097 in a
 * file nobody wrote and nothing can repair from outside: `paths` does not apply
 * to a relative specifier, and no ambient declaration satisfies a qualified
 * `import("…").T`.
 *
 * A DIRECTORY module (`./agent/client` → `agent/client/index.ts`) is the first.
 * `emit.ts` appends `.js` to a rebased relative qualifier, because the generated
 * files are consumed under NodeNext where the extension is mandatory. Extension
 * substitution answers that for a file — `./lib/types.js` finds `lib/types.ts` —
 * but a directory has no extension to substitute, so `../agent/client.js`
 * resolves to nothing. Naming the index module explicitly gives the suffix
 * something to attach to. Asked of the RESOLVED source file rather than guessed
 * from the shape of the string: `./agent/client` is spelled the same whether it
 * is a file or a directory, and only the checker knows which one it found.
 *
 * A TS EXTENSION (`./lib/types.ts`) is the second. It is legal in the app's own
 * source under `allowImportingTsExtensions`, and illegal everywhere that flag is
 * off — which includes a dedicated strict config for generated output, the
 * pattern this repo itself ships. The emitted extension resolves under both.
 */
const resolveEmittedSpecifier = (importDeclaration: ImportDeclaration, matched: QualifiedImport): QualifiedImport => {
    if (!RELATIVE_SPECIFIER_RE.test(matched.specifier)) {
        return matched;
    }

    const written = TS_EXTENSION_RE.exec(matched.specifier)?.groups?.extension;
    const emitted = written === undefined ? undefined : EMITTED_EXTENSIONS.get(written);

    // An extension means the specifier already names a file, so the directory
    // question below is answered and `emit.ts` appends nothing either.
    if (written !== undefined && emitted !== undefined) {
        return { ...matched, specifier: `${matched.specifier.slice(0, -written.length)}${emitted}` };
    }

    if (INDEX_SEGMENT_RE.test(matched.specifier)) {
        return matched;
    }

    const moduleFile = importDeclaration.getModuleSpecifierSourceFile();

    return moduleFile?.getBaseNameWithoutExtension() === "index"
        ? { ...matched, specifier: `${matched.specifier.replace(TRAILING_SLASH_RE, "")}/index` }
        : matched;
};

/**
 * The module specifier the handler's file imports `name` from, when that import
 * resolves to `declaration` — the string the user wrote, never a resolved path,
 * beyond the retargeting {@link resolveEmittedSpecifier} does.
 * `undefined` when the module does not import it.
 *
 * This answers both questions the printing rule needs: whether the checker will
 * print the name BARE at `node` (it will, exactly when the module imports it),
 * and — since a bare name does not resolve from `_generated/` — which specifier
 * to qualify it with instead. `emit.ts` takes it from there: a relative
 * qualifier is rebased out of the source directory, an `@lunora/*` one is mapped
 * onto the umbrella, and a bare package specifier is already correct from any
 * directory.
 *
 * Resolved through the checker's ALIAS CHAIN, not by comparing source files.
 * `lunorash/server` re-exports `@lunora/server`, which re-exports its own
 * `types.d.ts`, so the file an import declaration resolves to is almost never
 * the file the interface is DECLARED in — and comparing the two answered "not
 * imported" for every umbrella type, which is the commonest spelling there is.
 *
 * Deliberately NOT `type.getText(node).includes("import(")`: that renders the
 * WHOLE type, type arguments and all, so an imported `Wrapper` wrapping an
 * out-of-scope `Bar` renders text containing `import(` and the wrapper is
 * wrongly cleared — printed bare into `_generated/` as a TS2304, one generic
 * deep. Asking the module directly is depth-independent, because the recursion
 * visits each type on its own.
 */
const importSpecifierFor = (handlerFile: SourceFile, declaration: Node, name: string): QualifiedImport | undefined => {
    const ambientSpecifier = ambientModuleSpecifier(declaration);

    for (const importDeclaration of handlerFile.getImportDeclarations()) {
        const matched =
            ambientSpecifier === undefined
                ? (matchesDefaultImport(importDeclaration, declaration) ?? matchesNamedImport(importDeclaration, declaration, name))
                : matchesAmbientModule(importDeclaration, ambientSpecifier, name);

        if (matched !== undefined) {
            return resolveEmittedSpecifier(importDeclaration, matched);
        }
    }

    return undefined;
};

/**
 * Whether `specifier` is one the emitted file cannot resolve.
 *
 * A `tsconfig` `paths` alias (`~/lib/types`, `@/types`) resolves under the
 * AUTHORING project's own config and nowhere else — not from a sibling package
 * that imports `_generated/api.ts`, and not under a dedicated strict config for
 * generated output, which is the pattern this repo itself ships
 * (`apps/playground/tsconfig.generated.json` declares no `paths`). None of
 * `emit.ts`'s three rebasers touch it, so the alias would be written out
 * verbatim and fail to resolve exactly where `relocateUserRelativeImports`
 * exists to stop that happening.
 *
 * Matched against the project's CONFIGURED patterns rather than guessed from the
 * shape of the string, because an alias can be spelled anything. Declining sends
 * the type back to structural expansion, which is what it got before qualifying
 * existed.
 */
const isUnresolvableSpecifier = (specifier: string, node: Node): boolean =>
    Object.keys(node.getProject().getCompilerOptions().paths ?? {}).some((pattern) => {
        const star = pattern.indexOf("*");

        return star === -1 ? specifier === pattern : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
    });

/**
 * How `_generated/` can name a declaration the handler refers to.
 *
 * One question, asked once, with three answers — because there are exactly three
 * things the emitter can do with a name.
 *
 * `verbatim` prints what the checker printed: either the name resolves from
 * anywhere (a global, or `Doc`/`Id`, which the generated files import), or the
 * checker already rendered it as a self-contained `import("…")` qualifier
 * because it is not in scope at the handler either.
 *
 * `qualify` means the checker prints it BARE, which does not resolve from
 * `_generated/`, but the handler's own import says which module to name it from,
 * so it can be rewritten as `import("<specifier>").<export>`.
 *
 * `expand` means it prints bare and no specifier can reach it — declared in the
 * handler's own module, or behind a `paths` alias that resolves nowhere else.
 * Only its structure can be reproduced.
 */
type NameRendering = { kind: "expand" } | { kind: "qualify"; qualified: QualifiedImport } | { kind: "verbatim" };

const VERBATIM: NameRendering = { kind: "verbatim" };
const EXPAND: NameRendering = { kind: "expand" };

/**
 * Every declaration kind the checker prints as a BARE name. Interfaces and type
 * aliases were the whole list once, which left `class` and `enum` — two ordinary
 * ways to declare a return type — printing as undeclared identifiers in
 * `api.ts`/`functions.ts` (TS2304) while `lunora codegen` exited 0. An enum
 * reaches the rule as its MEMBER declarations (`Status.Done` is an enum-literal
 * type), so the member is listed alongside the enum itself.
 *
 * Anything else the checker renders structurally already, so it needs no name.
 */
const BARE_NAMEABLE_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.ClassDeclaration,
    SyntaxKind.EnumDeclaration,
    SyntaxKind.EnumMember,
    SyntaxKind.InterfaceDeclaration,
    SyntaxKind.TypeAliasDeclaration,
]);

/**
 * Classify one declaration. {@link classifyType} lifts this to a type and
 * {@link annotationRendering} to a syntactic annotation; both defer here so the
 * rule has one statement rather than three that must agree.
 */
const classifyDeclaration = (declaration: Node, node: Node, handlerFilePath: string): NameRendering => {
    const declarationFile = declaration.getSourceFile();

    // A GLOBAL declaration prints bare AND resolves bare from anywhere — `Date`,
    // `Uint8Array`, the whole `lib.*.d.ts` surface, an app's own ambient
    // `declare global`.
    //
    // Skipping every `.d.ts`/`node_modules` file instead was wrong by a wide
    // margin: a MODULE-scoped declaration there is no more reachable from
    // `_generated/` than a user's own interface is. A handler importing
    // `PaginationResult` from `lunorash/server` — or any package type at all —
    // had the name written into `api.ts` unimported, a TS2304 in generated
    // output while `lunora codegen` exited 0 (issue #509).
    //
    // Script-mode files are ALMOST exactly the globals, and the exception is why
    // this is two tests rather than one: a script-mode `.d.ts` may still carry
    // `declare module "spec" { … }` blocks, whose members are module-scoped and
    // need an import like any other (issue #511).
    if (declarationFile.getSymbol() === undefined && ambientModuleSpecifier(declaration) === undefined) {
        return VERBATIM;
    }

    if (!BARE_NAMEABLE_KINDS.has(declaration.getKind())) {
        return VERBATIM;
    }

    const declarationPath = declarationFile.getFilePath();

    // `Doc`/`Id` and friends: the generated files import these by name, so the
    // bare rendering is correct there. Expanding them instead would discard a
    // branded `Id` (not an expandable object) and fall all the way back to
    // `unknown` — measured as every `Doc`/`Id`-shaped return type in the example
    // apps collapsing at once. Keyed on the declaration PATH, never on the name:
    // a user's own `Doc`/`Id` is a different type, and exempting it by name let
    // `referencedDataModelImports` bind it to the generated one — a wrong type
    // with no compile error anywhere.
    if (declarationPath.includes(GENERATED_DIRECTORY_SEGMENT)) {
        return VERBATIM;
    }

    // Declared in the handler's own module, at any nesting depth. Nameable there
    // and nowhere else — no import exists to borrow a specifier from.
    if (declarationPath === handlerFilePath) {
        return EXPAND;
    }

    // An enum member is imported under its ENUM's name, never its own. A nameless
    // `export default class {}` has no name to ask about at all.
    const named = Node.isEnumMember(declaration) ? declaration.getParent() : declaration;

    if (!Node.hasName(named)) {
        return EXPAND;
    }

    const qualified = importSpecifierFor(node.getSourceFile(), named, named.getName());

    // Not imported here either, so the checker prints it as its own `import("…")`
    // qualifier — already self-contained.
    if (qualified === undefined) {
        return VERBATIM;
    }

    return isUnresolvableSpecifier(qualified.specifier, node) ? EXPAND : { kind: "qualify", qualified };
};

/**
 * Classify a type by the declarations behind it.
 *
 * A `qualify` counts only from the symbol the checker actually PRINTS — the
 * alias when there is one, since that is the syntax that reaches the output.
 * Reachability is judged across both symbols, because either can drag in a name
 * that does not resolve.
 */
const classifyType = (type: Type, node: Node, handlerFilePath: string): NameRendering => {
    const aliasSymbol = type.getAliasSymbol();
    const symbol = type.getSymbol();
    const printedDeclarations = new Set<Node>((aliasSymbol ?? symbol)?.getDeclarations());

    let needsRenaming = false;

    for (const declaration of [symbol, aliasSymbol].flatMap((candidate) => candidate?.getDeclarations() ?? [])) {
        const rendering = classifyDeclaration(declaration, node, handlerFilePath);

        if (rendering.kind === "qualify" && printedDeclarations.has(declaration)) {
            return rendering;
        }

        needsRenaming ||= rendering.kind !== "verbatim";
    }

    return needsRenaming ? EXPAND : VERBATIM;
};

/**
 * Classify a declaration's type ANNOTATION — the half of the printing rule that
 * the resolved type cannot reveal.
 *
 * TypeScript's node builder reuses the syntax of a declared annotation whenever
 * that syntax resolves at the printing location, so `{ action: AuditAction }`
 * prints the alias verbatim. The same property fetched back through the checker
 * (`getTypeAtLocation`, `getTypeOfSymbol`) comes back with no alias symbol at
 * all, fully resolved to its union — so walking resolved types alone reported
 * "nothing unreachable here" about text that names an alias on its face, and the
 * bare name reached `_generated/` as a TS2304 while `lunora codegen` exited 0.
 * An alias behind a conditional type (`Infer<typeof schema>`, the shape every
 * Standard Schema wrapper produces) leaked from every procedure that returned
 * one. Walking the annotation as well as the type it resolves to is what closes
 * that gap; it does not replace the resolved walk, because an inferred return
 * with no annotation anywhere still has to be caught by the type.
 */
const annotationRendering = (declaration: Node, node: Node, handlerFilePath: string): NameRendering => {
    const annotation = Node.isPropertySignature(declaration) || Node.isPropertyDeclaration(declaration) ? declaration.getTypeNode() : undefined;

    if (annotation === undefined) {
        return VERBATIM;
    }

    let needsRenaming = false;

    for (const reference of [annotation, ...annotation.getDescendantsOfKind(SyntaxKind.TypeReference)].filter((candidate) => Node.isTypeReference(candidate))) {
        // Resolved through `getAliasedSymbol()` for an `import type { X }`,
        // exactly as `resolveValidatorAlias` does — otherwise the symbol is the
        // `ImportSpecifier`, which is neither an interface nor a type alias, so
        // every imported name read as reachable and the leak this walk exists to
        // catch stayed open for the commonest spelling of it.
        const symbol = reference.getTypeName().getSymbol();

        for (const referenced of (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? []) {
            const rendering = classifyDeclaration(referenced, node, handlerFilePath);

            if (rendering.kind === "qualify") {
                return rendering;
            }

            needsRenaming ||= rendering.kind !== "verbatim";
        }
    }

    return needsRenaming ? EXPAND : VERBATIM;
};

/** Composite child types of `type` (type arguments + union/intersection members) to recurse into. */
const childTypes = (type: Type): Type[] => {
    const children = [...type.getTypeArguments()];

    if (type.isUnion()) {
        children.push(...type.getUnionTypes());
    }

    if (type.isIntersection()) {
        children.push(...type.getIntersectionTypes());
    }

    return children;
};

/**
 * An object type whose members we can faithfully reproduce structurally: a plain
 * object/interface with no call/construct signatures and no index signatures
 * (those can't be re-expressed as `{ name: type; … }` without losing meaning).
 */
const isExpandableObject = (type: Type): boolean => {
    if (!type.isObject() || type.isArray() || type.isTuple()) {
        return false;
    }

    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
        return false;
    }

    return type.getStringIndexType() === undefined && type.getNumberIndexType() === undefined;
};

/**
 * Whether any name inside `type` needs renaming before it can go into
 * `_generated/` — i.e. anything in it classifies as other than `verbatim`.
 *
 * Descends type arguments, union/intersection members, **and** object property
 * types — the last so an anonymous object that embeds an unreachable interface
 * (`{ post: PostDoc }`) isn't mistaken for safe.
 */
const referencesUnreachableLocalType = (type: Type, node: Node, handlerFilePath: string, seen = new Set<Type>()): boolean => {
    if (seen.has(type)) {
        return false;
    }

    seen.add(type);

    if (classifyType(type, node, handlerFilePath).kind !== "verbatim") {
        return true;
    }

    if (childTypes(type).some((child) => referencesUnreachableLocalType(child, node, handlerFilePath, seen))) {
        return true;
    }

    if (!isExpandableObject(type)) {
        return false;
    }

    return type.getProperties().some((property) => {
        // The annotation first: it is the syntax the printer reuses, and the
        // resolved type below has already lost the alias by the time we see it.
        if (property.getDeclarations().some((declaration) => annotationRendering(declaration, node, handlerFilePath).kind !== "verbatim")) {
            return true;
        }

        return referencesUnreachableLocalType(property.getTypeAtLocation(node), node, handlerFilePath, seen);
    });
};

/** Is `property` declared optional (`name?: …`)? */
const isOptionalProperty = (property: TsSymbol, propertyType: Type): boolean => {
    const declaration = property.getValueDeclaration() ?? property.getDeclarations()[0];

    if (declaration && (Node.isPropertySignature(declaration) || Node.isPropertyDeclaration(declaration)) && declaration.hasQuestionToken()) {
        return true;
    }

    return propertyType.isUnion() && propertyType.getUnionTypes().some((member) => member.isUndefined());
};

/** Depth ceiling so a pathological nested type can't blow the stack — beyond it we bail to `unknown`. */
const MAX_EXPANSION_DEPTH = 8;

/** Shared type alias for the recursive expand callback passed to branch helpers. */
type ExpandFunction = (type: Type, node: Node, handlerFilePath: string, depth: number, seen: Set<Type>) => string | undefined;

/**
 * Expand an array type; returns `undefined` when the element can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandArrayType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    const element = type.getArrayElementType();
    const rendered = element ? expand(element, node, handlerFilePath, depth, nextSeen) : undefined;

    if (rendered === undefined) {
        return undefined;
    }

    return element?.isUnion() ? `(${rendered})[]` : `${rendered}[]`;
};

/**
 * Expand a union type; returns `undefined` when any member can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandUnionType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    const parts: string[] = [];

    for (const member of type.getUnionTypes()) {
        const rendered = expand(member, node, handlerFilePath, depth, nextSeen);

        if (rendered === undefined) {
            return undefined;
        }

        parts.push(rendered);
    }

    return parts.join(" | ");
};

/**
 * Expand an object type's properties; returns `undefined` when any property can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandObjectType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    if (!isExpandableObject(type)) {
        return undefined;
    }

    const parts: string[] = [];

    for (const property of type.getProperties()) {
        const propertyType = property.getTypeAtLocation(node);
        const optional = isOptionalProperty(property, propertyType);
        // Optionality re-adds `| undefined` to the resolved type; drop it so the
        // emitted property reads `name?: T`, not `name?: T | undefined`.
        const valueMembers = optional && propertyType.isUnion() ? propertyType.getUnionTypes().filter((member) => !member.isUndefined()) : [propertyType];

        const rendered: string[] = [];

        for (const member of valueMembers) {
            const text = expand(member, node, handlerFilePath, depth + 1, nextSeen);

            if (text === undefined) {
                return undefined;
            }

            rendered.push(text);
        }

        parts.push(`${renderExpandedPropertyKey(property.getName())}${optional ? "?" : ""}: ${rendered.join(" | ")}`);
    }

    return parts.length > 0 ? `{ ${parts.join("; ")} }` : "{}";
};

/**
 * An enum-literal member prints as `Status.Done` — the enum's name, bare. What
 * actually crosses the wire is the member's VALUE, so that is both the honest
 * rendering and a nameable one. A member is a string or a number and nothing
 * else; anything else declines, so the caller keeps the `unknown` fallback.
 */
const expandEnumLiteralType = (type: Type): string | undefined => {
    const value = type.getLiteralValue();

    if (typeof value === "string") {
        return JSON.stringify(value);
    }

    return typeof value === "number" ? String(value) : undefined;
};

/** Whether `type` is the INSTANCE type of a user-land `class` declaration. */
const isClassInstance = (type: Type): boolean =>
    [type.getSymbol(), type.getAliasSymbol()]
        .flatMap((candidate) => candidate?.getDeclarations() ?? [])
        .some((declaration) => Node.isClassDeclaration(declaration) || Node.isClassExpression(declaration));

/**
 * Whether `type` reaches a value `encodeWire` refuses — a user-land class
 * instance or anything with a call signature — at any depth.
 *
 * {@link expandUnreachableType} declines a class instance outright, and the
 * reasoning there (a method or a `#private` field is absent from the serialized
 * value, so a `result.format(...)` typed off one is a runtime TypeError with no
 * compile error anywhere) applies just as much when the class is a MEMBER of the
 * type being named. Printing `import("./money").Envelope` publishes
 * `at.format()` to every caller for a value that cannot cross the wire at all —
 * `shared/wire-codec.ts` throws on it at the send site.
 *
 * Keyed on the same script-mode test the global exemption uses, so the built-ins
 * that DO round-trip (`Date`, `URL`, `Map`, `Set`, the typed arrays) are not
 * caught by it — they are declared in `lib.*.d.ts` and are exactly the set
 * `encodeWire` supports.
 *
 * An index signature is deliberately NOT a refusal: a `Record`-shaped return
 * encodes fine, and declining one is the collapse-to-`unknown` this whole path
 * exists to avoid.
 */
const containsUnencodableMember = (type: Type, node: Node, depth: number, seen: Set<Type>): boolean => {
    if (depth > MAX_EXPANSION_DEPTH || seen.has(type)) {
        return false;
    }

    const nextSeen = new Set(seen).add(type);

    // Type arguments and union/intersection members first, so a supported
    // container carrying an unsupported payload (`Map<string, Money>`, an array
    // of them) is still caught — the container encodes, its contents do not.
    if (childTypes(type).some((child) => containsUnencodableMember(child, node, depth + 1, nextSeen))) {
        return true;
    }

    const element = type.getArrayElementType();

    if (element !== undefined) {
        return containsUnencodableMember(element, node, depth + 1, nextSeen);
    }

    // A GLOBAL type is trusted and NOT descended into. The globals a return type
    // realistically names are the built-ins `encodeWire` supports (`Date`, `Map`,
    // `Set`, `URL`, the typed arrays), and every one of them carries prototype
    // methods — walking their members would report `Date` itself as unencodable
    // on the strength of `getTime()`. Same script-mode test as the bare-name
    // exemption uses, for the same reason.
    if (isGloballyDeclared(type)) {
        return false;
    }

    // A function/callable is not a plain object, so `encodeWire` throws on it.
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
        return true;
    }

    const isUserLandClass = [type.getSymbol(), type.getAliasSymbol()]
        .flatMap((candidate) => candidate?.getDeclarations() ?? [])
        .some((declaration) => Node.isClassDeclaration(declaration) || Node.isClassExpression(declaration));

    if (isUserLandClass) {
        return true;
    }

    // Members are walked only for shapes structural expansion would itself walk —
    // which excludes arrays, tuples, and anything carrying call or index
    // signatures, so a prototype method never reaches the callable test above.
    return (
        isExpandableObject(type) &&
        type.getProperties().some((property) => containsUnencodableMember(property.getTypeAtLocation(node), node, depth + 1, nextSeen))
    );
};

/**
 * Render `qualified` as `import("<specifier>").<export><…type arguments>`.
 *
 * Only the bare NAME is unreachable from `_generated/`; the type itself is
 * perfectly nameable, and the handler's own `import` declaration says which
 * module to name it from. Emitting the qualifier keeps the alias intact — a
 * paginated page of `Doc`s stays that, rather than becoming the flattened record
 * structural expansion produces — and keeps a type expansion cannot reproduce at
 * all (an index signature, a call signature, a generic the checker left
 * unresolved) off the `unknown` fallback it would otherwise land on.
 *
 * Type arguments go back through `expand`, so one unreachable argument still
 * decides the outcome for the whole reference.
 */
const qualifiedImportText = (
    qualified: QualifiedImport,
    type: Type,
    node: Node,
    handlerFilePath: string,
    depth: number,
    seen: Set<Type>,
    expand: ExpandFunction,
): string | undefined => {
    const rendered: string[] = [];

    for (const argument of type.getAliasSymbol() === undefined ? type.getTypeArguments() : type.getAliasTypeArguments()) {
        const text = expand(argument, node, handlerFilePath, depth + 1, seen);

        if (text === undefined) {
            return undefined;
        }

        rendered.push(text);
    }

    return `import("${qualified.specifier}").${qualified.exportName}${rendered.length > 0 ? `<${rendered.join(", ")}>` : ""}`;
};

/** Whether `type` is an `enum` or one of its members — the one named type deliberately rendered by VALUE rather than by name. */
const isEnumDeclared = (type: Type): boolean =>
    [type.getSymbol(), type.getAliasSymbol()]
        .flatMap((candidate) => candidate?.getDeclarations() ?? [])
        .some((declaration) => Node.isEnumDeclaration(declaration) || Node.isEnumMember(declaration));

/**
 * Structurally expand a return type that references a non-exported local type,
 * so the generated `FunctionReference` carries the real shape (`PostDoc[]` →
 * `{ _id: Id<"posts">; … }[]`) instead of erasing to `unknown`. Reachable names
 * (`Id`, `Doc`, primitives, library types) are printed verbatim; anything we
 * can't faithfully reproduce — recursion, call/index signatures, exotic types —
 * returns `undefined` so the caller keeps the `unknown` fallback. The result is
 * thus never worse than today, only more precise.
 */
const expandUnreachableType = (type: Type, node: Node, handlerFilePath: string, depth: number, seen: Set<Type>): string | undefined => {
    if (depth > MAX_EXPANSION_DEPTH || seen.has(type)) {
        return undefined;
    }

    const rendering = classifyType(type, node, handlerFilePath);

    // Reachable types already print correctly by name — leave them verbatim. The
    // type's OWN rendering gates the walk rather than the other way round: it is
    // the cheap half, it is implied by the walk anyway, and checking it first
    // means a type that already needs renaming never pays for the recursion.
    if (rendering.kind === "verbatim" && !referencesUnreachableLocalType(type, node, handlerFilePath)) {
        return type.getText(node);
    }

    const nextSeen = new Set(seen).add(type);

    // A CLASS INSTANCE is not reproducible, and expanding it would be worse than
    // declining. Answered before every branch below — including the qualifier —
    // so no path can publish one. `encodeWire` refuses a class instance outright (`shared/wire-codec.ts`
    // — only plain objects and the supported built-ins round-trip), so no such value
    // ever reaches a caller; and the structural expansion would describe one wrongly
    // in three directions at once: methods and getters live on the prototype and are
    // absent from the serialized value, `#private` fields are absent too, and
    // `private`/`protected` members would be published into the client-facing type.
    // A `result.format(...)` typed from a method is then a runtime TypeError with no
    // compile error anywhere. Declining keeps `unknown` — which is the contract this
    // function opens with, and the only answer that is never wrong.
    if (isClassInstance(type)) {
        return undefined;
    }

    // An `enum` is the one named type rendered by VALUE rather than by name. The
    // value is what crosses the wire, and the type is NOMINAL — a caller
    // comparing `result.status === "done"` does not typecheck against `Status`,
    // and a caller without the enum installed cannot name it at all. A single
    // member answers here; a whole enum falls through to the union branch, which
    // expands each member the same way.
    if (type.isEnumLiteral()) {
        return expandEnumLiteralType(type);
    }

    // Nameable, just not BARE-nameable — qualify it with the module the handler
    // imports it from. Ahead of the structural branches because an alias for an
    // array or a union (`type Ids = Id<"x">[]`, `type Status = A | B`) is a
    // reference the checker prints by name, and expanding it loses the alias for
    // no gain — or declines outright on a member it cannot reproduce. Nothing but
    // `discover-functions.test.ts`'s alias-of-array and alias-of-union cases
    // enforces that order.
    if (rendering.kind === "qualify" && !isEnumDeclared(type)) {
        const qualified = qualifiedImportText(rendering.qualified, type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);

        if (qualified !== undefined) {
            return qualified;
        }
    }

    if (type.isArray()) {
        return expandArrayType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
    }

    if (type.isUnion()) {
        return expandUnionType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
    }

    return expandObjectType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
};

/**
 * Render a handler's resolved return type via ts-morph's type checker. Unwraps
 * the outer `Promise<…>` so the emitted `FunctionReference<Kind, Args, Return>`
 * matches what callers see post-await. Shared by the object-literal `query(...)`
 * path and the builder terminal (`c.query(...)`) path.
 *
 * Returns `"unknown"` when the type checker can't resolve enough context —
 * typical when running against a stand-alone fixture without a tsconfig.
 */
const unwrapHandlerReturn = (handler: Node): string => {
    const signature = handler.getType().getCallSignatures()[0];

    if (!signature) {
        return "unknown";
    }

    let returnType = signature.getReturnType();

    // Unwrap a single layer of `Promise<…>` / `AsyncIterable<…>` /
    // `AsyncGenerator<…, …, …>`. The runtime awaits / iterates the handler,
    // so callers should see the inner element type — not the wrapper.
    const symbol = returnType.getSymbol() ?? returnType.getAliasSymbol();
    const wrapperName = symbol?.getName();

    if (wrapperName === "Promise" || wrapperName === "AsyncIterable" || wrapperName === "AsyncIterableIterator" || wrapperName === "AsyncGenerator") {
        const innerTypeArgument = returnType.getTypeArguments()[0];

        if (innerTypeArgument) {
            returnType = innerTypeArgument;
        }
    }

    const rendered = returnType.getText(handler);

    // `any`/empty fall back to `unknown` so downstream typings stay strict.
    if (!rendered || rendered === "any" || rendered === "never") {
        return "unknown";
    }

    // If `any` appears as a standalone identifier anywhere in the rendered
    // type (e.g. `{ channelId: any; ... }`), the type checker is in degraded
    // mode — typically because the consuming project lacks the tsconfig
    // wiring to resolve `@lunora/server`/`@lunora/values`. Surfacing such
    // partial types would mislead users; fall back to `unknown` instead.
    if (ANY_TOKEN_RE.test(rendered.replaceAll(STRING_LITERAL_SPAN_RE, ""))) {
        return "unknown";
    }

    // A value `encodeWire` refuses never reaches a caller — it throws at the send
    // site (`shared/wire-codec.ts`: only plain objects, arrays, and the supported
    // built-ins round-trip). Naming one in the contract types a call that can
    // never complete: `result.at.format()` compiles and is a runtime TypeError,
    // and `private`/`#private` members get published to clients besides.
    //
    // {@link expandUnreachableType} already declined a class it was asked to
    // expand, but that only covers the types it walks. A class the handler does
    // NOT import is not bare-nameable, so the checker prints it fully qualified
    // and the reachability walk waves it through — `{ at: import("./money").Money }`
    // reached `api.ts` intact. Every return type funnels through here, so this is
    // the one place the rule holds for all of them.
    if (containsUnencodableMember(returnType, handler, 0, new Set<Type>())) {
        return "unknown";
    }

    // ts-morph renders types relative to the handler's enclosing node, so a
    // locally-declared (non-exported) interface like `interface CursorDoc {…}`
    // inside `cursors.ts` shows up as the bare name `CursorDoc[]` — unreachable
    // from `_generated/api.ts` (TS2304 on compile). Rather than erase to
    // `unknown`, structurally expand it to the real shape; only fall back when
    // the type can't be faithfully reproduced.
    const handlerFilePath = handler.getSourceFile().getFilePath();

    if (referencesUnreachableLocalType(returnType, handler, handlerFilePath)) {
        return expandUnreachableType(returnType, handler, handlerFilePath, 0, new Set<Type>()) ?? "unknown";
    }

    return rendered;
};

/**
 * The inferred type of a `v.from(externalSchema)` argument, rendered for
 * `_generated/`.
 *
 * Reads `~standard.types.output` off the wrapped schema — the property Standard
 * Schema v1 exposes precisely so tooling can recover the inferred type, and the
 * same one the runtime's `InferStandardOutput` reads, so the emitted type and
 * the value that actually reaches the handler agree.
 *
 * Runs the result through the same guards as the handler-return path: an
 * `any`-degraded render (checker without tsconfig wiring) falls back to
 * `unknown` rather than misleading, and a locally-declared type unreachable
 * from `_generated/` is structurally expanded rather than emitted as a bare
 * name that would not resolve. Returns `undefined` when nothing safe can be
 * produced, leaving the caller on `unknown`.
 */
const resolveStandardSchemaType = (node: Node): string | undefined => {
    const standard = node.getType().getProperty("~standard");

    if (!standard) {
        return undefined;
    }

    const types = standard.getTypeAtLocation(node).getProperty("types");

    if (!types) {
        return undefined;
    }

    const output = types.getTypeAtLocation(node).getNonNullableType().getProperty("output");

    if (!output) {
        return undefined;
    }

    const outputType = output.getTypeAtLocation(node);
    const rendered = outputType.getText(node);

    if (!rendered || rendered === "any" || rendered === "never" || ANY_TOKEN_RE.test(rendered.replaceAll(STRING_LITERAL_SPAN_RE, ""))) {
        return undefined;
    }

    const filePath = node.getSourceFile().getFilePath();

    if (referencesUnreachableLocalType(outputType, node, filePath)) {
        return expandUnreachableType(outputType, node, filePath, 0, new Set<Type>());
    }

    return rendered;
};

/**
 * Pull the handler's return type out of an object-literal `query/mutation/action`
 * call (the `{ args, handler }` form).
 */
const returnTypeFromCall = (call: CallExpression): string => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return "unknown";
    }

    const handlerProperty = first.getProperty("handler");

    if (!handlerProperty || !Node.isPropertyAssignment(handlerProperty)) {
        return "unknown";
    }

    const initializer = handlerProperty.getInitializer();

    if (!initializer || !(Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return "unknown";
    }

    return unwrapHandlerReturn(initializer);
};

/**
 * Pull the handler's return type out of a builder terminal call. Here the
 * handler is the first (and only) argument — `c.query(({ ctx, args }) => …)` —
 * not a `handler:` property.
 */
const returnTypeFromBuilderCall = (call: CallExpression): string => {
    const handler = call.getArguments()[0];

    if (!handler || !(Node.isArrowFunction(handler) || Node.isFunctionExpression(handler))) {
        return "unknown";
    }

    return unwrapHandlerReturn(handler);
};

/**
 * Walk a builder chain leftward from the terminal receiver, merging every
 * `.input({...})` argument into one args record. Chains read terminal → root,
 * so a key set by a later `.input()` (encountered first) must win over an
 * earlier one — hence `{ ...earlier, ...merged }`, mirroring the runtime's
 * `{ ...state.args, ...validators }` spread order.
 */
const argsFromBuilderChain = (receiver: Node): Record<string, ValidatorIR> => {
    let merged: Record<string, ValidatorIR> = {};
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "input") {
            const argument = node.getArguments()[0];

            if (argument && Node.isObjectLiteralExpression(argument)) {
                merged = { ...parseObjectShape(argument), ...merged };
            }
        }

        node = chainCallee.getExpression();
    }

    return merged;
};

/**
 * The `.output(validator)` declaration on a builder chain, if any.
 *
 * Walks leftward like {@link argsFromBuilderChain}. Chains read terminal → root,
 * so the FIRST `.output()` encountered is the LAST one written, which is the one
 * that wins at runtime (each `.output()` replaces the previous).
 */
const outputFromBuilderChain = (receiver: Node): ValidatorIR | undefined => {
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            return undefined;
        }

        if (chainCallee.getName() === "output") {
            const argument = node.getArguments()[0];

            return argument && Node.isExpression(argument) ? parseValidator(argument) : undefined;
        }

        node = chainCallee.getExpression();
    }

    return undefined;
};

/** Procedure classification — kind + visibility — produced by {@link classifyProcedureCall}. */
interface ProcedureClassification {
    /** Registration kind: `query` | `mutation` | `action` | `stream`. */
    kind: string;

    /**
     * Set when the call is a connection-lifecycle hook (`onConnect`/`onDisconnect`):
     * the socket side it fires on. The classification is otherwise an internal
     * mutation. Absent for ordinary procedures.
     */
    lifecycle?: LifecycleMoment;

    /**
     * Builder-terminal chain root — the expression to the left of the terminal
     * `.query(...)` (`c.use(...)`) — so callers can walk it further (e.g. to find
     * `.use(rls(...))`). Absent for the bare-factory form.
     */
    receiver?: Node;
    visibility: "internal" | "public";
}

/**
 * Classify an `export const x = …` initializer call as a Lunora registration —
 * its kind and visibility — or `undefined` when it isn't one. Handles both the
 * builder terminal (`c.query(...)`, brand-checked via `__lunoraProcedure` so we
 * don't pick up an unrelated method named `query` on some other object) and the
 * bare factory (`query({…})` / `internalQuery({…})`). The single source of truth
 * for "is this a Lunora procedure, and is it internal?" — shared by function
 * discovery here and the RLS-coverage feeder.
 */
const classifyProcedureCall = (call: CallExpression): ProcedureClassification | undefined => {
    const callee = call.getExpression();

    if (Node.isPropertyAccessExpression(callee)) {
        const method = callee.getName();

        if (!FUNCTION_KINDS.has(method)) {
            return undefined;
        }

        const receiver = callee.getExpression();

        // Fast path: the runtime `__lunoraProcedure` brand on the receiver's
        // type. Internal builders also carry `__lunoraVisibility: "internal"`,
        // so its mere presence marks the procedure internal. This works when the
        // project's `@lunora/server` types resolve.
        if (receiver.getType().getProperty("__lunoraProcedure")) {
            return { kind: method, receiver, visibility: receiver.getType().getProperty("__lunoraVisibility") ? "internal" : "public" };
        }

        // Robust fallback: walk the builder chain (`.input()`/`.use()`/`.output()`)
        // to its root identifier and resolve it by import name — exactly as the
        // bare-factory path does. This keeps discovery working when dependency
        // types aren't installed (e.g. a freshly-scaffolded project before
        // `pnpm install`, where the `__lunoraProcedure` brand can't resolve).
        const rootKind = resolveBuilderRootKind(receiver);

        if (rootKind) {
            return { kind: method, receiver, visibility: rootKind };
        }

        return undefined;
    }

    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const calleeName = resolveCalleeKind(callee);

    if (!calleeName) {
        return undefined;
    }

    if (FUNCTION_KINDS.has(calleeName)) {
        return { kind: calleeName, visibility: "public" };
    }

    const internalKind = INTERNAL_FACTORIES[calleeName];

    if (internalKind) {
        return { kind: internalKind, visibility: "internal" };
    }

    const lifecycle = LIFECYCLE_FACTORIES[calleeName];

    if (lifecycle) {
        // A lifecycle hook is an internal mutation tagged with its socket side;
        // it lands in LUNORA_FUNCTIONS for path dispatch and in the lifecycle
        // manifest emit derives from the `lifecycle` tag.
        return { kind: "mutation", lifecycle, visibility: "internal" };
    }

    return undefined;
};

/** A function whose body we can inspect — an inline arrow or function expression handler. */
type InspectableHandler = ArrowFunction | FunctionExpression;

/** The inline arrow/function-expression handler at `argument`, or `undefined` when it isn't one. */
const inlineHandler = (argument: Node | undefined): InspectableHandler | undefined =>
    argument !== undefined && (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) ? argument : undefined;

/** True when `receiver` is the database accessor: `ctx.db` (property named `db`) or a bare `db`. */
const isDatabaseAccessor = (receiver: Node): boolean =>
    (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") || (Node.isIdentifier(receiver) && receiver.getText() === "db");

/**
 * The inline handler function of a classified procedure call, or `undefined` when
 * it isn't inspectable. The terminal call's first argument is either the handler
 * function directly (`query(async ({ ctx }) => …)` / `c.use(…).query(handler)`) or
 * an object literal carrying it under a `handler` property (`query({ args, handler })`)
 * — both surface forms are handled. The companion to {@link classifyProcedureCall}:
 * classify the call, then pull out the body to inspect.
 */
const procedureHandler = (initializer: CallExpression): InspectableHandler | undefined => {
    const argument = initializer.getArguments()[0];
    const direct = inlineHandler(argument);

    if (direct !== undefined) {
        return direct;
    }

    if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        return undefined;
    }

    const property = argument.getProperty("handler");

    return property !== undefined && Node.isPropertyAssignment(property) ? inlineHandler(property.getInitializer()) : undefined;
};

/** The simple name of a call's callee — a bare identifier's text or a property access's member name, else `""`. */
const calleeName = (callee: Node): string => {
    if (Node.isIdentifier(callee)) {
        return callee.getText();
    }

    return Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
};

/** True when the builder chain rooted at `receiver` carries a step whose method name is `method` (`.output(...)` / `.use(...)`). */
const chainHasStep = (receiver: Node, method: string): boolean => {
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        if (callee.getName() === method) {
            return true;
        }

        node = callee.getExpression();
    }

    return false;
};

/**
 * True when the builder chain rooted at `receiver` carries a
 * `.<method>(<wrappedCallee>(...))` step — a `.<method>(...)` whose first argument
 * is a call to `wrappedCallee` (e.g. `.use(mask(...))` or `.use(rls(...))`).
 */
const chainUsesWrappedCall = (receiver: Node, method: string, wrappedCallee: string): boolean => {
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        const argument = node.getArguments()[0];

        if (
            callee.getName() === method &&
            argument !== undefined &&
            Node.isCallExpression(argument) &&
            calleeName(argument.getExpression()) === wrappedCallee
        ) {
            return true;
        }

        node = callee.getExpression();
    }

    return false;
};

/**
 * Classify a top-level `export const x = …` initializer call as a Lunora
 * registration, or `undefined` when it isn't one. Handles both the bare-factory
 * form (`query({...})` / `internalQuery({...})`) and the builder terminal
 * (`c.query(...)`).
 */
const discoverFromCall = (call: CallExpression): DiscoveredFunction | undefined => {
    const classified = classifyProcedureCall(call);

    if (!classified) {
        return undefined;
    }

    // Builder terminal: pull args/return type from the chain; bare factory: from the call.
    if (classified.receiver) {
        const expose = exposeFromBuilderChain(classified.receiver);
        const output = outputFromBuilderChain(classified.receiver);

        return {
            args: argsFromBuilderChain(classified.receiver),
            ...(expose ? { expose } : {}),
            kind: classified.kind,
            ...(output ? { output } : {}),
            returnType: returnTypeFromBuilderCall(call),
            visibility: classified.visibility,
        };
    }

    // Lifecycle hooks (`onConnect`/`onDisconnect`) take a bare handler, not the
    // `{ args, handler }` literal — their args are framework-fixed (empty) and
    // their return is void, so skip the object-literal extraction.
    if (classified.lifecycle) {
        return { args: {}, kind: classified.kind, lifecycle: classified.lifecycle, returnType: "void", visibility: classified.visibility };
    }

    return {
        args: argsFromCall(call),
        kind: classified.kind,
        returnType: returnTypeFromCall(call),
        visibility: classified.visibility,
    };
};

/**
 * Depth bound for {@link resolveExpressionToCall} so an aliased/cyclic reference
 * (`export const a = b; export const b = a`) can't loop forever.
 */
const RE_EXPORT_RESOLVE_LIMIT = 8;

/**
 * Follow a non-call initializer back to the `query/mutation/action({...})` call
 * that produced it, so a **re-exported** registered function is discovered the
 * same as a directly-declared one. This is what makes a plugin/component's
 * `export const { check } = component.functions` (or
 * `export const check = component.functions.check`) emit into the generated
 * `api`, rather than being silently skipped.
 *
 * Resolution hops through ts-morph symbols — identifier → its `const`
 * initializer, property access → the object-literal `PropertyAssignment`,
 * destructured binding → the matching property on the right-hand side — until it
 * reaches a `CallExpression` (then {@link discoverFromCall} classifies it) or
 * runs out of resolvable steps (then it bails to `undefined`, i.e. skip). A
 * reference into a published component whose value lives only in a `.d.ts` (no
 * call literal) bails cleanly — same as before this resolver existed.
 *
 * Guaranteed shapes are the two documented re-export forms —
 * `export const check = component.functions.check` (property access) and
 * `export const { check } = component.functions` (destructure). More indirect
 * relays (e.g. re-bundling into a fresh object first) may not resolve, but they
 * always **fail safe**: the function is skipped, never mis-attributed.
 */
// `resolveExpressionToCall` and `resolveDeclarationToCall` are mutually
// recursive, so one reference is necessarily forward whatever the order — the
// single disable below covers it (the project's `func-style` rule rules out
// hoisted `function` declarations that would otherwise avoid it).
const resolveExpressionToCall = (node: Node, depth = 0): CallExpression | undefined => {
    if (depth > RE_EXPORT_RESOLVE_LIMIT) {
        return undefined;
    }

    if (Node.isCallExpression(node)) {
        return node;
    }

    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node)) {
        return resolveExpressionToCall(node.getExpression(), depth + 1);
    }

    if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const declaration = node.getSymbol()?.getValueDeclaration();

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; resolveDeclarationToCall is defined just below
    return declaration ? resolveDeclarationToCall(declaration, depth + 1) : undefined;
};

/** Continue {@link resolveExpressionToCall} from the declaration a symbol resolved to. */
const resolveDeclarationToCall = (declaration: Node, depth: number): CallExpression | undefined => {
    if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)) {
        const initializer = declaration.getInitializer();

        return initializer ? resolveExpressionToCall(initializer, depth) : undefined;
    }

    if (Node.isShorthandPropertyAssignment(declaration)) {
        // `{ check }` shorthand — resolve the local `check` it refers to.
        return resolveExpressionToCall(declaration.getNameNode(), depth);
    }

    if (Node.isBindingElement(declaration)) {
        // `const { check } = component.functions` — the value comes from the
        // right-hand side's `check` property, not from the binding element.
        const propertyName = declaration.getPropertyNameNode()?.getText() ?? declaration.getName();
        const variableDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const rightHandSide = variableDeclaration?.getInitializer();
        const propertyDeclaration = rightHandSide?.getType().getProperty(propertyName)?.getValueDeclaration();

        return propertyDeclaration ? resolveDeclarationToCall(propertyDeclaration, depth + 1) : undefined;
    }

    return undefined;
};

/**
 * Yield the `[exportName, call]` pairs an exported variable declaration
 * contributes. Handles both `export const list = query({...})` (direct, or an
 * identifier/property-access re-export resolved via {@link resolveExpressionToCall})
 * and `export const { check, reset } = component.functions` (one pair per
 * destructured element). Pairs whose call isn't a Lunora registration are
 * filtered out downstream by {@link discoverFromCall}.
 */
const exportCallsOfDeclaration = (declaration: VariableDeclaration): [string, CallExpression][] => {
    const nameNode = declaration.getNameNode();

    if (Node.isObjectBindingPattern(nameNode)) {
        const pairs: [string, CallExpression][] = [];

        for (const element of nameNode.getElements()) {
            const call = resolveExpressionToCall(element.getNameNode());

            if (call) {
                pairs.push([element.getName(), call]);
            }
        }

        return pairs;
    }

    const initializer = declaration.getInitializer();
    const call = initializer && (Node.isCallExpression(initializer) ? initializer : resolveExpressionToCall(initializer));

    return call ? [[declaration.getName(), call]] : [];
};

/** Build a {@link FunctionIR} entry from one classified registration call, or `undefined` when it isn't a Lunora registration. */
const functionIrFromCall = (call: CallExpression, exportName: string, relativePath: string): FunctionIR | undefined => {
    const discovered = discoverFromCall(call);

    if (!discovered) {
        return undefined;
    }

    return {
        args: discovered.args,
        exportName,
        filePath: relativePath,
        kind: discovered.kind as FunctionIR["kind"],
        returnType: discovered.returnType,
        ...(discovered.output ? { output: discovered.output } : {}),
        visibility: discovered.visibility,
        ...(discovered.expose ? { expose: discovered.expose } : {}),
        ...(discovered.lifecycle ? { lifecycle: discovered.lifecycle } : {}),
    };
};

/**
 * Lift `export default <procedure>` into a `<module>.default` registration,
 * matching Convex.
 *
 * Only named exports used to be walked, so a module whose sole registration was
 * a default export did not merely lose that entry — the whole module was absent
 * from `api.ts`, and the caller's error read "Property '<module>' does not
 * exist", pointing at a file that was entirely correct.
 *
 * `export = x` is CJS and never a Lunora registration. Non-procedure defaults
 * (`export default cronJobs()`, a workflow registry) classify to `undefined`
 * and are skipped like any other non-registration call.
 */
const defaultExportFunctions = (source: SourceFile, relativePath: string): FunctionIR[] => {
    const found: FunctionIR[] = [];

    for (const assignment of source.getExportAssignments()) {
        if (assignment.isExportEquals()) {
            continue;
        }

        const call = resolveExpressionToCall(assignment.getExpression());
        const entry = call ? functionIrFromCall(call, "default", relativePath) : undefined;

        if (entry) {
            found.push(entry);
        }
    }

    return found;
};

/** Lift every Lunora registration in one source file into {@link FunctionIR} entries. */
const discoverFileFunctions = (source: SourceFile, relativePath: string): FunctionIR[] => {
    const found: FunctionIR[] = [];

    for (const statement of source.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            for (const [exportName, call] of exportCallsOfDeclaration(declaration)) {
                const entry = functionIrFromCall(call, exportName, relativePath);

                if (entry) {
                    found.push(entry);
                }
            }
        }
    }

    found.push(...defaultExportFunctions(source, relativePath));

    return found;
};

/**
 * Detect namespace collisions: two distinct file paths that sanitize to the
 * same identifier (e.g. `foo/bar.ts` and `foo-bar.ts` both → `foo_bar`).
 * Without this guard, emit silently produces duplicate `ApiTypes` keys and an
 * ambiguous dispatch table.
 *
 * Migrations are intentionally NOT considered here: the emitted `LUNORA_MIGRATIONS`
 * table keys on the migration `id` (uniqueness-checked separately during migration
 * discovery), not on the sanitized namespace, and `emitServer` aliases imports by
 * exact `filePath`. So a migration-only file that sanitizes to the same namespace
 * as a function file cannot collide — only function↔function pairs can.
 */
const assertNoNamespaceCollision = (functions: ReadonlyArray<FunctionIR>): void => {
    const namespaceOrigins = new Map<string, string>();

    for (const entry of functions) {
        const namespace = sanitizeNamespace(entry.filePath);
        const prior = namespaceOrigins.get(namespace);

        if (prior && prior !== entry.filePath) {
            throw Object.assign(
                new Error(
                    `Namespace collision: "${prior}" and "${entry.filePath}" both resolve to "${namespace}". Rename one of the files so the JS-identifier-sanitized names differ. (note: case-insensitive filesystems may also cause this — \`foo\` and \`FOO\` map to the same identifier)`,
                ),
                { code: "NAMESPACE_COLLISION", name: "LunoraError", paths: [prior, entry.filePath], status: 500 },
            );
        }

        namespaceOrigins.set(namespace, entry.filePath);
    }
};

/**
 * Scan all .ts files under `lunoraDir` (skipping `_generated/` and `schema.ts`)
 * for top-level `export const x = query/mutation/action({...})` registrations.
 */
const discoverFunctions = (project: Project, lunoraDirectory: string): FunctionIR[] => {
    const filePaths = listLunoraSourceFiles(lunoraDirectory);
    const functions: FunctionIR[] = [];

    for (const filePath of filePaths) {
        const source: SourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        functions.push(...discoverFileFunctions(source, relativePath));
    }

    functions.sort((a, b) => `${a.filePath}:${a.exportName}`.localeCompare(`${b.filePath}:${b.exportName}`));

    assertNoNamespaceCollision(functions);

    return functions;
};

export type { InspectableHandler, ProcedureClassification };
export {
    chainHasStep,
    chainUsesWrappedCall,
    classifyProcedureCall,
    discoverFunctions,
    inlineHandler,
    isDatabaseAccessor,
    procedureHandler,
    resolveStandardSchemaType,
    unwrapHandlerReturn,
};

export { listLunoraSourceFiles, lunoraRelativePath } from "./discover-ast";
