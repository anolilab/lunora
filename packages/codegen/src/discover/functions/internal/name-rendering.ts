import { posix } from "node:path";

import type { ImportDeclaration, SourceFile, Symbol as TsSymbol, Type } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

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
    /** The specifier a package was written with, or the resolved file a relative import names (see {@link emittedSpecifierFor}). */
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
const matchesAmbientModule = (importDeclaration: ImportDeclaration, ambientSpecifier: string, name: string): string | undefined =>
    importDeclaration.getModuleSpecifierValue() === ambientSpecifier && bindsByName(importDeclaration, name) ? name : undefined;

/**
 * Whether `importDeclaration`'s DEFAULT binding resolves to `declaration`.
 *
 * A default import's local name says nothing about the export it came from, so
 * this matches by resolving the binding rather than by comparing names — and the
 * name it must be written under is `default`, whatever the local alias is.
 */
const matchesDefaultImport = (importDeclaration: ImportDeclaration, declaration: Node): string | undefined => {
    const defaultImport = importDeclaration.getDefaultImport();

    if (defaultImport === undefined) {
        return undefined;
    }

    const bound = defaultImport.getSymbol();

    return (bound?.getAliasedSymbol() ?? bound)?.getDeclarations().includes(declaration) === true ? "default" : undefined;
};

/** Whether `importDeclaration` brings `name` in from the module that declares it, through any re-export chain. */
const matchesNamedImport = (importDeclaration: ImportDeclaration, declaration: Node, name: string): string | undefined => {
    if (!bindsByName(importDeclaration, name)) {
        return undefined;
    }

    const moduleFile = importDeclaration.getModuleSpecifierSourceFile();
    const exported = moduleFile === undefined ? undefined : moduleExport(moduleFile, name);
    const target = exported?.getAliasedSymbol() ?? exported;

    return target?.getDeclarations().includes(declaration) === true ? name : undefined;
};

/** A specifier resolved from the handler's own directory rather than from a package name. */
const RELATIVE_SPECIFIER_RE = /^\.\.?(?:$|\/)/u;

/**
 * The extension a module is written as once emitted, keyed by the extension its
 * file has on disk. TypeScript's own resolution substitutes in this direction —
 * `.js` finds `.ts`, `.mjs` finds `.mts` — and only within a family, which is why
 * `.mts` and `.cts` cannot borrow the plain `.js` that `.ts`/`.tsx`/`.d.ts` use.
 *
 * `.d.ts` earns its own key because ts-morph reports it whole rather than as
 * `.ts`, so a declaration file misses a map that lists only the four source
 * extensions — and `index.d.ts` is a directory-index candidate under every
 * resolution mode, which is how a hand-written shim directory used to slip
 * through this with the blanket suffix still on it.
 */
const EMITTED_EXTENSIONS = new Map([
    [".cjs", ".cjs"],
    [".cts", ".cjs"],
    [".d.ts", ".js"],
    [".js", ".js"],
    [".jsx", ".jsx"],
    [".mjs", ".mjs"],
    [".mts", ".mjs"],
    [".ts", ".js"],
    [".tsx", ".js"],
]);

/**
 * Name the module a handler imported from by the file it RESOLVED to, carrying
 * the extension that file is emitted as.
 *
 * The qualifier `_generated/` gets is the user's own import text, and several
 * spellings of it resolve where they were written and nowhere else — each a
 * TS2307/TS5097 in a file nobody wrote and nothing can repair from outside:
 * `paths` does not apply to a relative specifier, and no ambient declaration
 * satisfies a qualified `import("…").T`.
 *
 * `emit.ts` rebases a relative qualifier out of `_generated/` and appends `.js`
 * when it carries no extension, because the generated files are consumed under
 * NodeNext where the extension is mandatory. That single suffix is right for
 * exactly one case — a `.ts` file named without an extension — and wrong for the
 * rest.
 *
 * A DIRECTORY (`./agent/client` → `agent/client/index.ts`) has no extension to
 * substitute, so `../agent/client.js` resolves to nothing. A `.mts`/`.cts` file
 * is emitted as `.mjs`/`.cjs`, and substitution does not cross families, so
 * `.js` misses it. A TS extension the app wrote itself (`./lib/types.ts`, legal
 * under `allowImportingTsExtensions`) is kept verbatim and is illegal everywhere
 * that flag is off — including a dedicated strict config for generated output,
 * the pattern this repo itself ships.
 *
 * None of those are questions to ask the written STRING, which is why this
 * rebuilds the specifier from the resolved path instead of editing the text.
 * Every shape a heuristic gets wrong — a directory named `index`, a directory
 * reached as `./feature/index`, one resolved through its own `package.json`
 * `types` to a file that is not called `index` at all, a dotted directory name
 * that reads as an extension — is simply the path the checker already found,
 * expressed from the handler's own directory.
 *
 * Left exactly as written: a package specifier (correct from any directory
 * already), an unresolved or ambient import, and a file in no family we emit —
 * a `.json` module, whose extension is part of its name rather than something
 * substitution restores.
 */
const emittedSpecifierFor = (handlerFile: SourceFile, importDeclaration: ImportDeclaration): string | undefined => {
    const written = importDeclaration.getModuleSpecifierValue();

    if (!RELATIVE_SPECIFIER_RE.test(written)) {
        return undefined;
    }

    const moduleFile = importDeclaration.getModuleSpecifierSourceFile();
    const extension = moduleFile === undefined ? undefined : EMITTED_EXTENSIONS.get(moduleFile.getExtension());

    if (moduleFile === undefined || extension === undefined) {
        return undefined;
    }

    // ts-morph normalises every path it reports to forward slashes, so the POSIX
    // helpers are the right ones here on Windows too.
    const target = `${posix.join(moduleFile.getDirectoryPath(), moduleFile.getBaseNameWithoutExtension())}${extension}`;
    const rebased = posix.relative(handlerFile.getDirectoryPath(), target);

    return rebased.startsWith(".") ? rebased : `./${rebased}`;
};

/**
 * The module specifier the handler's file imports `name` from, when that import
 * resolves to `declaration` — the literal string the user wrote, never a
 * resolved path. `undefined` when the module does not import it.
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
        // The matchers answer only WHICH EXPORT was reached. The specifier is
        // built once, here, so no matcher can be added later that forgets it.
        const exportName =
            ambientSpecifier === undefined
                ? (matchesDefaultImport(importDeclaration, declaration) ?? matchesNamedImport(importDeclaration, declaration, name))
                : matchesAmbientModule(importDeclaration, ambientSpecifier, name);

        if (exportName !== undefined) {
            return { exportName, specifier: emittedSpecifierFor(handlerFile, importDeclaration) ?? importDeclaration.getModuleSpecifierValue() };
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

export { annotationRendering, classifyType, isGloballyDeclared };
export type { QualifiedImport };
