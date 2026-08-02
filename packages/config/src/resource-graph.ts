/**
 * Project the app's inferred requirements onto the provider-neutral
 * {@link ResourceGraph}.
 *
 * Lives here rather than beside the Cloudflare driver because the projection is
 * host-neutral in fact as well as in name: it reads `InferredBindings` — which
 * is derived from the app's schema and imports, not from any host's config —
 * and answers "what does this app need?" identically for every target. It sat
 * in `cloudflare/` only because Cloudflare was the only driver, and the second
 * driver would otherwise have had to copy it.
 */

import type { NamedResource, ResourceGraph, ShardNamespaceResource } from "./deploy-driver";
import type { InferredBindings } from "./infer-bindings";

/**
 * Project `InferredBindings` onto the neutral {@link ResourceGraph}.
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

export default toResourceGraph;
