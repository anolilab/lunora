import type { Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CapabilityKey } from "../capabilities";
import { CAPABILITIES } from "../capabilities";
import { listLunoraSourceFiles } from "./ast";

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
            const name = element.getPropertyNameNode()?.getText() ?? element.getName();

            if (name) {
                names.add(name);
            }
        }
    };

    // Anchor on the `ctx` PROPERTY of a binding pattern, wherever it appears —
    // a handler parameter or a `const { ctx } = …`. A rename introduces another
    // context name to follow; a nested pattern is the read itself.
    for (const element of sourceFile.getDescendantsOfKind(SyntaxKind.BindingElement)) {
        if ((element.getPropertyNameNode()?.getText() ?? element.getName()) !== CONTEXT_PROPERTY) {
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
 * Detect code-usage of every package-backed feature across the function files
 * under `lunora/`, in a single pass. The result feeds both worker gating (`ai` /
 * `payments`) and — via `buildStudioFeatures` — the studio nav.
 */
const discoverFeatureUsage = (project: Project, lunoraDirectory: string): FeatureUsage => {
    // Typed as `FeatureUsage` (`Record<CapabilityKey, boolean>`) up front, so every
    // `usage[capability.key]` read/write below is key-checked and the function
    // returns with no boundary cast. The single assertion is the unavoidable
    // `Object.fromEntries` widening (it always yields `{ [k: string]: T }`); the
    // keys provably come from `CAPABILITIES`, whose `key` is a `CapabilityKey`.
    const usage = Object.fromEntries(CAPABILITIES.map((capability) => [capability.key, false] as const)) as FeatureUsage;

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const importSpecifiers = new Set(sourceFile.getImportDeclarations().map((declaration) => declaration.getModuleSpecifierValue()));
        const contextProperties = contextPropertiesRead(sourceFile);

        for (const capability of CAPABILITIES) {
            if (usage[capability.key]) {
                continue;
            }

            if (importSpecifiers.has(capability.moduleSpecifier)) {
                usage[capability.key] = true;

                continue;
            }

            if (capability.contextProperty !== undefined && contextProperties.has(capability.contextProperty)) {
                usage[capability.key] = true;
            }
        }

        if (CAPABILITIES.every((capability) => usage[capability.key])) {
            break;
        }
    }

    return usage;
};

export { contextPropertiesRead, discoverFeatureUsage };
export type { FeatureUsage };
