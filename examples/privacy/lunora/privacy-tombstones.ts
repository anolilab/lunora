/**
 * The tombstone port over the `PRIVACY_TOMBSTONES` Durable Object (`src/server/privacy-tombstones-do.ts`).
 *
 * The tombstones live outside the shard, so a point-in-time restore of the shard cannot
 * delete them. Only a workflow reaches them: it has the Worker's bindings on `ctx.env`.
 * A mutation runs inside the shard and has no binding to reach them by, so its port
 * refuses instead of letting an erasure complete without its tombstone. A throw inside
 * a mutation rolls back the whole transaction, deletes included.
 */
import type { TombstonePort } from "@lunora/privacy";
import { LunoraError } from "lunorash/errors";

/** The RPC surface of one tombstone store instance. */
interface TombstoneStub {
    readonly add: (subjectKey: string, erasedAt: number) => Promise<void>;
    readonly keys: () => Promise<string[]>;
}

/** The `PRIVACY_TOMBSTONES` namespace, as much of it as this port uses. Read from the untyped `ctx.env`. */
interface TombstoneNamespace {
    readonly get: (id: unknown) => TombstoneStub;
    readonly idFromName: (name: string) => unknown;
}

/** Every tombstone is in one instance, so `keys` reads one table. */
const STORE_NAME = "tombstones";

/** The tombstone port for a workflow step, bound from the Worker's environment. */
export const tombstonesFrom = (env: Record<string, unknown>): TombstonePort => {
    const namespace = env.PRIVACY_TOMBSTONES as TombstoneNamespace | undefined;

    if (namespace === undefined) {
        throw new LunoraError("INTERNAL", "PRIVACY_TOMBSTONES is not bound: add the Durable Object binding to wrangler.jsonc.");
    }

    const store = (): TombstoneStub => namespace.get(namespace.idFromName(STORE_NAME));

    return {
        add: async (key, erasedAt) => store().add(key, erasedAt.getTime()),
        keys: async () => new Set(await store().keys()),
    };
};

/** A mutation's tombstone port: it cannot reach the store, so an erasure from a mutation fails loudly. */
export const tombstonesUnreachable: TombstonePort = {
    add: () => Promise.reject(new LunoraError("UNPROCESSABLE", "Erasures run in the privacy-erasure workflow, which writes the tombstone.")),
    keys: () => Promise.reject(new LunoraError("UNPROCESSABLE", "Tombstones are read from a workflow, not from a mutation.")),
};
