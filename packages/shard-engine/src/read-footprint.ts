/**
 * What a single query execution read, in the shape the refresh gate needs.
 *
 * Two channels feed it. `onReadRange` reports a read provably confined to one
 * contiguous index slice; `onRead` reports everything else — a row read by id,
 * or the `SCAN_DEP` sentinel for a read that could not be narrowed at all.
 *
 * The gate may only narrow a table when EVERY read of it was a range. That is
 * the correctness hinge, and it is why the two channels stay separate rather
 * than being folded into one string space:
 *
 * A `*scan` read depends on rows the slice does not name, so a write outside the
 * slice can still change the result. A by-id read is no better: the query
 * depends on that specific row, whose index position may sit outside every
 * recorded slice, so narrowing on the slices alone would skip an invalidation
 * the read needed.
 *
 * `ranges()` therefore returns a table's slices only when that table was read
 * exclusively through ranges, and omits it otherwise. An omitted table falls
 * back to whole-table matching, which is what the pre-range behaviour did.
 */

import type { KeyRange } from "./read-write-set";

interface ReadFootprint {
    /** Report a row-id or `SCAN_DEP` read — marks `table` unnarrowable. */
    onRead: (table: string, idOrScan?: string) => void;
    /** Report a read confined to `range`. */
    onReadRange: (range: KeyRange) => void;

    /**
     * Slices per table, for tables read ONLY through ranges. `undefined` when
     * nothing was narrowable, which lets callers skip the map entirely.
     */
    ranges: () => Map<string, KeyRange[]> | undefined;
    /** Every table touched, by either channel. */
    tables: Set<string>;
}

const createReadFootprint = (): ReadFootprint => {
    const tables = new Set<string>();
    const byTable = new Map<string, KeyRange[]>();
    const unnarrowable = new Set<string>();

    return {
        onRead(table) {
            tables.add(table);
            unnarrowable.add(table);
        },
        onReadRange(range) {
            tables.add(range.table);

            const existing = byTable.get(range.table);

            if (existing) {
                existing.push(range);
            } else {
                byTable.set(range.table, [range]);
            }
        },
        ranges() {
            for (const table of unnarrowable) {
                byTable.delete(table);
            }

            return byTable.size > 0 ? byTable : undefined;
        },
        tables,
    };
};

/**
 * The dependency name stamped for a read the CDC changelog can never speak for.
 *
 * `__cdc_log` records writes to THIS shard's own SQLite tables and nothing else,
 * so `cdcCanVouchFor` (see `ctx-db-cdc.ts`) defines the vouchable set positively:
 * a dependency is vouchable iff a table of that name exists in this DO's SQLite.
 * Everything else falls to "cannot vouch", and a read-set that cannot be vouched
 * for forces a re-snapshot instead of a resume.
 *
 * That rule is only as good as what reaches the read-set. `ctx.kv`, `ctx.storage`,
 * `ctx.vectors` and `ctx.db.system` all read state that lives outside this
 * shard's SQLite and none of them stamped anything, so a query reading a local
 * table AND one of them arrived with a read-set of `{table}` — fully vouchable —
 * and was told `resumable: true` while the KV/R2/Vectorize value it returned had
 * since moved. This sentinel is the missing stamp: it is a name no table can
 * carry, so it can only ever fall to "cannot vouch".
 *
 * `ctx.flags` is the deliberate exception and is NOT stamped — see
 * `emitFlagsFragments` in `@lunora/codegen`'s `emit.ts` for why, and for the
 * advisor lint that tells an app author instead.
 *
 * Deliberately NOT `"*"` (the admin wildcard in `shard-do.ts`). That one has a
 * second meaning — `refreshSubscriptions` re-runs a memo carrying it on EVERY
 * write-flush — and a query that reads KV has no need of that: it still re-runs
 * exactly when one of its real tables moves. Reusing `"*"` would have turned an
 * honest "cannot prove this is current on reconnect" into a permanent per-write
 * re-execution tax. A distinct name never appears in the written-table set, so
 * `setsIntersect` / `writeTouchesMemo` skip past it and the live path is unchanged.
 *
 * The `!` prefix is the same trick `"*"` uses: no `defineTable` name can produce
 * it, so `cdcCanVouchFor`'s `sqlite_master` lookup can never find a real table
 * shadowing it and accidentally vouch.
 */
const UNVOUCHABLE_DEP = "!unvouchable";

/**
 * Wrap a ctx facade so calling one of `methods` stamps {@link UNVOUCHABLE_DEP}
 * into the in-flight read footprint — making any subscription that touched it
 * un-resumable, per the rule above.
 *
 * `onRead` is the footprint's own `onRead`, threaded from the generated
 * `buildCtx`. It is `undefined` on the plain RPC dispatch path, where this
 * returns the facade untouched: only `executeSubscription` builds the read-set
 * the resume verdict reads, and stamping the RPC path instead would land the
 * sentinel in the dependency tracker and from there in the request log's
 * `tablesRead` — a fabricated table name in the operator-facing readout, buying
 * nothing.
 *
 * Stamps on CALL, never on property access. Feature detection is real here —
 * `createShardCtxDb` probes `typeof scheduler.list === "function"` before wiring
 * `ctx.db.system`, and `asBucketStorage` inspects the bucket facade — so a `get`
 * trap that stamped eagerly would mark every query in a scheduler-enabled app
 * un-resumable at ctx-build time, before the handler read anything.
 *
 * A `Proxy` rather than a spread copy so `this` still binds to the real facade
 * (`Reflect.apply(value, target, …)`), and so methods NOT in `methods` pass
 * through with their identity and behaviour intact. `methods` is an allowlist,
 * not a blanket, because several of these facades expose genuinely pure members:
 * `ctx.storage.getUrl` / `getSignedUrl` build a URL from configured base + HMAC
 * and read nothing, and they are what real handlers call most — stamping them
 * would cost re-snapshots for a dependency that cannot change the result.
 */
const markUnvouchableReads = <T extends object>(facade: T, onRead: ReadFootprint["onRead"] | undefined, methods: ReadonlyArray<string>): T => {
    if (!onRead) {
        return facade;
    }

    const stamped = new Set(methods);

    return new Proxy(facade, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;

            if (typeof value !== "function" || typeof property !== "string" || !stamped.has(property)) {
                return value;
            }

            return (...args: unknown[]): unknown => {
                onRead(UNVOUCHABLE_DEP);

                return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
            };
        },
    });
};

export { createReadFootprint, markUnvouchableReads, UNVOUCHABLE_DEP };
export type { ReadFootprint };
