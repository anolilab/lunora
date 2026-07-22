/**
 * Deploy manifest extraction (CLOUD-PLAN.md §2.1 / §2.4). A Lunora tenant's
 * `wrangler.jsonc` is the source of truth for what the control plane must
 * provision (Durable Object classes, a per-tenant D1 / R2) and fan out (the
 * tenant's cron expressions — WfP drops `triggers.crons` for namespaced
 * workers, so the control plane ticks them itself). The CLI/deploy client reads
 * the app's wrangler config, runs it through this pure parser, and sends the
 * result on the deploy request — so a real deploy carries the bindings the
 * uploaded Worker needs and the crons the fan-out must drive.
 */

import type { TenantBindingSpec } from "../provision";

export interface DeployManifest {
    /** The binding manifest the deploy request carries (the canonical provisioner shape). */
    bindings: TenantBindingSpec;
    /** The tenant's compiled cron expressions (wrangler `triggers.crons`). */
    cronSpecs: string[];
}

/** The subset of a parsed `wrangler.jsonc` this reads — everything optional/defensive. */
export interface WranglerConfig {
    d1_databases?: { binding?: unknown }[];
    durable_objects?: { bindings?: { class_name?: unknown; name?: unknown }[] };
    r2_buckets?: { binding?: unknown }[];
    triggers?: { crons?: unknown[] };
}

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/**
 * Extract the deploy manifest from a parsed `wrangler.jsonc`. Reads the DO
 * class bindings, the first D1 / R2 binding (a tenant provisions one of each),
 * and the cron expressions. Defensive: malformed entries are dropped, so a
 * hand-edited wrangler can't produce a malformed request. The server still
 * floors bindings to ShardDO, so an empty/partial manifest is safe.
 */
export const parseWranglerManifest = (wrangler: WranglerConfig): DeployManifest => {
    const durableObjects = (wrangler.durable_objects?.bindings ?? [])
        .map((entry) => ({ binding: asString(entry.name), className: asString(entry.class_name) }))
        .filter((entry): entry is { binding: string; className: string } => entry.binding !== undefined && entry.className !== undefined);

    const d1Binding = asString(wrangler.d1_databases?.[0]?.binding);
    const r2Binding = asString(wrangler.r2_buckets?.[0]?.binding);

    const cronSpecs = (wrangler.triggers?.crons ?? []).map(asString).filter((cron): cron is string => cron !== undefined);

    return {
        bindings: {
            ...(d1Binding ? { d1: { binding: d1Binding } } : {}),
            ...(r2Binding ? { r2: { binding: r2Binding } } : {}),
            ...(durableObjects.length > 0 ? { durableObjects } : {}),
        },
        cronSpecs,
    };
};
