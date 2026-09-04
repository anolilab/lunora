import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createBetterSqlite3Adapter } from "../src/adapters/better-sqlite3";
import { applyDiff } from "../src/apply-diff";
import { applyDiffToDb } from "../src/diff-applier";
import type { TableDiff } from "../src/table-diff";

/*
 * Determinism suite for the canonical hash encoding behind `deriveInsertId`.
 *
 * Derived row ids are persisted and replayed, so an encoding that varies with
 * anything other than the row's content forks replicas rather than throwing.
 * These tests drive thousands of randomly generated payloads through the public
 * `applyDiff` and assert the two properties that actually matter:
 *
 *  1. The same value always derives the same id, however its keys were ordered
 *     on the way in (at any nesting depth).
 *  2. Values that differ derive different ids.
 *
 * The encoding itself is `JSON.stringify` over a key-sorted copy, so there is no
 * hand-rolled escaping to pin — `JSON.stringify`'s own rules for `undefined`,
 * `NaN`, `-0`, `toJSON`, and string escaping apply unchanged. The sort CHOICE
 * (code unit, not locale) is covered in `apply-diff.test.ts`.
 */

const diffOf = (data: Record<string, unknown>, id = "d"): TableDiff => {
    return { changes: [{ data, type: "insert" }], id, table: "t", timestamp: 1 };
};

const derived = (data: Record<string, unknown>, id = "d"): string => {
    const rows = applyDiff(new Map(), diffOf(data, id));

    return [...rows.keys()][0] as string;
};

// Deterministic PRNG so a failure reproduces. The state lives in the closure
// rather than a module-level `let`, so nothing else in the file can perturb the
// sequence.
const makeRandom = (initialSeed: number): (() => number) => {
    let seed = initialSeed;

    return (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

        return seed / 2_147_483_648;
    };
};

const rnd = makeRandom(12_345);

const KEYS = ["a", "B", "_x", "z", "Ä", "0", "10", "2", "toString", "a-b", "a_b"];

const randomValue = (depth: number): unknown => {
    const roll = rnd();

    if (depth > 3 || roll < 0.3) {
        const leaf = rnd();

        if (leaf < 0.2) {
            return null;
        }

        if (leaf < 0.4) {
            return Math.floor(rnd() * 1000);
        }

        if (leaf < 0.55) {
            return rnd() < 0.5;
        }

        if (leaf < 0.75) {
            return `str "quoted" \\ back\n\t${Math.floor(rnd() * 1000)}`;
        }

        return "🎉 emoji \u{10FFFF}";
    }

    if (roll < 0.65) {
        return Array.from({ length: Math.floor(rnd() * 5) }, () => randomValue(depth + 1));
    }

    const record: Record<string, unknown> = {};

    for (let index = 0; index < Math.floor(rnd() * 6); index += 1) {
        record[KEYS[Math.floor(rnd() * KEYS.length)] as string] = randomValue(depth + 1);
    }

    return record;
};

/** Rebuild `value` with every object's keys reversed, at every depth. */
const withReversedKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => withReversedKeys(item));
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};

        for (const key of Object.keys(record).toReversed()) {
            result[key] = withReversedKeys(record[key]);
        }

        return result;
    }

    return value;
};

describe("derived id determinism", () => {
    it("is insensitive to key insertion order across 2000 random payloads", () => {
        expect.hasAssertions();

        for (let index = 0; index < 2000; index += 1) {
            const value: unknown = randomValue(1);
            const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
            const payload = isPlainObject ? (value as Record<string, unknown>) : { wrapped: value };
            const reordered = withReversedKeys(payload) as Record<string, unknown>;

            expect(derived(payload), `mismatch at ${String(index)} for ${JSON.stringify(payload)}`).toBe(derived(reordered));
        }
    });

    it("derives distinct ids for distinct payloads", () => {
        expect.hasAssertions();

        const seen = new Map<string, string>();
        const collisions: [string, string, string][] = [];

        for (let index = 0; index < 2000; index += 1) {
            const value: unknown = randomValue(1);
            const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
            const payload = isPlainObject ? (value as Record<string, unknown>) : { wrapped: value };
            // Canonical form, so two payloads differing only in key order count as one.
            const encoding = JSON.stringify(payload, Object.keys(payload).sort());
            const id = derived(payload);

            // Record the first encoding seen for each id; a genuine collision
            // shows up as two DIFFERENT encodings under one id. Collected rather
            // than asserted inline so the assertion stays unconditional.
            collisions.push([id, seen.get(id) ?? encoding, encoding]);
            seen.set(id, seen.get(id) ?? encoding);
        }

        expect(collisions.filter(([, first, current]) => first !== current)).toStrictEqual([]);
    });

    it("keeps the table name — and only the table name — outside the row data", () => {
        expect.hasAssertions();

        const data = { name: "alice" };

        // The diff that CARRIED the row is not part of its identity. It used to
        // be, and since `subscribeToMirror` stamps each frame with `Date.now()`,
        // a re-emitted un-keyed row landed under a fresh key every frame.
        expect(derived(data, "diff-a")).toBe(derived(data, "diff-b"));

        // Same for a non-string id arriving from untyped wire JSON.
        const numericA = applyDiff(new Map(), { changes: [{ data, type: "insert" }], id: 5 as never, table: "t", timestamp: 1 });
        const numericB = applyDiff(new Map(), { changes: [{ data, type: "insert" }], id: 7 as never, table: "t", timestamp: 1 });

        expect([...numericA.keys()]).toStrictEqual([...numericB.keys()]);

        // The table still separates, including as a non-string from wire JSON.
        const tableA = applyDiff(new Map(), { changes: [{ data, type: "insert" }], id: "d", table: 1 as never, timestamp: 1 });
        const tableB = applyDiff(new Map(), { changes: [{ data, type: "insert" }], id: "d", table: 2 as never, timestamp: 1 });

        expect([...tableA.keys()]).not.toStrictEqual([...tableB.keys()]);
    });
});

