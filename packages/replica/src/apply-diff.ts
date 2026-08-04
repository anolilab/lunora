import type { TableDiff } from "./table-diff";

/**
 * Recursively canonicalize a JSON-serialisable value so structurally
 * identical `data` always encodes identically regardless of object-key
 * insertion order at ANY nesting depth — not just the top level. Arrays
 * keep their order; only object keys are sorted.
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
 * MIGRATION: this changed derived ids more broadly than "mixed-case keys".
 * Code-unit order differs from ICU collation for punctuation and separators
 * (`a-b` / `a_b` / `aXb`) and for non-ASCII keys (`"é"` now sorts after `"z"`),
 * so in practice any row whose keys are not all lowercase ASCII letters hashes
 * differently than before. One class was never locale-dependent at all: keys
 * are sorted but then reassigned into a fresh object, and JS re-orders
 * integer-like keys ("2", "10") into ascending numeric order on any object — so
 * `JSON.stringify` emits a spec-determined order the sort never controlled.
 * Nothing in this repo persists these ids and all three exports are
 * `@experimental`, so this is a release note rather than a migration.
 *
 * The caller hands the result to `JSON.stringify`. Encoding it here by hand
 * instead — one pass, no intermediate copy — was tried and REVERTED: it measured
 * slower on nested payloads, because `JSON.stringify` is a native fast path that
 * JS-side string building cannot beat, and it meant re-implementing
 * `JSON.stringify`'s escaping and `undefined`/`toJSON` rules by hand for no gain.
 * See `__bench__/apply-diff-hotpath.bench.ts`, which keeps that comparison so the
 * conclusion stays checkable.
 *
 * NOT `shared/stable-key.ts`, deliberately — which is this repo's canonical
 * stable-JSON encoder and reaches the same code-point ordering for the same
 * locale-independence reason. It cannot be used here because it is fail-LOUD by
 * contract: it throws a `TypeError` on `bigint` and on any non-plain object
 * (`Date`, typed arrays, class instances). That is right for a cache key, where
 * a silent collision would serve one caller another's data. It is wrong here —
 * `deriveInsertId` runs on untrusted row data straight off the poke protocol, so
 * a `Date` in a payload must hash, not throw and break replication. Those are
 * genuinely different contracts, so the duplication is intentional.
 */
const canonicalizeForHash = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeForHash(item));
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const sortedKeys = Object.keys(record);

        // The bare (code-unit) sort is deliberate and must NOT gain a
        // `localeCompare` comparator — see the ordering rationale above. Sorting
        // in place is safe because `Object.keys` returns a fresh array.
        // eslint-disable-next-line sonarjs/no-alphabetical-sort -- code-unit order is required for cross-locale determinism; a localeCompare comparator is the bug, not the fix
        sortedKeys.sort();

        const result: Record<string, unknown> = {};

        for (const key of sortedKeys) {
            result[key] = canonicalizeForHash(record[key]);
        }

        return result;
    }

    return value;
};

const hex4 = (limb: number): string => limb.toString(16).padStart(4, "0");

/**
 * 64-bit FNV-1a over `input`, as 16 lowercase hex digits.
 *
 * The hash state is held as four 16-bit limbs in plain `number`s rather than a
 * `BigInt`. BigInt allocates a heap object per operation, and this runs once per
 * character of the hash input — the limb form measures ~5x faster in isolation
 * (`__bench__/apply-diff-hotpath.bench.ts` benches THIS function, imported, against
 * the BigInt form over a fixed string) and produces bit-identical digests
 * (`__tests__/apply-diff.test.ts` pins the two together over random and boundary
 * inputs, including astral code points and lone surrogates).
 *
 * The FNV-1a prime `0x0000_0100_0000_01b3` has only two non-zero 16-bit limbs
 * (`0x01b3` at limb 0 and `0x0100` at limb 2), so the full 4x4 limb product
 * collapses to the two multiplications per limb below. Every intermediate stays
 * well under 2^32, so `>>> 16` is a valid carry extraction.
 */
const fnv1a64Hex = (input: string): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication; the bit ops ARE the algorithm */
    // Offset basis 0xcbf29ce484222325, low limb first.
    let h0 = 0x23_25;
    let h1 = 0x84_22;
    let h2 = 0x9c_e4;
    let h3 = 0xcb_f2;

    for (let index = 0; index < input.length; index += 1) {
        const point = input.codePointAt(index) ?? 0;

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
    /*
     * Interpolation (not an array of parts) is load-bearing: `table` and `id` are
     * declared `string` but arrive as untyped JSON over the poke protocol, and a
     * template literal coerces a stray number into the digest instead of silently
     * contributing nothing to it — which would make two distinct diffs derive the
     * SAME row key. Covered in `apply-diff-canonical.test.ts`.
     *
     * That fixes type erasure, not value ambiguity: the `::`-joined format still
     * maps `id: 1` and `id: "1"` to one digest, as would an id containing a
     * literal `::`. Both fields are server-generated and row maps are per-table,
     * so this is noted rather than fixed — changing the separator would rewrite
     * every derived id for no reachable benefit.
     */
    const input = `${diff.table}::${diffIdentity}::${String(changeIndex)}::${JSON.stringify(canonicalizeForHash(data))}`;

    return `row-${fnv1a64Hex(input)}`;
};

/**
 * Apply a diff's changes onto `target` **in place**.
 *
 * The copy-on-apply contract lives in the exported {@link applyDiff}; keeping
 * the mutation itself separate lets {@link applyDiffs} fold a whole backlog
 * into one map with a single copy up front instead of one copy per diff.
 */
const applyDiffInto = (target: Map<string, Record<string, unknown>>, diff: TableDiff): void => {
    for (const [changeIndex, change] of diff.changes.entries()) {
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
 * @param snapshot Current snapshot, e.g. `{ users: Map<id, row>, posts: Map<id, row> }`.
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

/*
 * Internals, exported for the bench and test suites ONLY — `src/index.ts` does
 * not re-export them, so they are not package API.
 *
 * They are exported rather than left module-private because the alternative is
 * worse: a bench that hand-copies the function it claims to measure silently
 * becomes a fossil the moment the real one is edited, and then reports "no
 * regression" forever. That is exactly the failure the `lintNamed` guard in
 * `@lunora/advisor`'s bench exists to prevent, so the same standard applies here.
 */
export { canonicalizeForHash, deriveInsertId, fnv1a64Hex };
