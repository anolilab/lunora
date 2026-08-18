import { stableWireKey } from "../../../shared/wire-key";
import type { LunoraClient } from "./lunora-client";
import type { FunctionReference } from "./types";

/**
 * Capture a snapshot of the current live query value at call time and produce a
 * `() => boolean` precondition that compares it against the value at replay time.
 *
 * When the precondition is checked (on queue drain / reconnect) it re-reads the
 * query's current state via {@link LunoraClient.peekActiveQuerySnapshot}. The
 * comparison only runs when a live subscription backed **both** reads; if either
 * read found no active subscription (e.g. the originating component unmounted
 * before replay), the precondition returns `true` (not stale) because absence of
 * a subscription is not evidence the value changed — the read simply cannot see
 * it. When both reads did have a live subscription and the value differs, the
 * precondition returns `false` and the offline mutation is dropped as stale.
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
    const snapshot = client.peekActiveQuerySnapshot(functionRef.__lunoraRef, args, shardKey);
    const snapshotKey = snapshot.present ? stableWireKey(snapshot.value) : undefined;

    return (): boolean => {
        const current = client.peekActiveQuerySnapshot(functionRef.__lunoraRef, args, shardKey);

        // Either read had no live subscription → nothing to compare against; not
        // evidence of a conflict, so don't drop the write.
        if (!snapshot.present || !current.present) {
            return true;
        }

        return stableWireKey(current.value) === snapshotKey;
    };
};

export default createSnapshotPrecondition;
