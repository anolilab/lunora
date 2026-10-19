import type { ExportDeclaration, ExportSpecifier, Expression, ImportDeclaration, ImportSpecifier, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CapabilityKey } from "../capabilities";
import { CAPABILITIES } from "../capabilities";
import { bindingKeyName, listLunoraSourceFiles } from "./ast";
import type { SandboxUsage } from "./sandbox";
import { noSandboxUsage, scanImportDeclaration } from "./sandbox";

/**
 * Code-usage signals for every optional, package-backed feature, in a single
 * pass over the `lunora/` source set. Each flag is `true` when a source imports
 * the feature's `@lunora/*` package (for more than its binding-free helpers —
 * see {@link sourceCapabilitySignals}) or reads its generated `ctx.*` helper. This
 * is the one detection path for all of them — it subsumes the old standalone
 * `discoverAiUsage` / `discoverPaymentUsage` probes (which were line-for-line
 * copies of this same import-or-`ctx.X` check).
 *
 * The key set is derived from the {@link CAPABILITIES} table (its
 * {@link CapabilityKey} union), so a capability added there is automatically
 * probed here — the two can't drift. `ai` and `payments` gate whether codegen
 * wires the SDK into the generated worker (so a non-AI app never imports
 * `@lunora/ai`); the rest additionally feed the studio's nav gating via
 * `buildStudioFeatures`. `mail` is import-only — it has no `ctx.mail`
 * helper (mail is reached through its own client), so only a `@lunora/mail`
 * import flips it here; a worker-entry wiring outside `lunora/` is caught
 * instead by the package-dependency signal in `buildStudioFeatures`.
 */
type FeatureUsage = Record<CapabilityKey, boolean>;

/** The property a handler's single destructured argument carries the request context on: `async ({ args, ctx }) => …`. */
const CONTEXT_PROPERTY = "ctx";

/**
 * Names read through a literal key, `ctx["live"]`: the same property as `ctx.live`. A computed key is not a name the
 * collector can know, so it is not recorded.
 */
const collectLiteralKeyReads = (sourceFile: SourceFile, reachesContext: (receiver: Node) => boolean, names: Set<string>): void => {
    for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
        const key = access.getArgumentExpression();

        if (reachesContext(access.getExpression()) && key !== undefined && (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key))) {
            names.add(key.getLiteralValue());
        }
    }
};

/**
 * The set of `ctx` helper names the source reaches — a direct `ctx.PROPERTY`
 * access, or a destructuring of the property off the context (`const { kv } =
 * ctx`, `async ({ ctx: { kv } }) => …`).
 *
 * The context is resolved by BINDING, not by the identifier text `ctx`. A
 * handler receives it as a property of one destructured argument, so the local
 * name it lands under is the handler's to pick: `{ ctx }`, `{ ctx: context }`
 * and `{ ctx: { secrets } }` are the same read. Matching the text `ctx`
 * recognised only the first — and for `secrets`, which has no import arm and no
 * {@link CAPABILITIES} row, nothing else covered the other two, so a renamed or
 * destructured read built green on a host that rates the Secrets Store
 * unsupported and threw on first use.
 *
 * Three descendant walks (bindings, then accesses and `const … = ctx` patterns),
 * collected once per file: each context-bearing {@link CAPABILITIES} entry then
 * just tests membership in this set, so detection is O(files × nodes) rather
 * than O(files × features × nodes).
 */
