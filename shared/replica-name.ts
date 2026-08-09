/**
 * The owner↔replica DO-name contract for region-local read replicas, shared by
 * `@lunora/runtime` (which MINTS replica names when routing a read) and
 * `@lunora/do` (which PARSES its own name to learn its role). Kept here —
 * inlined into each consumer's bundle — so the two sides can never drift on the
 * format without creating a runtime dependency edge between the packages.
 *
 * Deliberately the same shape as `shared/relay-name.ts`: a DO's role is fixed
 * for its whole life by its name, which is the only role signal available
 * before any request arrives.
 *
 * Zero-dependency by design (see the repo's `shared/` rules): only relative /
 * builtin imports, named exports, no `.js` extensions.
 */

import type { RegionHint } from "./region-hint";
import { isRegionHint } from "./region-hint";

/** The `::replica::` infix marking a DO name as a read replica of an owner shard. Reserved — only the runtime mints replica names. */
const REPLICA_NAME_INFIX = "::replica::";

/** Build the replica DO name serving `ownerKey` in `region` — the deterministic name any worker/DO can compute without shared state. */
const replicaName = (ownerKey: string, region: RegionHint): string => `${ownerKey}${REPLICA_NAME_INFIX}${region}`;

/**
 * Parse a DO name into its owner key + region, or `undefined` when the name is
 * an owner (no `::replica::` infix) or carries a region that is not a known
 * placement region.
 *
 * The region check is a trust boundary, not a formality: replica names are
 * minted from a client-supplied shard key, so an unvalidated region would let a
 * caller address `tenant::replica::<anything>` and have the DO treat itself as
 * a replica of `tenant` — an unbounded set of extra DOs replicating one shard.
 * @returns the owner key + region, or `undefined` for an owner-role name
 */
const parseReplicaName = (name: string): undefined | { ownerKey: string; region: RegionHint } => {
    const at = name.lastIndexOf(REPLICA_NAME_INFIX);

    if (at === -1) {
        return undefined;
    }

    const ownerKey = name.slice(0, at);
    const region = name.slice(at + REPLICA_NAME_INFIX.length);

    if (ownerKey.length === 0 || !isRegionHint(region)) {
        return undefined;
    }

    return { ownerKey, region };
};

/**
 * Parse the `x-lunora-min-seq` read-your-writes bookmark, or `undefined` when
 * there is no usable requirement.
 *
 * Defined once and used at BOTH ends — the runtime deciding whether to forward
 * the header, and the replica deciding what freshness to hold itself to. Two
 * parses of one header is how the two ends end up disagreeing about its domain,
 * and the disagreement always resolves the unsafe way: the sender forwards a
 * value the receiver reads as "no requirement".
 *
 * `0` is not a requirement — it is the cursor of a shard that has never
 * committed anything, so treating it as one would only cost a round trip.
 */
const parseMinSeq = (raw: null | string | undefined): number | undefined => {
    if (raw === null || raw === undefined || !/^\d+$/.test(raw)) {
        return undefined;
    }

    const parsed = Number.parseInt(raw, 10);

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export { parseMinSeq, parseReplicaName, REPLICA_NAME_INFIX, replicaName };
