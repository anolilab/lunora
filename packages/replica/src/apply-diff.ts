import type { TableDiff } from "./table-diff";

/**
 * Recursively canonicalize a JSON-serialisable value so structurally
 * identical `data` always encodes identically regardless of object-key
 * insertion order at ANY nesting depth — not just the top level. Arrays
 * keep their order; only object keys are sorted.
 */
const canonicalizeForHash = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeForHash(item));
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const sortedKeys = Object.keys(record).toSorted((a, b) => a.localeCompare(b));
        const result: Record<string, unknown> = {};

        for (const key of sortedKeys) {
            result[key] = canonicalizeForHash(record[key]);
        }

        return result;
    }

    return value;
};

/**
 * Derive a deterministic id for an id-less insert.
 *
 * A random `crypto.randomUUID()` here would make replay non-deterministic:
 * re-applying the exact same {@link TableDiff} twice (e.g. once live, once on
 * catch-up replay from the event log) would mint two DIFFERENT row keys for
 * the same logical row, leaving duplicate rows / divergent replicas
 * (REPLICA-05). Hashing the diff's own content instead means the SAME diff
 * always derives the SAME id — the property required for safe replay.
 *
 * The hash is over the table name, the diff's stable `id` (falling back to
 * `timestamp` for diffs built without one — `timestamp` alone is NOT a
 * unique diff identity, since multiple diffs can share a millisecond), the
 * change's position within the diff (so two id-less inserts carrying
 * identical `data` in one diff still get distinct ids), and a canonical
 * (recursively sorted-key) encoding of `data` — never the wall clock or any
 * other apply-time-only value.
 */
const deriveInsertId = (diff: Pick<TableDiff, "id" | "table" | "timestamp">, changeIndex: number, data: Record<string, unknown>): string => {
    const diffIdentity = diff.id ?? String(diff.timestamp);
    const input = `${diff.table}::${diffIdentity}::${String(changeIndex)}::${JSON.stringify(canonicalizeForHash(data))}`;

    // Portable, dependency-free FNV-1a 64-bit hash (via BigInt) — determinism
    // (not cryptographic strength) is the requirement here, but a wider
    // digest than the previous 32-bit variant substantially shrinks the
    // collision space for distinct inserts.
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication; the bit ops ARE the algorithm */
    let hash = 0xcb_f2_9c_e4_84_22_23_25n;

    const prime = 0x00_00_01_00_00_00_01_b3n;
    const mask64 = 0xff_ff_ff_ff_ff_ff_ff_ffn;

    for (let index = 0; index < input.length; index += 1) {
        hash ^= BigInt(input.codePointAt(index) ?? 0);
        hash = (hash * prime) & mask64;
    }

    return `row-${hash.toString(16).padStart(16, "0")}`;
    /* eslint-enable no-bitwise */
};

/**
 * Apply a single {@link TableDiff} to an in-memory row map and return
 * the updated map.
 *
 * The function creates a **shallow copy** of the input map so the caller's
 * reference stays untouched unless they choose to replace it.
 * @example
 * ```ts
 * const rows = new Map<string, Record<string, unknown>>();
 * rows.set("id-1", { name: "alice" });
 *
 * const diff = createTableDiff("users", [
 *   { type: "insert", data: { id: "id-2", name: "bob" } },
 *   { type: "update", id: "id-1", data: { name: "alice-updated" } },
 * ]);
 *
 * const updated = applyDiff(rows, diff);
 * updated.get("id-1")?.name // "alice-updated"
 * updated.get("id-2")?.name // "bob"
 * ```
 * @experimental
 */
const applyDiff = (current: ReadonlyMap<string, Record<string, unknown>>, diff: TableDiff): Map<string, Record<string, unknown>> => {
    const next = new Map(current);

    for (const [changeIndex, change] of diff.changes.entries()) {
        switch (change.type) {
            case "delete": {
                next.delete(change.id);
                break;
            }
            case "insert": {
                // Insert uses the row data itself (id may or may not be inside data)
                const rawId = (change.data as { id?: unknown }).id;
                const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : deriveInsertId(diff, changeIndex, change.data);

                next.set(id, { ...change.data, id });
                break;
            }
            case "update": {
                const existing = next.get(change.id);

                if (existing) {
                    next.set(change.id, { ...existing, ...change.data });
                }
                // Silently skip updates to unknown rows (race: row was
                // deleted locally before the update arrived).
                break;
            }
            default: {
                break;
            }
        }
    }

    return next;
};

/**
 * Apply an array of diffs **in order**, returning the final row map.
 *
 * This is equivalent to calling {@link applyDiff} repeatedly but avoids
 * intermediate map copies.
 * @experimental
 */
const applyDiffs = (current: ReadonlyMap<string, Record<string, unknown>>, diffs: ReadonlyArray<TableDiff>): Map<string, Record<string, unknown>> => {
    let result = new Map(current);

    for (const diff of diffs) {
        result = applyDiff(result, diff);
    }

    return result;
};

/**
 * Merge the row-level effect of a {@link TableDiff} into plain JSON
 * state keyed by table name, returning a new snapshot.
 * @param snapshot Current snapshot, e.g. `{ users: Map&lt;id, row>, posts: Map&lt;id, row> }`.
 * @param diff Contains the target table name and the row-level changes to merge.
 * @returns A shallow copy of `snapshot` with `diff.table`'s map updated.
 * @experimental
 */
const applyDiffToSnapshot = (
    snapshot: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>,
    diff: TableDiff,
): Map<string, Map<string, Record<string, unknown>>> => {
    // Shallow copy — untouched tables keep the caller's row maps (shared by
    // reference, matching the documented shallow-copy contract). The cast widens
    // the readonly inner-map type to the mutable return type; the values are real
    // `Map`s at runtime, and the one table we replace gets a fresh map anyway.
    const next = new Map(snapshot) as Map<string, Map<string, Record<string, unknown>>>;

    const tableMap = next.get(diff.table) ?? new Map<string, Record<string, unknown>>();

    next.set(diff.table, applyDiff(tableMap, diff));

    return next;
};

export { applyDiff, applyDiffs, applyDiffToSnapshot };