const contextPropertiesRead = (sourceFile: SourceFile): Set<string> => {
    const names = new Set<string>();
    /** Local names bound to the context. */
    const contextNames = new Set<string>();

    // A plain `ctx` parameter (`async (ctx) => …`) is a context, but it is not a binding pattern, so the walk below cannot see it. Count the
    // bare spelling only where the file binds one as a parameter, or aliases a parameter to it (`(context) => { const ctx = context; … }`);
    // a `const ctx = {}` that is no handler's context must not read as one.
    const parameterNames = new Set(sourceFile.getDescendantsOfKind(SyntaxKind.Parameter).map((parameter) => parameter.getName()));
    const aliasesParameter = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).some((declaration) => {
        const initializer = declaration.getInitializer();

        return declaration.getName() === CONTEXT_PROPERTY && Node.isIdentifier(initializer) && parameterNames.has(initializer.getText());
    });

    if (parameterNames.has(CONTEXT_PROPERTY) || aliasesParameter) {
        contextNames.add(CONTEXT_PROPERTY);
    }

    const collectPatternNames = (pattern: Node): void => {
        if (!Node.isObjectBindingPattern(pattern)) {
            return;
        }

        for (const element of pattern.getElements()) {
            const name = bindingKeyName(element);

            if (name) {
                names.add(name);
            }
        }
    };

    // Anchor on the `ctx` PROPERTY of a binding pattern, wherever it appears —
    // a handler parameter or a `const { ctx } = …`. A rename introduces another
    // context name to follow; a nested pattern is the read itself.
    for (const element of sourceFile.getDescendantsOfKind(SyntaxKind.BindingElement)) {
        if (bindingKeyName(element) !== CONTEXT_PROPERTY) {
            continue;
        }

        const nameNode = element.getNameNode();

        if (Node.isIdentifier(nameNode)) {
            contextNames.add(nameNode.getText());
        } else {
            collectPatternNames(nameNode);
        }
    }

    const reachesContext = (receiver: Node): boolean => Node.isIdentifier(receiver) && contextNames.has(receiver.getText());

    for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (reachesContext(access.getExpression())) {
            names.add(access.getName());
        }
    }

    collectLiteralKeyReads(sourceFile, reachesContext, names);

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const initializer = declaration.getInitializer();

        if (initializer !== undefined && reachesContext(initializer)) {
            collectPatternNames(declaration.getNameNode());
        }
    }

    return names;
};

/**
 * Whether an import or re-export declaration compiles away: `import type { … }
 * from "…"` / `export type { … } from "…"`, or a named-only list whose every
 * specifier is `type`-qualified (`import { type A, type B } from "…"`). Such a
 * declaration names a capability's types without using it — an events-only queue
 * consumer importing a payload type, say — so it must not flip the usage probe
 * and wire `ctx.<cap>` (nor, through {@link sourceCapabilitySignals},
 * `@lunora/config`'s binding inference). A side-effect import (`import "…"`), a
 * default or namespace import, an `export * from "…"`, or a named list with at
 * least one value specifier still counts.
 */
const compilesAway = (declaration: ExportDeclaration | ImportDeclaration): boolean => {
    if (declaration.isTypeOnly()) {
        return true;
    }

    if (Node.isExportDeclaration(declaration)) {
        const named = declaration.getNamedExports();

        return !declaration.isNamespaceExport() && named.length > 0 && named.every((specifier) => specifier.isTypeOnly());
    }

    const named = declaration.getNamedImports();

    return (
        declaration.getDefaultImport() === undefined &&
        declaration.getNamespaceImport() === undefined &&
        named.length > 0 &&
        named.every((specifier) => specifier.isTypeOnly())
    );
};

/** Each capability package's `bindingFreeExports` (see {@link CAPABILITIES}), keyed by its specifier. */
const BINDING_FREE_EXPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
    CAPABILITIES.flatMap(({ bindingFreeExports, moduleSpecifier }) =>
        bindingFreeExports === undefined ? [] : [[moduleSpecifier, new Set(bindingFreeExports)] as const],
    ),
);

/**
 * Whether a surviving import or re-export names only its package's binding-free
 * helpers (`import { buildSignedUrl } from "@lunora/storage"`), which use no
 * binding and so must not mark the capability used. A non-empty named list is
 * required — a default, namespace or side-effect import, or an `export *`, may
 * reach anything and counts; `type`-qualified specifiers are skipped (they
 * compile away). The imported name is matched, not a local alias.
 */
