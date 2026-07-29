import type { StudioFeaturesResult } from "@lunora/shard-engine";
import type { Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CapabilityKey } from "./capabilities";
import { CAPABILITIES } from "./capabilities";
import { listLunoraSourceFiles } from "./discover-functions";
import type { TableIR } from "./ir";

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
 * {@link buildStudioFeatures}. `mail` is import-only — it has no `ctx.mail`
 * helper (mail is reached through its own client), so only a `@lunora/mail`
 * import flips it here; a worker-entry wiring outside `lunora/` is caught
 * instead by the package-dependency signal in {@link buildStudioFeatures}.
 */
type FeatureUsage = Record<CapabilityKey, boolean>;

/**
 * The extra schema-/project-level signals OR'd onto the code-usage flags to
 * decide which studio nav pages to show. These cover the wiring paths the
 * `lunora/`-scoped code scan structurally can't see: a `v.storage()` column with
 * no `ctx.storage` call, a cron with no `@lunora/scheduler` import, a vector
 * index, and — crucially for mail — a package wired only in the worker entry
 * (`src/server`), detected via the project's declared dependencies.
 */
interface StudioFeatureSignals {
    /** Number of declared containers — any `defineContainer` means the containers page is relevant. */
    containerCount: number;
    /** Number of declared cron jobs — any cron means the scheduler page is relevant. */
    cronCount: number;
    /** The `@lunora/*` packages this app depends on (from its `package.json`). */
    dependencies: ReadonlySet<string>;

    /**
     * The app declares the `@lunora/payment` store's `subscriptions` **and** `events` tables — the
     * two the Payments panel reads — identified by their *signature columns*, not merely their
     * (generic) names (see {@link hasPaymentStoreTables}). Unlike every other feature, payments has
     * no fail-open dependency arm: the panel queries these tables directly, so merely depending on
     * `@lunora/payment` (e.g. to reuse its pure webhook-verification / idempotency-key helpers)
     * without hand-declaring the store's tables would show a page that errors with `unknown table:
     * subscriptions`. Gating on the tables' presence makes the page appear exactly when it can
     * actually render — and gating on their *shape* keeps an unrelated newsletter `subscriptions`
     * or domain `events` table from spuriously flipping it on.
     */
    hasPaymentTables: boolean;
    /** Number of declared queues — any `defineQueue` means the queues page is relevant. */
    queueCount: number;
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
 * `payments`) and — via {@link buildStudioFeatures} — the studio nav.
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

/**
 * Signature columns that identify the `@lunora/payment` store's two panel-read
 * tables by their *shape*, not their (generic) names. An app declares these
 * tables inline in its `lunora/schema.ts` (codegen can't resolve `@lunora/payment`'s
 * cross-package `...paymentTables` spread), mirroring the canonical columns the
 * store reads/writes — so any real payment store carries these columns, while an
 * unrelated newsletter `subscriptions` table or a domain `events` table does not.
 *
 * `providerSubscriptionId` + `state` are the subscription store's discriminators;
 * `providerEventId` + `processedAt` are the webhook-log's. This is the "real
 * payment signal" the panel gates on — the old bare-name probe (`subscriptions`
 * AND `events` present) false-positived on those generic names.
 */
const PAYMENT_SUBSCRIPTION_COLUMNS = ["providerSubscriptionId", "state"] as const;
const PAYMENT_EVENTS_COLUMNS = ["providerEventId", "processedAt"] as const;

const tableHasColumns = (table: TableIR, columns: ReadonlyArray<string>): boolean => columns.every((column) => column in table.shape);

/**
 * `true` when the schema declares the `@lunora/payment` store's `subscriptions`
 * and `events` tables — matched by their {@link PAYMENT_SUBSCRIPTION_COLUMNS} /
 * {@link PAYMENT_EVENTS_COLUMNS} signature columns rather than their names alone,
 * so it fires on a genuine payment store (which mirrors the canonical columns —
 * back-compatible with older schemas) and not on a coincidentally-named table.
 */
const hasPaymentStoreTables = (tables: ReadonlyArray<TableIR>): boolean => {
    const subscriptions = tables.find((table) => table.name === "subscriptions");
    const events = tables.find((table) => table.name === "events");

    return (
        subscriptions !== undefined &&
        events !== undefined &&
        tableHasColumns(subscriptions, PAYMENT_SUBSCRIPTION_COLUMNS) &&
        tableHasColumns(events, PAYMENT_EVENTS_COLUMNS)
    );
};

/**
 * Combine the code-usage flags with the schema/project signals into the final
 * per-feature visibility the studio gates its nav on. A page shows when ANY
 * signal fires — usage is OR'd with the relevant schema count and with the
 * `@lunora/*` package being a declared dependency. The dependency arm is what
 * makes the gating fail *open*: it cannot hide a page for an app that pulls the
 * package in, even when the usage scan (scoped to `lunora/`) can't see the
 * wiring — the failure the studio must never make is hiding a working page.
 *
 * `payments` is the lone exception: it has no dependency arm. Its panel reads the
 * `subscriptions`/`events` tables directly, which the app must hand-declare in its
 * schema (codegen can't resolve `@lunora/payment`'s cross-package table spread), so
 * a dependency-only signal would fail *open into an error* rather than an empty
 * page. It gates on {@link StudioFeatureSignals.hasPaymentTables} — the store tables'
 * actual presence, matched by their signature columns ({@link hasPaymentStoreTables})
 * — instead, so the page shows exactly when it can render.
 */
const buildStudioFeatures = (usage: FeatureUsage, signals: StudioFeatureSignals): StudioFeaturesResult => {
    return {
        analytics: usage.analytics || signals.dependencies.has("@lunora/bindings/analytics"),
        auth: signals.dependencies.has("@lunora/auth"),
        containers: usage.container || signals.containerCount > 0 || signals.dependencies.has("@lunora/container"),
        flags: usage.flags || signals.dependencies.has("@lunora/flags"),
        kv: usage.kv || signals.dependencies.has("@lunora/bindings/kv"),
        mail: usage.mail || signals.dependencies.has("@lunora/mail"),
        notifications: usage.notify || signals.dependencies.has("@lunora/notify"),
        payments: usage.payments || signals.hasPaymentTables,
        queues: signals.queueCount > 0 || signals.dependencies.has("@lunora/queue"),
        scheduler: usage.scheduler || signals.cronCount > 0 || signals.dependencies.has("@lunora/scheduler"),
        storage: usage.storage || signals.storageRuleCount > 0 || signals.storageColumnCount > 0 || signals.dependencies.has("@lunora/storage"),
        vectors: usage.vectors || signals.vectorIndexCount > 0 || signals.dependencies.has("@lunora/bindings/vectors"),
        workflows: usage.workflows || signals.workflowCount > 0 || signals.dependencies.has("@lunora/workflow"),
    };
};

export { buildStudioFeatures, discoverFeatureUsage, hasPaymentStoreTables };
export type { FeatureUsage, StudioFeatureSignals };