/*
 * Wire-typed leaves. `deriveInsertId` is handed rows that came off the poke
 * protocol, so `decodeWire` has already turned tagged tokens back into real
 * `bigint` / `Date` / `Map` / `Set` / `URL` / `ArrayBuffer` / typed-array
 * values. Hashing the DECODED tree is what these pin: the encoding must keep
 * apart what the wire keeps apart, and must not throw on a value the wire
 * carries — a collision lands two unrelated rows on one mirror key, and a
 * throw inside `applyDiffToDb`'s transaction discards the whole batch.
 */
describe("derived ids over decoded wire values", () => {
    it("separates distinct wire-typed values that a JSON encoding flattens to {}", () => {
        expect.hasAssertions();

        // None of these has an own enumerable key, so a JSON encoding of the
        // decoded tree renders every one of them as `{}` — one content hash,
        // one derived id, and the upsert this derivation exists for lands them
        // all on the SAME mirror row.
        const flattened: [label: string, data: Record<string, unknown>][] = [
            ["date", { v: new Date("2020-01-01T00:00:00.000Z") }],
            ["later date", { v: new Date("2021-06-05T12:00:00.000Z") }],
            ["url", { v: new URL("https://example.test/a") }],
            ["map", { v: new Map([["a", 1]]) }],
            ["other map", { v: new Map([["b", 2]]) }],
            ["set", { v: new Set([1, 2]) }],
            ["8-byte buffer", { v: new ArrayBuffer(8) }],
            ["16-byte buffer", { v: new ArrayBuffer(16) }],
            ["empty object", { v: {} }],
        ];

        const byId = new Map<string, string>();

        for (const [label, data] of flattened) {
            const id = derived(data);

            byId.set(id, byId.has(id) ? `${byId.get(id) as string} + ${label}` : label);
        }

        expect([...byId.values()].filter((labels) => labels.includes(" + "))).toStrictEqual([]);
    });

    it("separates a typed array from the plain object carrying the same indices", () => {
        expect.assertions(2);

        expect(derived({ v: new Uint8Array([1, 2]) })).not.toBe(derived({ v: { 0: 1, 1: 2 } }));
        expect(derived({ v: new Uint8Array([1, 2]) })).not.toBe(derived({ v: new Float32Array([1, 2]) }));
    });

    it("separates the non-finite numbers a JSON encoding collapses onto null", () => {
        expect.assertions(3);

        expect(derived({ v: Number.NaN })).not.toBe(derived({ v: null }));
        expect(derived({ v: Infinity })).not.toBe(derived({ v: null }));
        expect(derived({ v: Infinity })).not.toBe(derived({ v: -Infinity }));
    });

    it("derives an id for a bigint column instead of throwing", () => {
        expect.assertions(2);

        // `decodeWire` hands back a real `bigint` for an int64 column. Both apply
        // paths check only the KEY field for one, so a bigint in any other column
        // of an un-keyed row reaches the digest.
        expect(() => derived({ total: 1n })).not.toThrow();
        expect(derived({ total: 1n })).not.toBe(derived({ total: 1 }));
    });

    it("lands an un-keyed row on the same key through both apply paths", () => {
        expect.assertions(2);

        // The in-memory map and the SQLite mirror derive through the SAME
        // function, so a row that reaches both must land under one key —
        // otherwise a client holding both would hold the row twice.
        const data = { at: new Date("2020-01-01T00:00:00.000Z"), label: "aggregate", total: 7n };
        const diff: TableDiff = { changes: [{ data, type: "insert" }], id: "d", table: "t", timestamp: 1 };

        const database = createBetterSqlite3Adapter(new Database(":memory:"));

        database.exec("CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, at TEXT, label TEXT, total INTEGER)");
        applyDiffToDb(database, diff);

        const stored = database.query<{ id: string }>("SELECT id FROM t");

        expect(stored).toHaveLength(1);
        expect([...applyDiff(new Map(), diff).keys()]).toStrictEqual([stored[0]?.id]);
    });
});