const namesOnlyBindingFreeExports = (declaration: ExportDeclaration | ImportDeclaration, moduleSpecifier: string): boolean => {
    const allowed = BINDING_FREE_EXPORTS.get(moduleSpecifier);

    if (allowed === undefined) {
        return false;
    }

    if (Node.isImportDeclaration(declaration) && (declaration.getDefaultImport() !== undefined || declaration.getNamespaceImport() !== undefined)) {
        return false;
    }

    // `export * from` and a side-effect import have no named list, so they fall out with the empty case.
    const named = Node.isExportDeclaration(declaration) ? declaration.getNamedExports() : declaration.getNamedImports();

    return named.length > 0 && named.every((specifier) => specifier.isTypeOnly() || allowed.has(specifier.getName()));
};

/** The literal specifiers of a file's dynamic `import("…")` calls (a computed specifier names nothing and is skipped). */
const dynamicImportSpecifiers = (sourceFile: SourceFile): Set<string> => {
    const specifiers = new Set<string>();

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const [argument] = call.getArguments();

        if (call.getExpression().getKind() === SyntaxKind.ImportKeyword && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))) {
            specifiers.add(argument.getLiteralValue());
        }
    }

    return specifiers;
};

/** The per-file (or folded, per-project) signals the capability probe reads. */
interface SourceCapabilitySignals {
    /** The `ctx` helper names the file reads — see {@link contextPropertiesRead}. */
    contextReads: ReadonlySet<string>;

    /**
     * Literal specifiers of the file's dynamic `import("…")` calls. Codegen's own
     * probe ignores them (it wires a helper off a static import); `@lunora/config`
     * counts them, since a lazily loaded package needs its binding just the same.
     */
    dynamicImports: ReadonlySet<string>;

    /**
     * Whether the file value-imports `requestSecretTool` from `@lunora/agent` — the
     * signal that wires the secret store ({@link fileWiresRequestSecretTool}).
     */
    requestSecretTool: boolean;

    /** The `@lunora/agent` sandbox tools the file value-imports — the same reading as `discoverSandboxUsage`. */
    sandboxTools: Readonly<SandboxUsage>;

    /**
     * Module specifiers of the file's static imports and re-exports (`export … from "…"`)
     * that survive compilation ({@link compilesAway}) and name more than binding-free
     * helpers ({@link namesOnlyBindingFreeExports}).
     */
    valueImports: ReadonlySet<string>;
}

/** The package the agent tools are imported from. */
const AGENT_MODULE_SPECIFIER = "@lunora/agent";

/** The agent tool that asks a human for a secret value. */
const REQUEST_SECRET_TOOL = "requestSecretTool";

/** Whether a module specifier is a relative path, so a file of this app rather than a package. */
const isRelativeSpecifier = (specifier: string): boolean => specifier.startsWith("./") || specifier.startsWith("../");

/** The name an import or export specifier makes visible: its alias when it has one. */
const visibleNameOf = (entry: ImportSpecifier | ExportSpecifier): string => entry.getAliasNode()?.getText() ?? entry.getNameNode().getText();

/** Whether an expression is the tool itself, or a call of it, under one of the `bound` local names. */
const isToolReference = (expression: Expression | undefined, bound: ReadonlySet<string>): boolean => {
    const callee = expression !== undefined && Node.isCallExpression(expression) ? expression.getExpression() : expression;

    return callee !== undefined && Node.isIdentifier(callee) && bound.has(callee.getText());
};

/** The local names a file binds to the agent's `requestSecretTool` by a value import, under any alias. */
const boundToolNames = (file: SourceFile): Set<string> => {
    const bound = new Set<string>();

    for (const declaration of file.getImportDeclarations()) {
        if (declaration.getModuleSpecifierValue() !== AGENT_MODULE_SPECIFIER || declaration.isTypeOnly()) {
            continue;
        }

        for (const named of declaration.getNamedImports()) {
            if (!named.isTypeOnly() && named.getNameNode().getText() === REQUEST_SECRET_TOOL) {
                bound.add(visibleNameOf(named));
            }
        }
    }

    return bound;
};

/**
 * What a module makes of `requestSecretTool`: the names it exports the tool under (`names`), and the
 * namespace bindings it exports (`export * as agent from …`) mapped to the tool names those carry
 * (`namespaces`), so `agent.requestSecretTool(…)` reads through them.
 */
