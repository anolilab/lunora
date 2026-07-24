import type { TableDiff } from "./table-diff";

/**
 * Append a canonical JSON encoding of `value` onto `parts`.
 *
 * "Canonical" means structurally identical values always encode identically
 * regardless of object-key insertion order at ANY nesting depth — arrays keep
 * their order, only object keys are sorted.
 *
 * Keys are sorted by UTF-16 code unit (`Array.prototype.sort`'s default), NOT
 * by `localeCompare`. `localeCompare` resolves against the runtime's default
 * locale and ICU version, so it orders `["B", "a"]` as `["a", "B"]` on a
 * full-ICU Node build but `["B", "a"]` under code-unit ordering — meaning two
 * clients in different locales would derive DIFFERENT ids for the SAME row and
 * diverge, which is precisely the failure {@link deriveInsertId} exists to
 * prevent (REPLICA-05). Code-unit ordering is locale-independent and is the
 * ordering canonical-JSON schemes (JCS, RFC 8785) specify.
 *
 * Emitting straight into `parts` avoids materializing an intermediate
 * canonicalized copy of the whole value tree and then walking it a second time
 * with `JSON.stringify` — the encoding is produced in a single pass. Leaf
 * scalars and object keys still go through `JSON.stringify` so string escaping
 * matches it exactly.
 *
 * The `undefined`/function/symbol handling mirrors `JSON.stringify`: such
 * values are omitted as object entries and become `null` as array elements.
 */
/*
 * The three encoders below are mutually recursive — a value contains arrays and
 * objects, which contain values — so whichever is declared first necessarily
 * references one declared later. That is inherent to the shape, not an ordering
 * mistake, hence the scoped exemption.
 */
/* eslint-disable @typescript-eslint/no-use-before-define -- mutually recursive encoders; no declaration order satisfies the rule */
const appendCanonicalJson = (value: unknown, parts: string[]): void => {
    if (Array.isArray(value)) {
        appendCanonicalArray(value, parts);

        return;
    }

    if (value !== null && typeof value === "object") {
        appendCanonicalObject(value as Record<string, unknown>, parts);

        return;
    }

    // Scalars (and `null`). `JSON.stringify` returns `undefined` only for
    // undefined/function/symbol, which the callers below already filtered out,
    // so the result here is always a string.
    parts.push(JSON.stringify(value));
};

/** True for the values `JSON.stringify` refuses to encode (omitted in objects, `null` in arrays). */
const isUnencodable = (value: unknown): boolean => value === undefined || typeof value === "function" || typeof value === "symbol";

const appendCanonicalArray = (value: ReadonlyArray<unknown>, parts: string[]): void => {
    parts.push("[");

    for (const [index, item] of value.entries()) {
        if (index > 0) {
            parts.push(",");
        }

        if (isUnencodable(item)) {
            parts.push("null");
        } else {
            appendCanonicalJson(item, parts);
        }
    }

    parts.push("]");
};

const appendCanonicalObject = (record: Record<string, unknown>, parts: string[]): void => {
    /*
     * `Object.keys` returns a fresh array, so sorting it in place is correct and
     * avoids the extra allocation `toSorted()` would add to this hot path —
     * hence the `unicorn/no-array-sort` exemption. The bare (code-unit) sort is
     * deliberate and must NOT gain a `localeCompare` comparator: see the
     * canonical-ordering rationale on `appendCanonicalJson`. A locale-sensitive
     * comparator here would make derived row ids differ between clients.
     */
    // eslint-disable-next-line unicorn/no-array-sort, sonarjs/no-alphabetical-sort -- code-unit order is required for cross-locale determinism; in-place sort of a fresh array is safe
    const keys = Object.keys(record).sort();

    parts.push("{");

    let first = true;

    for (const key of keys) {
        const child = record[key];

        if (isUnencodable(child)) {
            continue;
        }

        if (first) {
            first = false;
        } else {
            parts.push(",");
        }

        parts.push(JSON.stringify(key), ":");
        appendCanonicalJson(child, parts);
    }

    parts.push("}");
};
/* eslint-enable @typescript-eslint/no-use-before-define */

const hex4 = (limb: number): string => limb.toString(16).padStart(4, "0");

