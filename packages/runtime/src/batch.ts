/**
 * Worker-side helper for the batch RPC transport (plan 088). Extracted from
 * `create-worker.ts` as a pure, testable unit: validate the `calls[]` of a batch
 * and group them by target shard. The stateful fan-out (identity resolution,
 * authorization, per-shard forwarding) stays in `create-worker.ts`'s
 * `handleBatchRpc`, which closes over the worker options.
 */

import type { BatchEntry } from "../../../shared/batch-wire";
import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import { LunoraError } from "./errors";

/**
 * Validate one raw batch call and normalize it into a forwarded {@link BatchEntry}
 * plus its target shard. Throws a `BAD_REQUEST`/`FORBIDDEN` {@link LunoraError} on
 * a non-string `functionPath` or a reserved fan-out/admin/relation prefix (a batch
 * carries only single-shard user calls). `id` falls back to the array index when
 * absent, and must otherwise be a number — the response is a flat `results[]` the
 * client demuxes BY id, so a string id silently renumbered to the index answers
 * one call under another call's identity.
 */
const normalizeBatchCall = (raw: unknown, index: number, defaultShard: string): { entry: BatchEntry; shardKey: string } => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new LunoraError("each batch call must be an object", { code: "BAD_REQUEST", status: 400 });
    }

    const call = raw as {
        args?: unknown;
        clientId?: unknown;
        clientSeq?: unknown;
        functionPath?: unknown;
        id?: unknown;
        mutationId?: unknown;
        shardKey?: unknown;
    };

    if (typeof call.functionPath !== "string") {
        throw new LunoraError("each batch call needs a string `functionPath`", { code: "BAD_REQUEST", status: 400 });
    }

    if (call.functionPath.startsWith("__lunora_relation__:") || call.functionPath.startsWith("__lunora_admin__")) {
        throw new LunoraError("reserved function path cannot be batched", { code: "FORBIDDEN", status: 403 });
    }

    // `args` flows untrusted to the shard's `/rpc-batch` body. Reject a non-object
    // (`args: "x"` / `args: 5` / `args: [...]`) at the boundary, exactly as the
    // single-call `parseEnvelope` does, rather than forwarding a malformed envelope
    // the shard then has to defend against. Absent → `{}` (handled below).
    if (call.args !== undefined && (typeof call.args !== "object" || call.args === null || Array.isArray(call.args))) {
        throw new LunoraError("each batch call `args` must be an object", { code: "BAD_REQUEST", status: 400 });
    }

    if (call.id !== undefined && typeof call.id !== "number") {
        throw new LunoraError("each batch call `id` must be a number", { code: "BAD_REQUEST", status: 400 });
    }

    return {
        entry: {
            args: call.args === undefined ? {} : (call.args as Record<string, unknown>),
            clientId: typeof call.clientId === "string" ? call.clientId : undefined,
            clientSeq: typeof call.clientSeq === "number" ? call.clientSeq : undefined,
            functionPath: call.functionPath,
            id: typeof call.id === "number" ? call.id : index,
            mutationId: typeof call.mutationId === "string" ? call.mutationId : undefined,
        },
        shardKey: typeof call.shardKey === "string" ? call.shardKey : defaultShard,
    };
};

/**
 * Validate a batch's `calls[]` and group them by target shard. Throws when the
 * batch exceeds {@link MAX_BATCH_ENTRIES} (a single-threaded DO replays entries
 * sequentially, so an unbounded batch is a DoS lever), carries a malformed /
 * reserved entry (see {@link normalizeBatchCall}), or reuses an `id`.
 *
 * Ids must be distinct because the response is a flat `results[]` the client
 * demuxes by id: two entries sharing one makes the batch un-demuxable, and the
 * clash is just as reachable through the positional fallback (an explicit `id: 1`
 * beside an id-less entry at index 1) as through two explicit duplicates.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: import sites stay uniform (`import { groupBatchCallsByShard }`), per the repo's no-default-mixing convention
export const groupBatchCallsByShard = (calls: unknown[], defaultShard: string): Map<string, BatchEntry[]> => {
    if (calls.length > MAX_BATCH_ENTRIES) {
        throw new LunoraError(`RPC batch exceeds the ${String(MAX_BATCH_ENTRIES)}-call limit`, { code: "BAD_REQUEST", status: 400 });
    }

    const groups = new Map<string, BatchEntry[]>();
    const seenIds = new Set<number>();

    for (const [index, raw] of calls.entries()) {
        const { entry, shardKey } = normalizeBatchCall(raw, index, defaultShard);

        if (seenIds.has(entry.id)) {
            throw new LunoraError(`batch call id ${String(entry.id)} is used twice; ids must be distinct`, { code: "BAD_REQUEST", status: 400 });
        }

        seenIds.add(entry.id);

        const group = groups.get(shardKey) ?? [];

        group.push(entry);
        groups.set(shardKey, group);
    }

    return groups;
};