interface SecretToolExports {
    names: Set<string>;
    namespaces: Map<string, Set<string>>;
}

const toolExports = (names: Iterable<string>): SecretToolExports => {
    return { names: new Set(names), namespaces: new Map() };
};

/**
 * Accumulate into `exported` what a re-export makes visible, given what `forwarded` carries through it:
 * every name for `export *`, the listed ones under their aliases otherwise. A namespace export binds the
 * forwarded names as one object, so its members are read off the binding rather than imported directly.
 */
const reexportedBy = (declaration: ExportDeclaration, forwarded: SecretToolExports, exported: SecretToolExports): void => {
    const namespaceExport = declaration.getNamespaceExport();

    if (namespaceExport !== undefined) {
        // A nested namespace keeps its path: `agent.requestSecretTool` is what a reader of `tools` reaches through it.
        const members = new Set(forwarded.names);

        forwarded.namespaces.forEach((inner, member) => {
            inner.forEach((name) => {
                members.add(`${member}.${name}`);
            });
        });

        if (members.size > 0) {
            exported.namespaces.set(namespaceExport.getName(), members);
        }

        return;
    }

    if (!declaration.hasNamedExports()) {
        forwarded.names.forEach((name) => exported.names.add(name));
        forwarded.namespaces.forEach((members, name) => exported.namespaces.set(name, members));

        return;
    }

    for (const entry of declaration.getNamedExports()) {
        if (entry.isTypeOnly()) {
            continue;
        }

        const original = entry.getNameNode().getText();
        const visible = visibleNameOf(entry);

        if (forwarded.names.has(original)) {
            exported.names.add(visible);
        }

        const members = forwarded.namespaces.get(original);

        if (members !== undefined) {
            exported.namespaces.set(visible, members);
        }
    }
};

/**
 * What a re-export carries through it. A local `export { ask }` carries the bound names;
 * the agent carries the tool; a relative module carries what `resolve` finds in it.
 */
const forwardedThrough = (
    declaration: ExportDeclaration,
    bound: ReadonlySet<string>,
    resolve: (target: SourceFile) => SecretToolExports,
): SecretToolExports => {
    const specifier = declaration.getModuleSpecifierValue();

    if (specifier === undefined) {
        return toolExports(bound);
    }

    if (specifier === AGENT_MODULE_SPECIFIER) {
        return toolExports([REQUEST_SECRET_TOOL]);
    }

    const target = isRelativeSpecifier(specifier) ? declaration.getModuleSpecifierSourceFile() : undefined;

    return target === undefined ? toolExports([]) : resolve(target);
};

/**
 * What `file` exports of `requestSecretTool` from `@lunora/agent`: under its own name or an alias, or as a
 * value it binds to the tool (`export const x = requestSecretTool({...})`), and as namespace bindings.
 * A relative re-export is followed, so a barrel that only forwards the tool counts. `onPath` holds the
 * modules being visited: a module is cut only while it is its own ancestor, so a second re-export of the
 * same module (a sibling alias) still resolves.
 */
const requestSecretToolExportsOf = (file: SourceFile, onPath: Set<SourceFile>): SecretToolExports => {
    const exported = toolExports([]);

    if (onPath.has(file)) {
        return exported;
    }

    onPath.add(file);

    const bound = boundToolNames(file);

    for (const declaration of file.getExportDeclarations()) {
        if (declaration.isTypeOnly()) {
            continue;
        }

        reexportedBy(
            declaration,
            forwardedThrough(declaration, bound, (target) => requestSecretToolExportsOf(target, onPath)),
            exported,
        );
    }

    for (const statement of file.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declared of statement.getDeclarations()) {
            if (isToolReference(declared.getInitializer(), bound)) {
                exported.names.add(declared.getName());
            }
        }
    }

    onPath.delete(file);

    return exported;
};

