import type { ValidatorLike } from "@lunora/do";
import { bench, describe } from "vitest";

import { decodeGlobalRow } from "../src/ctx-db";
import { effectiveColumnKind, sqliteDecode, sqliteEncode } from "../src/value-codec";

/*
 * The encode/decode codec is the per-value floor of every `.global()` table
 * read and write: a page read decodes R rows x M columns, and every insert /
 * patch / replace encodes M columns. Nothing here does I/O, so it is pure CPU
 * on the request path.
 *
 * `decodeGlobalRow` in particular depends on a memoization that is invisible
 * from its call site: the `field -> effective column kind` mapping is derived
 * once per table definition and cached in a WeakMap, because `effectiveColumnKind`
 * has to walk `v.optional(...)` wrappers to find the storage kind. Without the
 * cache every decoded row re-runs `Object.entries(shape)` plus that walk. The
 * `decodeGlobalRow — 100-row page` bench is what makes a regression there
 * visible; `effectiveColumnKind (uncached)` below is the per-column cost the
 * memo is avoiding.
 */

// ---- Fixtures ------------------------------------------------------------

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

/** `v.optional(inner)` — `effectiveColumnKind` must unwrap to `inner` to decode correctly. */
const optionalCol = (innerKind: string): ValidatorLike =>
    ({ _meta: { column: { notNull: false }, inner: { _meta: { column: { notNull: false } }, kind: innerKind } }, kind: "optional" }) as never;

/** A wide-ish table mixing every decode branch: verbatim, boolean, bigint, JSON, and an unwrapped optional. */
const shape: Record<string, ValidatorLike> = {
    archived: col("boolean"),
    attempts: col("bigint"),
    body: col("string"),
    metadata: col("object"),
    note: optionalCol("string"),
    priority: col("number"),
    settings: optionalCol("object"),
    slug: col("string"),
    tags: col("array"),
    updatedAt: col("timestamp"),
};

// `decodeGlobalRow` takes the DO's `TableDefinitionLike`; only `shape` is read
// on the decode path, so the fixture declares what it actually needs and the
// cast lands once, here, rather than being cast out again at each use.
const definition = { indexes: [], shape, shardMode: { kind: "global" } } as never;

const storedRow = (index: number): Record<string, unknown> => {
    return {
        _creationTime: 1_700_000_000_000 + index,
        archived: index % 2,
        attempts: String(index * 1_000_000_007),
        body: `row body number ${String(index)} with some prose in it`,
        id: `notes-${String(index)}`,
        metadata: JSON.stringify({ nested: { a: index, b: [1, 2, 3] }, source: "bench" }),
        note: index % 3 === 0 ? null : `note ${String(index)}`,
        priority: index,
        settings: JSON.stringify({ theme: "dark" }),
        slug: `slug-${String(index)}`,
        tags: JSON.stringify(["alpha", "beta", "gamma"]),
        updatedAt: 1_700_000_000_000 + index,
    };
};

const page = Array.from({ length: 100 }, (_, index) => storedRow(index));
const singleRow = storedRow(0);

const validators = Object.values(shape);

// ---- Benches -------------------------------------------------------------

describe("decodeGlobalRow", () => {
    bench("single row — 10 columns", () => {
        decodeGlobalRow(definition, singleRow);
    });

    bench("100-row page — 10 columns each", () => {
        for (const row of page) {
            decodeGlobalRow(definition, row);
        }
    });
});

describe("sqliteDecode — per-column branches", () => {
    bench("bigint (decimal string)", () => {
        sqliteDecode("9007199254740993", "bigint");
    });

    bench("object (JSON text)", () => {
        sqliteDecode('{"nested":{"a":1,"b":[1,2,3]},"source":"bench"}', "object");
    });

    bench("union (JSON sniff, non-scalar)", () => {
        sqliteDecode('{"a":1}', "union");
    });

    bench("union (JSON sniff, plain scalar)", () => {
        sqliteDecode("just a string", "union");
    });
});

describe("sqliteEncode — per-value branches", () => {
    bench("bigint", () => {
        sqliteEncode(9_007_199_254_740_993n);
    });

    bench("object (JSON.stringify)", () => {
        sqliteEncode({ nested: { a: 1, b: [1, 2, 3] }, source: "bench" });
    });

    bench("bytes (Uint8Array passthrough)", () => {
        sqliteEncode(new Uint8Array([1, 2, 3, 4]));
    });
});

describe("effectiveColumnKind (uncached) — the walk decodeGlobalRow memoizes away", () => {
    bench("whole 10-column shape", () => {
        for (const validator of validators) {
            effectiveColumnKind(validator);
        }
    });
});
