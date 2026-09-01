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

/**
 * The set of `ctx` helper names the source reaches — either a direct
 * `ctx.PROPERTY` access, or a destructuring of the property off the `ctx`
 * identifier (a `const ... = ctx` binding pattern). Parameter-position
 * destructuring (a destructured handler parameter) is still not matched (there is
 * no `ctx` identifier to anchor on, and matching a bare destructured param would
 * false-positive on unrelated functions) — but the import probe and, for studio
 * nav, the package-dependency signal cover that case.
 *
 * Collected in a single per-file pass (two descendant walks total) instead of the
 * former per-feature double-walk: each context-bearing {@link CAPABILITIES} entry
 * then just tests membership in this set, so detection is O(files × nodes) rather
 * than O(files × features × nodes).
 */
const contextPropertiesRead = (sourceFile: SourceFile): Set<string> => {
    const reachesContext = (receiver: Node): boolean => Node.isIdentifier(receiver) && receiver.getText() === "ctx";
    const names = new Set<string>();

    for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (reachesContext(access.getExpression())) {
            names.add(access.getName());
        }
    }

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const initializer = declaration.getInitializer();
        const nameNode = declaration.getNameNode();

        if (initializer === undefined || !reachesContext(initializer) || !Node.isObjectBindingPattern(nameNode)) {
            continue;
        }

        for (const element of nameNode.getElements()) {
            const name = element.getPropertyNameNode()?.getText() ?? element.getName();

            if (name) {
                names.add(name);
            }
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