/** What an import declaration brings in from the secret tool: the agent's, or a relative module's exports of it. */
const importedToolNames = (declaration: ImportDeclaration, importer: SourceFile): SecretToolExports => {
    const specifier = declaration.getModuleSpecifierValue();

    if (specifier === AGENT_MODULE_SPECIFIER) {
        return toolExports([REQUEST_SECRET_TOOL]);
    }

    const target = isRelativeSpecifier(specifier) ? declaration.getModuleSpecifierSourceFile() : undefined;

    return target === undefined ? toolExports([]) : requestSecretToolExportsOf(target, new Set([importer]));
};

/** Whether `file` reads a member of the namespace `namespace` whose name is one of `names` (`ns.requestKey`). */
const readsNamespaceMember = (file: SourceFile, namespace: string, names: ReadonlySet<string>): boolean =>
    file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((access) => {
        const expression = access.getExpression().getText();

        // `ns.name`, or `ns.inner.name` through a nested namespace, which `names` records as `inner.name`.
        if (expression === namespace) {
            return names.has(access.getName());
        }

        return expression.startsWith(`${namespace}.`) && names.has(`${expression.slice(namespace.length + 1)}.${access.getName()}`);
    });

/**
 * Whether a named import wires the tool: it imports a name the module exports the tool under, or a namespace
 * binding (`export * as agent`) whose local name reads the tool off it.
 */
const namedImportWiresTool = (file: SourceFile, named: ImportSpecifier, exported: SecretToolExports): boolean => {
    if (exported.names.has(named.getNameNode().getText())) {
        return true;
    }

    const members = exported.namespaces.get(named.getNameNode().getText());

    return members !== undefined && readsNamespaceMember(file, visibleNameOf(named), members);
};

/**
 * Whether a source file value-imports `requestSecretTool` from `@lunora/agent`, by a
 * named import, a namespace import that reads it, or an import of a relative module that
 * exports it (a barrel, or a tool defined in another module of the app). A type-only
 * import does not count: only a value import wires the tool into an agent. The one rule
 * codegen's secret-store gate and `@lunora/config`'s binding inference both read.
 */
const fileWiresRequestSecretTool = (file: SourceFile): boolean =>
    file.getImportDeclarations().some((declaration) => {
        if (declaration.isTypeOnly()) {
            return false;
        }

        const exported = importedToolNames(declaration, file);

        if (exported.names.size === 0 && exported.namespaces.size === 0) {
            return false;
        }

        const defaultImport = declaration.getDefaultImport();
        const namespace = declaration.getNamespaceImport();

        // A default import binds the module's `default` export. That is the tool itself when a barrel re-exports it as
        // `default`, or a namespace when it re-exports the agent package with `export * as default`, read for the tool.
        const defaultWiresTool =
            defaultImport !== undefined &&
            (exported.names.has("default") || readsNamespaceMember(file, defaultImport.getText(), exported.namespaces.get("default") ?? new Set<string>()));

        return (
            defaultWiresTool ||
            declaration.getNamedImports().some((named) => !named.isTypeOnly() && namedImportWiresTool(file, named, exported)) ||
            (namespace !== undefined && readsNamespaceMember(file, namespace.getText(), exported.names))
        );
    });

/**
 * The capability signals of one source file: its value-import and re-export
 * specifiers, its dynamic-import specifiers, its sandbox-tool imports and its
 * `ctx.<property>` reads. The single reading behind codegen's usage probe —
 * exported so `@lunora/config`'s binding inference reads the same signals and
 * judges them with the same {@link capabilitiesUsedBy}.
 */
const sourceCapabilitySignals = (sourceFile: SourceFile): SourceCapabilitySignals => {
    const imports = sourceFile.getImportDeclarations();
    const sandboxTools = noSandboxUsage();

    for (const declaration of imports) {
        const found = scanImportDeclaration(declaration);

        for (const tool of Object.keys(sandboxTools) as (keyof SandboxUsage)[]) {
            sandboxTools[tool] ||= found[tool];
        }
    }

    return {
        contextReads: contextPropertiesRead(sourceFile),
        dynamicImports: dynamicImportSpecifiers(sourceFile),
        requestSecretTool: fileWiresRequestSecretTool(sourceFile),
        sandboxTools,
        valueImports: new Set(
            [...imports, ...sourceFile.getExportDeclarations()].flatMap((declaration) => {
                const specifier = declaration.getModuleSpecifierValue();

                return specifier === undefined || compilesAway(declaration) || namesOnlyBindingFreeExports(declaration, specifier) ? [] : [specifier];
            }),
        ),
    };
};

