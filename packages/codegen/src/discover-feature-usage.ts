import type { StudioFeaturesResult } from "@cirrus/do";
import type { Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listCirrusSourceFiles } from "./discover-functions";

/**
 * Code-usage signals for every optional, package-backed feature, in a single
 * pass over the `cirrus/` source set. Each flag is `true` when a source imports
 * the feature's `@cirrus/*` package or reads its generated `ctx.*` helper. This
 * is the one detection path for all of them — it subsumes the old standalone
 * `discoverAiUsage` / `discoverPaymentUsage` probes (which were line-for-line
 * copies of this same import-or-`ctx.X` check).
 *
 * `ai` and `payments` gate whether codegen wires the SDK into the generated
 * worker (so a non-AI app never imports `@cirrus/ai`); the rest additionally
 * feed the studio's nav gating via {@link buildStudioFeatures}. `mail` is
 * import-only — it has no `ctx.mail` helper (mail is reached through its own
 * client), so only a `@cirrus/mail` import flips it here; a worker-entry wiring
 * outside `cirrus/` is caught instead by the package-dependency signal in
 * {@link buildStudioFeatures}.
 */
interface FeatureUsage {
    /** A `cirrus/` source imports `@cirrus/ai` or reads `ctx.ai`. */
    ai: boolean;
    /** A `cirrus/` source imports `@cirrus/mail`. */
    mail: boolean;
    /** A `cirrus/` source imports `@cirrus/payment` or reads `ctx.payments`. */
    payments: boolean;
    /** A source imports `@cirrus/scheduler` or reads `ctx.scheduler`. */
    scheduler: boolean;
    /** A source imports `@cirrus/storage` or reads `ctx.storage`. */
    storage: boolean;
    /** A source imports `@cirrus/vectors` or reads `ctx.vectors`. */
    vectors: boolean;
    /** A source imports `@cirrus/workflow` or reads `ctx.workflows`. */
    workflows: boolean;
}

/** One feature's code-usage probe: its `@cirrus/*` package and optional `ctx.*` helper name. */
interface FeatureProbe {
    /** Generated context helper read (e.g. `ctx.scheduler`); absent when the feature has no context surface (mail). */
    contextProperty?: string;
    /** The `@cirrus/*` package whose import flips the flag. */
    moduleSpecifier: string;
}

const PROBES: Record<keyof FeatureUsage, FeatureProbe> = {
    ai: { contextProperty: "ai", moduleSpecifier: "@cirrus/ai" },
    mail: { moduleSpecifier: "@cirrus/mail" },
    payments: { contextProperty: "payments", moduleSpecifier: "@cirrus/payment" },
    scheduler: { contextProperty: "scheduler", moduleSpecifier: "@cirrus/scheduler" },
    storage: { contextProperty: "storage", moduleSpecifier: "@cirrus/storage" },
    vectors: { contextProperty: "vectors", moduleSpecifier: "@cirrus/vectors" },
    workflows: { contextProperty: "workflows", moduleSpecifier: "@cirrus/workflow" },
};

/**
 * The extra schema-/project-level signals OR'd onto the code-usage flags to
 * decide which studio nav pages to show. These cover the wiring paths the
 * `cirrus/`-scoped code scan structurally can't see: a `v.storage()` column with
 * no `ctx.storage` call, a cron with no `@cirrus/scheduler` import, a vector
 * index, and — crucially for mail — a package wired only in the worker entry
 * (`src/server`), detected via the project's declared dependencies.
 */
interface StudioFeatureSignals {
    /** Number of declared cron jobs — any cron means the scheduler page is relevant. */
    cronCount: number;
    /** The `@cirrus/*` packages this app depends on (from its `package.json`). */
    dependencies: ReadonlySet<string>;
    /** Number of tables carrying a scalar `v.storage()` column — drives the file browser even with no `ctx.storage` use. */
    storageColumnCount: number;
    /** Number of declared storage access rules. */
    storageRuleCount: number;
    /** Number of declared vector indexes. */
    vectorIndexCount: number;
    /** Number of declared workflows — any `defineWorkflow` means the workflows page is relevant. */
    workflowCount: number;
}

