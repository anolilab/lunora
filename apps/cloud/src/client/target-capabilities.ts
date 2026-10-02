import type { BindingType, TargetId } from "../provision-contract";
import { BINDING_SUPPORT, TARGET_IDS, TARGETS, unsupportedReason } from "../provision-contract";

/**
 * What a project's deploy target can and cannot give it, as the studio states it
 * (plan 458 W9). Every reason here comes from the same tables the deploy path
 * enforces — `BINDING_SUPPORT` / `UNSUPPORTED_REASONS` in the provision contract
 * and celld's own capability matrix in `@lunora/platform` — so the studio cannot
 * promise what a deploy would refuse. A target's name, description and
 * limitations are its descriptor's (`TARGETS`).
 */

/** The targets an owner can pick, in the order the selector lists them. */
export const TARGET_OPTIONS: ReadonlyArray<{ description: string; id: TargetId; label: string }> = TARGET_IDS.map((id) => {
    return { description: TARGETS[id].description, id, label: TARGETS[id].label };
});

/** A target's display name. */
export const targetLabel = (target: TargetId): string => TARGETS[target].label;

/** Human names for the binding types the contract rates. */
const BINDING_LABEL: Readonly<Record<BindingType, string>> = {
    ai: "Workers AI",
    analytics_engine: "Analytics Engine",
    artifacts: "Artifacts",
    assets: "Static assets",
    browser: "Browser Rendering",
    container: "Containers",
    d1: "D1",
    durable_object: "Durable Objects",
    hyperdrive: "Hyperdrive",
    images: "Images",
    kv: "KV",
    media: "Media Transformations",
    pipeline: "Pipelines",
    queue_consumer: "Queue consumers",
    queue_producer: "Queues",
    r2: "R2",
    stream: "Stream",
    vectorize: "Vectorize",
    vpc_network: "VPC networks",
    vpc_service: "VPC services",
    workflow: "Workflows",
};

/**
 * The bindings graph is drawn from a deployment's stored bindings, whose `type`
 * is the wrangler kind (`analytics`, `queue`, …) rather than the contract's
 * binding type. The kinds that differ map here; the rest are the same word.
 */
const GRAPH_KIND_TO_TYPE: Readonly<Record<string, BindingType>> = { analytics: "analytics_engine", queue: "queue_producer" };

const isBindingType = (target: TargetId, value: string): value is BindingType => Object.hasOwn(BINDING_SUPPORT[target], value);

/**
 * Why `target` refuses a binding of graph kind `kind`, or `undefined` when it
 * provides it (or the kind is one the contract does not rate, such as `var`).
 */
export const bindingRefusal = (target: TargetId, kind: string): string | undefined => {
    const type = GRAPH_KIND_TO_TYPE[kind] ?? kind;

    if (!isBindingType(target, type) || BINDING_SUPPORT[target][type] !== "unsupported") {
        return undefined;
    }

    return unsupportedReason(target, type);
};

/** Every binding type `target` refuses, with its reason, alphabetical by name. */
export const refusedBindings = (target: TargetId): { label: string; reason: string; type: BindingType }[] =>
    (Object.keys(BINDING_SUPPORT[target]) as BindingType[])
        .flatMap((type) => {
            const reason = bindingRefusal(target, type);

            return reason === undefined ? [] : [{ label: BINDING_LABEL[type], reason, type }];
        })
        .toSorted((a, b) => a.label.localeCompare(b.label, "en"));

/**
 * Properties of running on your own server that are not bugs, and that an
 * operator should know before choosing it (plan 458 §8, D10).
 */
export const OWN_SERVER_PROPERTIES: ReadonlyArray<string> = [
    "Secrets are delivered as celld vars and persist in your bucket: anyone with read access to that bucket can read them.",
    "A box is a single machine. Upgrades cost a few seconds of downtime, and there is no failover to a second node.",
];