/**
 * 64-bit FNV-1a over the concatenation of `parts`, as 16 lowercase hex digits.
 *
 * The hash state is held as four 16-bit limbs in plain `number`s rather than a
 * `BigInt`. BigInt allocates a heap object per operation, and this runs once
 * per character of the hash input — the limb form is ~8x faster and produces
 * bit-identical digests (verified against the BigInt implementation in
 * `__tests__/apply-diff.test.ts`).
 *
 * The FNV-1a prime `0x0000_0100_0000_01b3` has only two non-zero 16-bit limbs
 * (`0x01b3` at limb 0 and `0x0100` at limb 2), so the full 4x4 limb product
 * collapses to the two multiplications per limb below. Every intermediate stays
 * well under 2^32, so `>>> 16` is a valid carry extraction.
 *
 * Hashing `parts` without joining them first is equivalent to hashing the
 * concatenated string: FNV-1a is a left-to-right fold over code points, and no
 * surrogate pair can straddle a part boundary (every part is either an ASCII
 * delimiter or a complete, well-formed `JSON.stringify` token).
 * @param parts Fragments whose concatenation is the hash input.
 */
const fnv1a64Hex = (parts: ReadonlyArray<string>): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication; the bit ops ARE the algorithm */
    // Offset basis 0xcbf29ce484222325, low limb first.
    let h0 = 0x23_25;
    let h1 = 0x84_22;
    let h2 = 0x9c_e4;
    let h3 = 0xcb_f2;

    for (const part of parts) {
        for (let index = 0; index < part.length; index += 1) {
            const point = part.codePointAt(index) ?? 0;

            // A code point above the BMP occupies limbs 0 and 1.
            h0 ^= point & 0xff_ff;
            h1 ^= (point >>> 16) & 0xff_ff;

            const p0 = h0 * 0x01_b3;
            const p1 = h1 * 0x01_b3;
            const p2 = h2 * 0x01_b3 + h0 * 0x01_00;
            const p3 = h3 * 0x01_b3 + h1 * 0x01_00;

            const c1 = p1 + (p0 >>> 16);
            const c2 = p2 + (c1 >>> 16);
            const c3 = p3 + (c2 >>> 16);

            h0 = p0 & 0xff_ff;
            h1 = c1 & 0xff_ff;
            h2 = c2 & 0xff_ff;
            h3 = c3 & 0xff_ff;
        }
    }

    return hex4(h3) + hex4(h2) + hex4(h1) + hex4(h0);
    /* eslint-enable no-bitwise */
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
 * encoding of `data` — never the wall clock or any other apply-time-only value.
 */
const deriveInsertId = (diff: Pick<TableDiff, "id" | "table" | "timestamp">, changeIndex: number, data: Record<string, unknown>): string => {
    const diffIdentity = diff.id ?? String(diff.timestamp);
    const parts = [diff.table, "::", diffIdentity, "::", String(changeIndex), "::"];

    appendCanonicalJson(data, parts);

    return `row-${fnv1a64Hex(parts)}`;
};

/**
 * Apply a diff's changes onto `target` **in place**.
 *
 * The copy-on-apply contract lives in the exported {@link applyDiff}; keeping
 * the mutation itself separate lets {@link applyDiffs} fold a whole backlog
 * into one map with a single copy up front instead of one copy per diff.
 */
const applyDiffInto = (target: Map<string, Record<string, unknown>>, diff: TableDiff): void => {
    const { changes } = diff;

    for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
        const change = changes[changeIndex] as (typeof changes)[number];

        switch (change.type) {
            case "delete": {
                target.delete(change.id);
                break;
            }
            case "insert": {
                // Insert uses the row data itself (id may or may not be inside data)
                const rawId = (change.data as { id?: unknown }).id;
                const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : deriveInsertId(diff, changeIndex, change.data);

                target.set(id, { ...change.data, id });
                break;
            }
            case "update": {
                const existing = target.get(change.id);

                if (existing) {
                    target.set(change.id, { ...existing, ...change.data });
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

    applyDiffInto(next, diff);

    return next;
};

/**
 * Apply an array of diffs **in order**, returning the final row map.
 *
 * This is equivalent to calling {@link applyDiff} repeatedly but copies the
 * input map exactly once rather than once per diff — catch-up replay of an
 * N-diff backlog is a single copy, not N+1.
 * @experimental
 */
const applyDiffs = (current: ReadonlyMap<string, Record<string, unknown>>, diffs: ReadonlyArray<TableDiff>): Map<string, Record<string, unknown>> => {
    const result = new Map(current);

    for (const diff of diffs) {
        applyDiffInto(result, diff);
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
