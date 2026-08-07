/**
 * The Node {@link DeployDriver} — the second target, and the one that proves
 * the seam is a seam.
 *
 * `infer` is shared with Cloudflare verbatim (`toResourceGraph`), which is the
 * point: deciding that an app needs a shard namespace, a queue and a bucket
 * falls out of the app's own code and reaches the same answer on every host.
 * What differs is `provision`, and here it differs about as far as it can —
 * Cloudflare writes `wrangler.jsonc`, and Node has no configuration file at
 * all. A `@lunora/platform-node` process reads its shard directory from the
 * options it is constructed with, so there is nothing to reconcile.
 *
 * That makes `provision` a *reporting* step rather than a writing one, and the
 * report is the valuable part: an app that declares a container gets told, once,
 * at provision time, that this target cannot serve it — instead of discovering
 * it when `ctx.containers` is undefined at runtime. Workflows, object storage
 * and queues are emulated on this target (`createNodeWorkflowHost` /
 * `createNodeR2Bucket` / `createNodeQueueHost` in `@lunora/platform-node`), so
 * they are not warned about here.
 *
 * The warnings mirror `NODE_CAPABILITIES` in `@lunora/platform`; that matrix is
 * what codegen gates on, and this is what the operator reads. Keeping the two in
 * step is the point — a warning left behind after its capability was implemented
 * tells an operator a feature is unavailable while codegen emits its surface.
 *
 * `toolchain` is deliberately **absent**. `DriverToolchain` describes a vendor
 * CLI to shell out to — `wrangler deploy`, `wrangler tail`, `wrangler secret
 * put` — and Node has none: there is no hosted control plane to deploy to, no
 * remote log stream to tail, and no remote secret store to write. The interface
 * already models this ("or `undefined` for a host that has none"), and claiming
 * a toolchain here would mean inventing commands that cannot run.
 */

import type { DeployDriver, DriverContext, ProvisionResult, ResourceGraph } from "../deploy-driver";
import { inferLunoraBindings } from "../infer-bindings";
import toResourceGraph from "../resource-graph";

/**
 * Requirements this target cannot serve, and the warning each earns.
 *
 * Keyed by the `ResourceGraph` predicate that detects it, so adding a resource
 * to the graph without deciding whether Node supports it is a type error rather
 * than a silent omission.
 */
const UNSUPPORTED: ReadonlyArray<{ detect: (graph: ResourceGraph) => boolean; warning: string }> = [
    {
        detect: (graph) => graph.containers.length > 0,
        warning: "containers have no Node equivalent in @lunora/platform-node — ctx.containers will be unavailable",
    },
];

const NODE_DRIVER: DeployDriver = {
    id: "node",

    infer: async (context: DriverContext) => toResourceGraph(await inferLunoraBindings({ projectRoot: context.projectRoot }), context.crons ?? []),

    name: "Node",

    provision: async (context: DriverContext): Promise<ProvisionResult> => {
        // Folded into a warning rather than thrown: `provision` is documented as
        // reporting what it could not do, and a project whose inference fails
        // should still be told the rest.
        let graph: ResourceGraph;

        try {
            graph = toResourceGraph(await inferLunoraBindings({ projectRoot: context.projectRoot }), context.crons ?? []);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            return { added: [], changed: false, warnings: [`requirement inference skipped: ${message}`] };
        }

        const warnings = UNSUPPORTED.filter((entry) => entry.detect(graph)).map((entry) => entry.warning);

        if (graph.crons.length > 0) {
            // Not a gap — a difference worth stating, because it is the one
            // place Node does *more*: Cloudflare reconciles `triggers.crons`
            // into `wrangler.jsonc` at build time, while this target registers
            // them at runtime through `SchedulerHost.cron`.
            warnings.push(
                `${String(graph.crons.length)} cron expression(s) will be registered at runtime via SchedulerHost.cron rather than written to a config file`,
            );
        }

        // Always `changed: false`, always empty `added`: there is no
        // configuration file for this target, so provisioning is idempotent by
        // construction rather than by careful diffing.
        return { added: [], changed: false, warnings };
    },
};

export default NODE_DRIVER;
