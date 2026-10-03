import type { BindingType, TargetId } from "../provision-contract";
import { BINDING_SUPPORT, isTargetId, TARGET_IDS, TARGETS, unsupportedReason } from "../provision-contract";
import type { PlacedOn } from "../targets/placement";

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
    ai_search: "AI Search",
    ai_search_namespace: "AI Search namespaces",
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
    service: "Service bindings",
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
 * What an operator should know about a target before choosing it that is not a
 * bug and not a refused binding (plan 458 §8, D10; MULTIPLATFORM.md Phase 3).
 */
export const TARGET_PROPERTIES: Readonly<Partial<Record<TargetId, ReadonlyArray<string>>>> = {
    "celld-vps": [
        "Secrets are delivered as celld vars and persist in your bucket: anyone with read access to that bucket can read them.",
        "A box is a single machine. Upgrades cost a few seconds of downtime, and there is no failover to a second node.",
    ],
    "cloudflare-workers": [
        "Requests, storage and Durable Objects run on your Cloudflare account and appear on your Cloudflare bill. The Usage tab shows the requests, and Lunora Cloud never bills for them.",
        "The project's Alchemy convergence state stays with Lunora Cloud, not in your account, so nothing you change there can corrupt it — but resources you edit by hand may be converged back on the next deploy.",
        "Disconnecting the account is refused while a project deploys into it; after disconnecting, revoke the token in your Cloudflare dashboard.",
    ],
};

/** How the capabilities card introduces a target's refusals. */
export const TARGET_CAPABILITIES_INTRO: Readonly<Partial<Record<TargetId, string>>> = {
    "celld-vps": "This project runs on celld on your own box.",
    "cloudflare-workers": "This project runs as a plain Worker in your own Cloudflare account, outside Lunora Cloud's dispatcher.",
};

/** The names of the projects placed on each host (a box, a connected account), by the host's id — what the Boxes and Cloudflare accounts tabs list. */
export const projectNamesByHost = (projects: ReadonlyArray<{ name: string; placementRef?: string }> | undefined): Map<string, string[]> => {
    const byHost = new Map<string, string[]>();

    for (const project of projects ?? []) {
        if (project.placementRef !== undefined) {
            byHost.set(project.placementRef, [...(byHost.get(project.placementRef) ?? []), project.name]);
        }
    }

    return byHost;
};

/** The deploy-target form's draft: a target, and the host it names (`""` for none yet). */
export interface TargetDraft {
    placementRef: string;
    target: string;
}

/** What a drafted target places its project on, or `undefined` for a value no target answers to. */
const placedOnOfDraft = (target: string): PlacedOn | undefined => (isTargetId(target) ? TARGETS[target].placedOn : undefined);

/**
 * The draft after choosing `target`: its host is kept while the new target
 * names the same kind of host, comes back to the saved one when it names the
 * saved target's kind, and is cleared otherwise — a box id is never sent as an
 * account's, or the other way round.
 */
export const retargetDraft = (draft: TargetDraft, target: string, saved: TargetDraft): TargetDraft => {
    const placedOn = placedOnOfDraft(target);

    if (placedOn === placedOnOfDraft(draft.target)) {
        return { ...draft, target };
    }

    return { placementRef: placedOn === placedOnOfDraft(saved.target) ? saved.placementRef : "", target };
};

/**
 * What the deploy-target form may do with its draft: which kind of host it
 * names (`placedOn`, which picker to show), whether it differs from what is
 * saved, and whether it is complete enough to send (`projects.setTarget`
 * refuses a hosted target without its host).
 */
export const assessTargetDraft = (draft: TargetDraft, saved: TargetDraft): { changed: boolean; complete: boolean; placedOn: PlacedOn | undefined } => {
    const placedOn = placedOnOfDraft(draft.target);
    const namesHost = placedOn !== undefined && placedOn !== "cell";

    return {
        changed: draft.target !== saved.target || (namesHost && draft.placementRef !== saved.placementRef),
        complete: placedOn !== undefined && (!namesHost || draft.placementRef !== ""),
        placedOn,
    };
};
