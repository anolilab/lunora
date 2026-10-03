import type { ExportDeclaration, ImportDeclaration, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CapabilityKey } from "../capabilities";
import { CAPABILITIES } from "../capabilities";
import { bindingKeyName, listLunoraSourceFiles } from "./ast";
import type { SandboxUsage } from "./sandbox";
import { noSandboxUsage, scanImportDeclaration } from "./sandbox";

/**
 * Code-usage signals for every optional, package-backed feature, in a single
 * pass over the `lunora/` source set. Each flag is `true` when a source imports
 * the feature's `@lunora/*` package or reads its generated `ctx.*` helper. This
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
    /** Local names bound to the context. `ctx` itself always counts — it is the conventional spelling and the one every fixture uses. */
    const contextNames = new Set<string>([CONTEXT_PROPERTY]);

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
    /** The `@lunora/agent` sandbox tools the file value-imports — the same reading as `discoverSandboxUsage`. */
    sandboxTools: Readonly<SandboxUsage>;
    /** Module specifiers of the file's static imports and re-exports (`export … from "…"`) that survive compilation — see {@link compilesAway}. */
    valueImports: ReadonlySet<string>;
}

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
        sandboxTools,
        valueImports: new Set(
            [...imports, ...sourceFile.getExportDeclarations()].flatMap((declaration) => {
                const specifier = declaration.getModuleSpecifierValue();

                return specifier === undefined || compilesAway(declaration) ? [] : [specifier];
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

    for (const file of signals) {
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

    return { contextReads, dynamicImports, sandboxTools, valueImports };
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

export { capabilitiesUsedBy, contextPropertiesRead, discoverFeatureUsage, foldCapabilitySignals, mayReadCapabilityContext, sourceCapabilitySignals };
export type { FeatureUsage, SourceCapabilitySignals };