/** Union per-file signals into one — a capability is used when ANY file in the set uses it. */
const foldCapabilitySignals = (signals: Iterable<SourceCapabilitySignals>): SourceCapabilitySignals => {
    const contextReads = new Set<string>();
    const dynamicImports = new Set<string>();
    const sandboxTools = noSandboxUsage();
    const valueImports = new Set<string>();
    let requestSecretTool = false;

    for (const file of signals) {
        requestSecretTool ||= file.requestSecretTool;

        for (const name of file.contextReads) {
            contextReads.add(name);
        }

        for (const specifier of file.dynamicImports) {
            dynamicImports.add(specifier);
        }

        for (const specifier of file.valueImports) {
            valueImports.add(specifier);
        }

        for (const tool of Object.keys(sandboxTools) as (keyof SandboxUsage)[]) {
            sandboxTools[tool] ||= file.sandboxTools[tool];
        }
    }

    return { contextReads, dynamicImports, requestSecretTool, sandboxTools, valueImports };
};

/**
 * The capabilities a set of signals marks as used: a value import (or re-export)
 * of the row's `moduleSpecifier`, or a read of its `ctx.<contextProperty>`. The
 * ONE matcher — codegen's usage probe and `@lunora/config`'s binding inference
 * both call it, so they cannot disagree on what "used" means. Dynamic imports
 * are not consulted; a caller that counts them merges them into `valueImports`.
 */
const capabilitiesUsedBy = (signals: Pick<SourceCapabilitySignals, "contextReads" | "valueImports">): ReadonlySet<CapabilityKey> =>
    new Set(
        CAPABILITIES.filter(
            ({ contextProperty, moduleSpecifier }) =>
                signals.valueImports.has(moduleSpecifier) || (contextProperty !== undefined && signals.contextReads.has(contextProperty)),
        ).map(({ key }) => key),
    );

const CONTEXT_PATTERN = new RegExp(String.raw`\b${CONTEXT_PROPERTY}\b`, "u");
const CONTEXT_HELPER_PATTERN = new RegExp(
    String.raw`\b(?:${CAPABILITIES.flatMap(({ contextProperty }) => (contextProperty === undefined ? [] : [contextProperty])).join("|")})\b`,
    "u",
);

/**
 * Cheap text prefilter: whether `code` could read a capability's `ctx` helper at
 * all. Every form {@link contextPropertiesRead} recognises (an access, a
 * destructure, a renamed context) names the `ctx` property somewhere and names
 * the helper too, so a file failing this needs no parse for its `ctx` reads.
 */
const mayReadCapabilityContext = (code: string): boolean => CONTEXT_PATTERN.test(code) && CONTEXT_HELPER_PATTERN.test(code);

/**
 * Detect code-usage of every package-backed feature across the function files
 * under `lunora/`: the files' signals folded once, judged by
 * {@link capabilitiesUsedBy}. The result feeds both worker gating (`ai` /
 * `payments`) and — via `buildStudioFeatures` — the studio nav.
 */
const discoverFeatureUsage = (project: Project, lunoraDirectory: string): FeatureUsage => {
    const signals = foldCapabilitySignals(
        listLunoraSourceFiles(lunoraDirectory).map((filePath) =>
            sourceCapabilitySignals(project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath)),
        ),
    );
    const used = capabilitiesUsedBy(signals);

    // The one widening `Object.fromEntries` forces: its keys provably come from `CAPABILITIES`.
    return Object.fromEntries(CAPABILITIES.map(({ key }) => [key, used.has(key)] as const)) as FeatureUsage;
};

export {
    capabilitiesUsedBy,
    contextPropertiesRead,
    discoverFeatureUsage,
    fileWiresRequestSecretTool,
    foldCapabilitySignals,
    mayReadCapabilityContext,
    sourceCapabilitySignals,
};
export type { FeatureUsage, SourceCapabilitySignals };
