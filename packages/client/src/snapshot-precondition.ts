import { stableWireKey } from "@lunora/wire";

import type { LunoraClient } from "./lunora-client";
import { registerSnapshotSource } from "./snapshot-precondition-source";
import type { FunctionReference } from "./types";

/**
 * Capture a snapshot of the current live query value at call time and produce a
 * `() => boolean` precondition that compares it against the value at replay time.
 *
 * When the precondition is checked (on queue drain / reconnect) it re-reads the
 * query's current state via {@link LunoraClient.peekActiveQuerySnapshot}. The
 * comparison only runs when a live subscription backed **both** reads; if either
 * read found no active subscription (e.g. the originating component unmounted
 * before replay, or a reconnect blanked it and it has not been answered again),
 * the precondition returns `true` (not stale) because absence of a subscription
 * is not evidence the value changed — the read simply cannot see it. When both reads did have a live subscription and the value differs, the
 * precondition returns `false` and the offline mutation is dropped as stale.
 *
 * The offline queue does not evaluate it while the subscription is still waiting
 * for its answer on a reconnected socket: the value it holds then is the previous
 * socket's (or blank), so the write stays queued until the answer lands.
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
    const snapshotKey = snapshot.present && snapshot.answered ? stableWireKey(snapshot.value) : undefined;

    const precondition = (): boolean => {
        const current = client.peekActiveQuerySnapshot(functionRef.__lunoraRef, args, shardKey);

        // Either read had no live subscription → nothing to compare against; not
        // evidence of a conflict, so don't drop the write. Nor is a blank no answer
        // has replaced yet (a cold reconnect, as read outside the offline queue).
        if (!snapshot.present || !snapshot.answered || !current.present || !current.answered) {
            return true;
        }

        return stableWireKey(current.value) === snapshotKey;
    };

    if (snapshotKey !== undefined) {
        registerSnapshotSource(precondition, { args, functionPath: functionRef.__lunoraRef, shardKey });
    }

    return precondition;
};

export default createSnapshotPrecondition;
