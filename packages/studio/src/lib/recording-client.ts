import type { LunoraClient } from "@lunora/client";

import { operationLog } from "./operation-log";

/**
 * Wrap a {@link LunoraClient} so every admin RPC the Studio issues lands on the
 * operation tape.
 *
 * **Why here and not at the call sites.** The first cut of this recorded inside a
 * `recordedCall` helper that callers had to opt into, and exactly one caller did
 * (`useAdminQuery`'s read fetcher). The other ~53 dispatches — every write among
 * them: `writeRow`, `deleteRows`, `runMigration`, `pitrRestore`, `importShard`,
 * `runSql` — went unrecorded, which gutted the feature: the operations an
 * operator most needs to reconstruct after a failure were the ones missing. A
 * per-call-site convention is only as good as the next contributor's memory of
 * it. Wrapping the client once makes coverage true by CONSTRUCTION, and covers
 * `dispatchByKind` and any future call site for free.
 *
 * Only `__lunora_admin__:` paths are recorded — a Studio embedded in a host app
 * shares the client with the host's own traffic, which is none of this tape's
 * business.
 *
 * The proxy is transparent: every other member (`subscribe`, `close`,
 * `setAuthToken`, `onTokenExpired`, the workflow helpers) forwards to the target
 * bound to the target, so ownership and lifecycle are unchanged.
 */

/** The reserved prefix every Studio-issued admin RPC path carries. */
const ADMIN_PREFIX = "__lunora_admin__:";

/** The three dispatch methods that take a `FunctionReference` and return a promise. */
const RECORDED_METHODS = new Set(["action", "mutation", "query"]);

/**
 * Symbol key under which a rejection is tagged with its operation-tape sequence,
 * so an `ErrorAlert` rendered from the failure can open the console on the exact
 * entry that produced it. A Symbol (not a string field) so it can never collide
 * with a server-sent error property, and non-enumerable so it stays out of
 * serialization.
 */
const OPERATION_SEQ = Symbol("lunora.operationSeq");

/** Read the operation-tape sequence a rejection was tagged with, if any. */
const operationSeqOf = (error: unknown): number | undefined => {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }

    const seq = (error as Record<symbol, unknown>)[OPERATION_SEQ];

    return typeof seq === "number" ? seq : undefined;
};

/**
 * Tag a rejection with its tape entry, defensively.
 *
 * `typeof error === "object"` does NOT imply extensible: a frozen, sealed, or
 * `preventExtensions`'d rejection — or a Proxy whose `defineProperty` trap
 * refuses — makes `Object.defineProperty` throw. Thrown from inside a catch
 * block, that would DISCARD the real rejection and surface
 * "Cannot define property Symbol(lunora.operationSeq)" in its place. An
 * error-instrumentation layer replacing the error it was instrumenting is the
 * one outcome that is never acceptable, so this fails silently instead: the
 * console is still reachable, just without a precise anchor.
 */
const tagWithSeq = (error: unknown, seq: number): void => {
    if (typeof error !== "object" || error === null || !Object.isExtensible(error)) {
        return;
    }

    try {
        Object.defineProperty(error, OPERATION_SEQ, { configurable: true, enumerable: false, value: seq, writable: true });
    } catch {
        // A Proxy trap can still refuse after `isExtensible` said yes. Losing the
        // tag costs a precise jump; losing the error costs the diagnosis.
    }
};

/** Extract the reserved function path from a `FunctionReference` (`{ __lunoraRef }`), if it is one. */
const adminPathOf = (reference: unknown): string | undefined => {
    if (typeof reference !== "object" || reference === null) {
        return undefined;
    }

    const path = (reference as { __lunoraRef?: unknown }).__lunoraRef;

    return typeof path === "string" && path.startsWith(ADMIN_PREFIX) ? path : undefined;
};

/** Read the shard key out of a dispatch's options argument, defaulting to the root shard. */
const shardKeyOf = (options: unknown): string => {
    if (typeof options !== "object" || options === null) {
        return "";
    }

    const { shardKey } = options as { shardKey?: unknown };

    return typeof shardKey === "string" ? shardKey : "";
};

/**
 * Return a recording view of `client`. Non-admin traffic and every non-dispatch
 * member pass straight through.
 */
const withOperationRecording = (client: LunoraClient): LunoraClient =>
    new Proxy(client, {
        get(target, property, receiver): unknown {
            const value = Reflect.get(target, property, receiver) as unknown;

            if (typeof value !== "function" || typeof property !== "string" || !RECORDED_METHODS.has(property)) {
                return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }

            const dispatch = value as (...args: unknown[]) => Promise<unknown>;

            return async (...parameters: unknown[]): Promise<unknown> => {
                const path = adminPathOf(parameters[0]);

                if (path === undefined) {
                    return dispatch.apply(target, parameters);
                }

                const args = (typeof parameters[1] === "object" && parameters[1] !== null ? parameters[1] : {}) as Record<string, unknown>;
                const seq = operationLog.start(path, args, shardKeyOf(parameters[2]));

                try {
                    const result = await dispatch.apply(target, parameters);

                    operationLog.settle(seq, { result });

                    return result;
                } catch (error: unknown) {
                    operationLog.settle(seq, { error: error instanceof Error ? error.message : String(error) });
                    tagWithSeq(error, seq);

                    throw error;
                }
            };
        },
    });

export { operationSeqOf, withOperationRecording };
