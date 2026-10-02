import type { BindingType, TargetId } from "../provision-contract";
import { BINDING_SUPPORT, UNSUPPORTED_REASONS } from "../provision-contract";

/**
 * What a project's deploy target can and cannot give it, as the studio states it
 * (plan 458 W9). Every reason here comes from the same tables the deploy path
 * enforces — `BINDING_SUPPORT` / `UNSUPPORTED_REASONS` in the provision contract
 * and celld's own capability matrix in `@lunora/platform` — so the studio cannot
 * promise what a deploy would refuse. The one note quoted from that matrix is
 * copied rather than imported (the package is a build-time dependency of this
 * app, not a runtime one); `__tests__/target-capabilities.test.ts` pins the copy
 * to the source.
 */

/** The targets an owner can pick, in the order the selector lists them. */
export const TARGET_OPTIONS: ReadonlyArray<{ description: string; id: TargetId; label: string }> = [
    {
        description: "Runs on Cloudflare's network, managed end to end by Lunora Cloud.",
        id: "cloudflare-wfp",
        label: "Lunora Cloud (Cloudflare)",
    },
    {
        description: "Runs on celld on a Linux server your organization enrolled. Its data stays in your own bucket.",
        id: "celld-vps",
        label: "Your own server",
    },
];

/** A target's display name. */
export const targetLabel = (target: TargetId): string => TARGET_OPTIONS.find((option) => option.id === target)?.label ?? target;

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

    return (UNSUPPORTED_REASONS[target] as Readonly<Partial<Record<BindingType, string>>>)[type];
};

/** Every binding type `target` refuses, with its reason, alphabetical by name. */
export const refusedBindings = (target: TargetId): { label: string; reason: string; type: BindingType }[] =>
    (Object.keys(BINDING_SUPPORT[target]) as BindingType[])
        .flatMap((type) => {
            const reason = bindingRefusal(target, type);

            return reason === undefined ? [] : [{ label: BINDING_LABEL[type], reason, type }];
        })
        .toSorted((a, b) => a.label.localeCompare(b.label, "en"));

/** A capability the target lacks as a whole (not a binding), with the reason the studio shows. */
export interface TargetLimitation {
    id: "pitr" | "runtimeLimits";
    label: string;
    reason: string;
}

/** celld's `pointInTimeRecovery` capability note, verbatim. */
export const CELLD_PITR_NOTE =
    "celld's Durable Object storage has no bookmark API (`getBookmarkForTime` / `onNextSessionRestoreBookmark`), so getPitrBookmark / pitrRestore answer PITR_UNAVAILABLE. The fleet bucket's epoch-fenced replication is for durability and takeover, not an addressable history; `lunora backup` (objectStorageBackups) is the recovery tier here";

/**
 * What a `celld-vps` project does not get beyond its bindings: no per-plan
 * runtime limits (the dispatcher applies those, and there is no dispatcher in
 * front of a box) and no point-in-time recovery. Empty for `cloudflare-wfp`.
 */
export const targetLimitations = (target: TargetId): TargetLimitation[] =>
    target === "celld-vps"
        ? [
              {
                  id: "runtimeLimits",
                  label: "Per-plan runtime limits",
                  reason: "The CPU-time and subrequest caps your plan sets are applied by Lunora Cloud's dispatcher, which does not sit in front of your server. A request there is bounded by the machine's memory and celld's 128 MB isolate heap instead.",
              },
              { id: "pitr", label: "Point-in-time recovery", reason: CELLD_PITR_NOTE },
          ]
        : [];

/**
 * Properties of running on your own server that are not bugs, and that an
 * operator should know before choosing it (plan 458 §8, D10).
 */
export const OWN_SERVER_PROPERTIES: ReadonlyArray<string> = [
    "Secrets are delivered as celld vars and persist in your bucket: anyone with read access to that bucket can read them.",
    "A box is a single machine. Upgrades cost a few seconds of downtime, and there is no failover to a second node.",
];
