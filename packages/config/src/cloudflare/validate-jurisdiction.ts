/**
 * Data-residency checks for a schema pinned with `.jurisdiction("…")`.
 *
 * The schema's jurisdiction pins the app's Durable Objects only. KV namespaces
 * and R2 buckets carry a jurisdiction of their own, fixed when the resource is
 * created, so a pinned app can still keep data outside the region it promises.
 * Every finding is a warning, not an error: the data in a given namespace or
 * bucket may legitimately be non-personal, and only the app owner knows that.
 */
import type { SchemaInfo } from "../schema-info";
import type { WranglerConfig } from "./wrangler-config";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The array's object entries with their ORIGINAL index, so a warning names the
 * same `key[i]` the shape validators report for that entry.
 */
const indexedEntries = (value: unknown): [number, Record<string, unknown>][] =>
    Array.isArray(value) ? (value as unknown[]).flatMap((entry, index) => (isRecord(entry) ? [[index, entry] as [number, Record<string, unknown>]] : [])) : [];

const bindingName = (entry: Record<string, unknown>): string => (typeof entry["binding"] === "string" ? entry["binding"] : "");

/**
 * A KV namespace's jurisdiction is invisible in the binding (an `id` only) and
 * cannot be changed after creation, so the one actionable moment is before the
 * namespace exists: an entry without an `id` is told to create it inside the
 * jurisdiction. One that already has an `id` cannot be checked statically.
 */
const validateKvJurisdiction = (wrangler: WranglerConfig, jurisdiction: string, warnings: string[]): void => {
    for (const [index, entry] of indexedEntries(wrangler.kv_namespaces)) {
        if (typeof entry["id"] === "string" && entry["id"] !== "") {
            continue;
        }

        warnings.push(
            `kv_namespaces[${String(index)}] ("${bindingName(entry)}") is not created yet and the schema pins data to "${jurisdiction}" — create it with \`wrangler kv namespace create <name> --jurisdiction=${jurisdiction}\`; a namespace's jurisdiction cannot be changed afterwards`,
        );
    }
};

/**
 * An R2 binding has to name the bucket's jurisdiction (`r2_buckets[].jurisdiction`)
 * to reach a bucket created inside one, so a missing or different value is
 * checkable: it means the bucket's data sits outside the schema's residency.
 */
const validateR2Jurisdiction = (wrangler: WranglerConfig, jurisdiction: string, warnings: string[]): void => {
    for (const [index, entry] of indexedEntries(wrangler.r2_buckets)) {
        const declared = entry["jurisdiction"];

        if (declared === jurisdiction) {
            continue;
        }

        const current = typeof declared === "string" ? `names the "${declared}" jurisdiction` : "names no jurisdiction";

        warnings.push(
            `r2_buckets[${String(index)}] ("${bindingName(entry)}") ${current}, but the schema pins data to "${jurisdiction}" — create the bucket with \`wrangler r2 bucket create <name> --jurisdiction=${jurisdiction}\` and set "jurisdiction": "${jurisdiction}" on the binding`,
        );
    }
};

/** Warn about KV namespaces and R2 buckets that fall outside the schema's jurisdiction. */
const validateJurisdiction = (wrangler: WranglerConfig, schema: SchemaInfo | undefined, warnings: string[]): void => {
    const jurisdiction = schema?.jurisdiction;

    if (jurisdiction === undefined) {
        return;
    }

    validateKvJurisdiction(wrangler, jurisdiction, warnings);
    validateR2Jurisdiction(wrangler, jurisdiction, warnings);
};

export default validateJurisdiction;
