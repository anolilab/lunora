/**
 * Reads every `queues.producers[]` entry out of `wrangler.jsonc` — the top level
 * and each `env.<name>` block — for codegen's push-consumer registry. An
 * environment usually renames its queues (`jobs-preview` for `jobs`) but keeps
 * the binding, so the producer binding is what ties a delivered `batch.queue`
 * back to its `defineQueue` export, exactly as `reconcileEnvQueues` matches an
 * env consumer.
 */
import type { WranglerQueueProducerIR } from "@lunora/codegen";

import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

/** The `queues` slice of one scope. Parsed from untrusted JSONC, so any level may be `null`. */
interface QueuesScope {
    queues?: { producers?: ReadonlyArray<{ binding?: unknown; queue?: unknown } | null> | null } | null;
}

interface WranglerQueuesShape extends QueuesScope {
    env?: Record<string, QueuesScope | null> | null;
}

/** Every well-formed producer in every scope; `[]` when there is no wrangler config or it does not parse. */
const collectWranglerQueueProducers = (projectRoot: string): WranglerQueueProducerIR[] => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (wranglerPath === undefined) {
        return [];
    }

    const { parsed } = readWranglerJsonc<WranglerQueuesShape>(wranglerPath);
    const scopes = [parsed?.queues, ...Object.values(parsed?.env ?? {}).map((block) => block?.queues)];

    return scopes.flatMap((queues) =>
        (queues?.producers ?? []).flatMap((entry) =>
            typeof entry?.binding === "string" && typeof entry.queue === "string" ? [{ binding: entry.binding, queue: entry.queue }] : [],
        ),
    );
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; the index re-exports it
export { collectWranglerQueueProducers };
