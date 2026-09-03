import { stableWireKey } from "../../../shared/wire-key";
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
 * callback diffs it against the previous frame: a row that is new or whose
 * content changed is upserted, a row that dropped out is deleted, and an
 * unchanged row produces nothing. A frame identical to the last one therefore
 * applies no diff — no event-log entry, no `version` bump, no re-query for the
 * hooks subscribed to the mirror.
 *
 * Rows are keyed by the table's primary key (`id` unless the table was
 * registered with another `primaryKey`); a row without one can't be diffed or
 * reconciled on removal, and — because the mirror's key column is `NOT NULL` —
 * will fail the insert.
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

    // Register the table so the mirror creates it on first diff (merges into a
    // pre-registered definition, so a user-supplied `primaryKey` survives).
    mirror.registerTable(tableName, {});

    const pk = mirror.primaryKeyOf(tableName);

    // The last APPLIED frame: primary key → stable encoding of the row. Holding
    // the encoding (not the row) keeps this O(rows) and makes "changed?" one
    // string compare. `stableWireKey` covers every value a decoded wire row can
    // carry (bigint, Date, bytes, …), which plain JSON would throw on or alias.
    let known = new Map<string, string>();

    return client.subscribe(
        functionRef,
        args,
        (data: unknown) => {
            const next = new Map<string, string>();
            // The row behind each surviving encoding. Filled in the same pass as
            // `next`, so a repeated primary key leaves the LAST row for that key
            // in both — which is what makes the diff below agree with the frame
            // this hands to `known`.
            const records = new Map<string, Record<string, unknown>>();
            const changes: RowChange[] = [];

            for (const row of asRowArray(data)) {
                const record = row as Record<string, unknown>;
                const rawId = record[pk];

                // `bigint` belongs here with the other two: it is what the wire
                // decoder hands back for an int64 column, so an id-typed primary
                // key arrives as one. Rejecting it as un-keyed made every frame
                // re-insert every row (never recorded in `known`, so never
                // "unchanged") and made removal undetectable (never in `known`,
                // so never deleted). `String()` keys them consistently — 1n and 1
                // are the same row id, which is what the mirror stores.
                if (typeof rawId !== "string" && typeof rawId !== "number" && typeof rawId !== "bigint") {
                    // Un-keyed row: cannot be diffed; let the mirror's NOT NULL
                    // constraint surface it, as documented above.
                    changes.push({ type: "insert", data: record });

                    continue;
                }

                const id = String(rawId);
                const encoded = stableWireKey(record);

                next.set(id, encoded);
                records.set(id, record);
            }

            // Diffed only AFTER the frame is deduplicated, never row by row.
            // A frame may repeat a primary key, and `known` is replaced with
            // `next` — the LAST row per key. Comparing each row as it arrived
            // let `[id=1: A, id=1: B]` over a prior frame of `id=1: B` queue A
            // (differs from `known`) and then skip B (matches `known`), leaving
            // the mirror on A while `known` claimed B: a divergence no later
            // frame could correct, because every subsequent frame of B looks
            // unchanged.
            for (const [id, encoded] of next) {
                // A changed row is upserted (`insert` → INSERT OR REPLACE), not
                // `update`d: a snapshot row is the WHOLE row, and UPDATE would
                // leave a column the server dropped at its stale value.
                if (known.get(id) !== encoded) {
                    changes.push({ data: records.get(id) as Record<string, unknown>, type: "insert" });
                }
            }

            // Delete rows present last frame but gone now.
            for (const id of known.keys()) {
                if (!next.has(id)) {
                    changes.push({ type: "delete", id });
                }
            }

            if (changes.length > 0) {
                mirror.applyDiff({ table: tableName, changes, timestamp: Date.now() });
            }

            // Reached only after a successful apply (or a no-op frame). A throw
            // above — an un-keyed row failing the NOT NULL insert — leaves `known`
            // on the last applied frame, so the deletes this frame owed are
            // re-derived by the next one instead of being orphaned forever.
            known = next;
        },
        { shardKey },
    );
};

export { subscribeToMirror };
