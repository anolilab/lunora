/**
 * The Cloudflare {@link DeployDriver} — the default target, and the reference
 * implementation of the seam.
 *
 * Deliberately thin. Every method delegates to the same `inferLunoraBindings` /
 * `reconcileWrangler*` functions the CLI called directly before the driver
 * existed, so routing a command through it is behavior-preserving by
 * construction rather than by careful re-implementation.
 *
 * The one piece of real work here is {@link toResourceGraph}: projecting the
 * Cloudflare-shaped `InferredBindings` down to the provider-neutral
 * {@link ResourceGraph}. That projection is lossy on purpose — it drops the
 * host encodings (binding names, DO class wiring, hint-only capabilities that
 * need un-mintable remote ids) and keeps only what a second target would also
 * need to know. `provision` therefore runs its own inference rather than
 * consuming the graph, because writing `wrangler.jsonc` needs exactly the
 * encodings the neutral graph discards — see the note on `DeployDriver`.
 */

import type { DeployDriver, DriverContext, NamedResource, ProvisionResult, ResourceGraph, ShardNamespaceResource } from "./deploy-driver";
import type { InferredBindings } from "./infer-bindings";
import { inferLunoraBindings } from "./infer-bindings";
import { reconcileWranglerBindings } from "./reconcile-bindings";
import { reconcileWranglerCompatibilityDate } from "./reconcile-compatibility-date";
import { reconcileWranglerCrons } from "./reconcile-crons";

/**
 * Project Cloudflare's `InferredBindings` onto the neutral {@link ResourceGraph}.
 *
 * Capabilities that are hint-only on Cloudflare (Hyperdrive, pipelines, and the
 * rest that need an un-mintable remote id) are intentionally absent: they are
 * not requirements a driver can provision, and modelling them neutrally would
 * imply a portability the graph cannot deliver.
 */
const toResourceGraph = (inferred: InferredBindings, crons: ReadonlyArray<string>): ResourceGraph => {
    const shardNamespaces: ShardNamespaceResource[] = inferred.durableObjects.map((durableObject) => {
        // A DO binding is only written for a class the worker entry exports, so
        // anything that reached this list is exported by construction.
        return { className: durableObject.className, exported: true, name: durableObject.binding };
    });

    const queues: NamedResource[] = inferred.queues.map((queue) => {
        return { name: queue.name };
    });
    const workflows: NamedResource[] = inferred.workflows.map((workflow) => {
        return { exported: workflow.exported, name: workflow.exportName };
    });
    const containers: NamedResource[] = inferred.containers.map((container) => {
        return { exported: container.exported, name: container.exportName };
    });

    return {
        containers,
        crons: [...crons],
        globalDatabase: inferred.needsD1,
        keyValueStore: inferred.usesKv,
        objectStorage: inferred.usesStorage,
        queues,
        shardNamespaces,
        signals: [...inferred.signals],
        workflows,
    };
};

/**
 * Reconcile one aspect of `wrangler.jsonc`, folding a thrown error into a
 * warning.
 *
 * Provisioning is best-effort by design: a failure to auto-write a binding must
 * not abort the command, because `validateWrangler` runs afterwards and is the
 * real gate on a genuinely-missing requirement. This mirrors the per-step
 * `try`/`catch` the CLI had inline before the driver existed.
 */
const reconcileStep = (label: string, step: () => { added?: string[]; changed: boolean; warnings?: string[]; wranglerPath?: string }): ProvisionResult => {
    try {
        const result = step();

        return {
            added: result.added ?? [],
            changed: result.changed,
            configPath: result.wranglerPath,
            warnings: result.warnings ?? [],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return { added: [], changed: false, warnings: [`${label} skipped: ${message}`] };
    }
};

/** The Cloudflare deploy driver. */
const CLOUDFLARE_DRIVER: DeployDriver = {
    id: "cloudflare",

    infer: async (context: DriverContext) => {
        const inferred = await inferLunoraBindings({ projectRoot: context.projectRoot });

        return toResourceGraph(inferred, context.crons ?? []);
    },

    name: "Cloudflare",

    provision: async (context: DriverContext) => {
        const cronTriggers = context.crons ?? [];

        // Bindings. Re-infers rather than reading the neutral graph: writing
        // wrangler bindings needs the Cloudflare encodings the graph drops.
        const bindings = await (async (): Promise<ProvisionResult> => {
            try {
                const inferred = await inferLunoraBindings({ projectRoot: context.projectRoot });

                return reconcileStep("binding inference", () => reconcileWranglerBindings(context.projectRoot, inferred));
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);

                return { added: [], changed: false, warnings: [`binding inference skipped: ${message}`] };
            }
        })();

        // Compatibility date — bumped to the release that enables Workers Cache.
        const compatibility = reconcileStep("compatibility date sync", () => reconcileWranglerCompatibilityDate(context.projectRoot));
        // Cron triggers, from the crons codegen discovered in the app's code.
        const crons = reconcileStep("cron trigger sync", () => reconcileWranglerCrons(context.projectRoot, cronTriggers));

        // `reconcileWranglerBindings` names each binding it wrote; the other two
        // steps report only whether they changed, so label them here.
        const steps: ReadonlyArray<ProvisionResult> = [
            bindings,
            { ...compatibility, added: compatibility.changed ? ["compatibility_date"] : [] },
            { ...crons, added: crons.changed ? [`${String(cronTriggers.length)} cron trigger(s)`] : [] },
        ];

        return {
            added: steps.flatMap((step) => step.added),
            changed: steps.some((step) => step.changed),
            // Every step resolves the same wrangler file; report the first found.
            configPath: steps.find((step) => step.configPath !== undefined)?.configPath,
            warnings: steps.flatMap((step) => step.warnings),
        };
    },
};

export default CLOUDFLARE_DRIVER;