/**
 * True when the source reaches the given `ctx` helper — either a direct
 * `ctx.PROPERTY` access, or a destructuring of the property off the `ctx`
 * identifier (a `const ... = ctx` binding pattern). Parameter-position
 * destructuring (a destructured handler parameter) is still not matched (there is
 * no `ctx` identifier to anchor on, and matching a bare destructured param would
 * false-positive on unrelated functions) — but the import probe and, for studio
 * nav, the package-dependency signal cover that case.
 */
const readsContextProperty = (sourceFile: SourceFile, property: string): boolean => {
    const reachesContext = (receiver: Node): boolean => Node.isIdentifier(receiver) && receiver.getText() === "ctx";

    const directAccess = sourceFile
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .some((access) => access.getName() === property && reachesContext(access.getExpression()));

    if (directAccess) {
        return true;
    }

    return sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).some((declaration) => {
        const initializer = declaration.getInitializer();
        const nameNode = declaration.getNameNode();

        if (initializer === undefined || !reachesContext(initializer) || !Node.isObjectBindingPattern(nameNode)) {
            return false;
        }

        return nameNode.getElements().some((element) => element.getPropertyNameNode()?.getText() === property || element.getName() === property);
    });
};

/**
 * Detect code-usage of every package-backed feature across the function files
 * under `cirrus/`, in a single pass. The result feeds both worker gating (`ai` /
 * `payments`) and — via {@link buildStudioFeatures} — the studio nav.
 */
const discoverFeatureUsage = (project: Project, cirrusDirectory: string): FeatureUsage => {
    const usage: FeatureUsage = { ai: false, mail: false, payments: false, scheduler: false, storage: false, vectors: false, workflows: false };
    const keys = Object.keys(PROBES) as (keyof FeatureUsage)[];

    for (const filePath of listCirrusSourceFiles(cirrusDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const importSpecifiers = new Set(sourceFile.getImportDeclarations().map((declaration) => declaration.getModuleSpecifierValue()));

        for (const key of keys) {
            if (usage[key]) {
                continue;
            }

            const probe = PROBES[key];

            if (importSpecifiers.has(probe.moduleSpecifier)) {
                usage[key] = true;

                continue;
            }

            if (probe.contextProperty !== undefined && readsContextProperty(sourceFile, probe.contextProperty)) {
                usage[key] = true;
            }
        }

        if (keys.every((key) => usage[key])) {
            break;
        }
    }

    return usage;
};

/**
 * Combine the code-usage flags with the schema/project signals into the final
 * per-feature visibility the studio gates its nav on. A page shows when ANY
 * signal fires — usage is OR'd with the relevant schema count and with the
 * `@cirrus/*` package being a declared dependency. The dependency arm is what
 * makes the gating fail *open*: it cannot hide a page for an app that pulls the
 * package in, even when the usage scan (scoped to `cirrus/`) can't see the
 * wiring — the failure the studio must never make is hiding a working page.
 */
const buildStudioFeatures = (usage: FeatureUsage, signals: StudioFeatureSignals): StudioFeaturesResult => {
    return {
        mail: usage.mail || signals.dependencies.has("@cirrus/mail"),
        payments: usage.payments || signals.dependencies.has("@cirrus/payment"),
        scheduler: usage.scheduler || signals.cronCount > 0 || signals.dependencies.has("@cirrus/scheduler"),
        storage: usage.storage || signals.storageRuleCount > 0 || signals.storageColumnCount > 0 || signals.dependencies.has("@cirrus/storage"),
        vectors: usage.vectors || signals.vectorIndexCount > 0 || signals.dependencies.has("@cirrus/vectors"),
        workflows: usage.workflows || signals.workflowCount > 0 || signals.dependencies.has("@cirrus/workflow"),
    };
};

export { buildStudioFeatures, discoverFeatureUsage };
export type { FeatureUsage, StudioFeatureSignals };
