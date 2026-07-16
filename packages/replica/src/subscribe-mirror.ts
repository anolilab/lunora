import type { LocalMirror } from "./local-mirror";
import type { RowChange } from "./table-diff";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Derive a table name from a Lunora function ref (e.g. `"todos/list"` → `"fn_todos_list"`). */
const deriveTableName = (functionRef: string): string => `fn_${functionRef.replaceAll(/[/:.]/g, "_")}`;

/** Normalise the server response into an array of row-like objects. */
const asRowArray = (data: unknown): unknown[] => {
    if (Array.isArray(data)) {
        return data;
    }
    if (data !== null && typeof data === "object") {
        return [data];
    }
    return [];
};

/**
 * A dependency-light subscription sink interface that mirrors what
 * `LunoraClient.subscribe` expects, so the mirror helper doesn't
 * need to import `@lunora/client`.
 * @experimental
 */
// eslint-disable-next-line import/exports-last -- used as param type before end of file
export interface SubscriptionClient {
    subscribe: (
        functionRef: { __lunoraRef: string },
        args: Record<string, unknown>,
        callback: (data: unknown) => void,
        options?: { shardKey?: string },
    ) => () => void;
}

/**
 * Subscribe a Lunora-query to the local mirror so every server push
 * is applied to the local SQLite store.
 *
 * Each frame from a Lunora live query is the FULL current result set, so the
 * callback treats it as a snapshot: it upserts every row present and emits a
 * `delete` for any id that was mirrored on a previous frame but is absent now —
 * otherwise rows that drop out of the server result would linger stale in the
 * local mirror. Rows are keyed by their `id` field (the mirror's default primary
 * key); a row without an `id` can't be reconciled on removal, and — because the
 * mirror table's `id` column is `NOT NULL` — will fail the insert.
 *
 * The mirror table name is derived from the function ref alone (not `args`), so
 * do NOT mirror two subscriptions to the same function with different `args`
 * into the same mirror: they'd share one table and the snapshot-delete pass of
 * one could remove rows still live in the other.
 *
 * Call the returned unsubscribe function to tear down both the client
 * subscription and future mirror writes.
 * @example
 * ```ts
 * const unsub = subscribeToMirror(client, mirror, api.todos.list, { userId });
 * // Later:
 * unsub();
 * ```
 * @experimental
 */
const subscribeToMirror = (
    client: SubscriptionClient,
    mirror: LocalMirror,
    functionRef: { __lunoraRef: string },
    args: Record<string, unknown>,
    shardKey?: string,
): (() => void) => {
    // Derive a table name from the function path (e.g. "todos/list" → "fn_todos_list")
    const tableName = deriveTableName(functionRef.__lunoraRef);

    // Register the table so the mirror creates it on first diff
    mirror.registerTable(tableName, {});

    // Ids mirrored by the previous frame, so the next frame can delete the ones
    // that dropped out of the result set (full-snapshot reconciliation).
    let knownIds = new Set<string>();

    return client.subscribe(
        functionRef,
        args,
        (data: unknown) => {
            const rows = asRowArray(data);
            const nextIds = new Set<string>();
            const changes: RowChange[] = [];

            for (const row of rows) {
                const record = row as Record<string, unknown>;
                const rawId = record.id;

                if (typeof rawId === "string" || typeof rawId === "number") {
                    nextIds.add(String(rawId));
                }

                changes.push({ type: "insert", data: record });
            }

            // Delete rows present last frame but gone now.
            for (const id of knownIds) {
                if (!nextIds.has(id)) {
                    changes.push({ type: "delete", id });
                }
            }

            knownIds = nextIds;

            if (changes.length === 0) {
                return;
            }

            mirror.applyDiff({ table: tableName, changes, timestamp: Date.now() });
        },
        { shardKey },
    );
};

export { subscribeToMirror };
