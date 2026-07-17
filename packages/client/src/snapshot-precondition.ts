import { stableWireKey } from "../../../shared/wire-key";
import type { LunoraClient } from "./lunora-client";
import type { FunctionReference } from "./types";

/**
 * Capture a snapshot of the current live query value at call time and produce a
 * `() => boolean` precondition that compares it against the value at replay time.
 *
 * When the precondition is checked (on queue drain / reconnect) it re-reads the
 * query's current value via {@link LunoraClient.peekActiveQueryValue}. If the
 * value differs from what was captured at call time the precondition returns
 * `false` and the offline mutation is dropped as stale.
 * @example
 * ```ts
 * client.mutation(api.todos.update, { id, text }, {
 *   precondition: createSnapshotPrecondition(client, api.todos.list, { userId }),
 * });
 * ```
 */
const createSnapshotPrecondition = (
    client: LunoraClient,
    functionRef: FunctionReference,
    args: Record<string, unknown>,
    shardKey?: string,
): (() => boolean) => {
    const snapshot = client.peekActiveQueryValue(functionRef.__lunoraRef, args, shardKey);
    const snapshotKey = snapshot === undefined ? undefined : stableWireKey(snapshot);

    return (): boolean => {
        const current = client.peekActiveQueryValue(functionRef.__lunoraRef, args, shardKey);

        // Both undefined → no snapshot taken and no value now → no conflict.
        if (snapshotKey === undefined && current === undefined) {
            return true;
        }

        // One is undefined, the other is not → the value appeared or disappeared.
        if (snapshotKey === undefined || current === undefined) {
            return false;
        }

        return stableWireKey(current) === snapshotKey;
    };
};

export default createSnapshotPrecondition;
