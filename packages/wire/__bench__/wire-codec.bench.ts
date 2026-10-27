import { bench, describe } from "vitest";

import { decodeWire, encodeWire, stableWireKey } from "../src";

// A query result shaped like a typical subscription payload: pure JSON, which is
// what nearly every frame carries, so the plain-object/array path dominates.
const rows = Array.from({ length: 200 }, (_, index) => {
    return {
        _creationTime: 1_700_000_000_000 + index,
        _id: `doc_${String(index).padStart(8, "0")}`,
        author: { id: `user_${String(index % 17)}`, name: "Ada Lovelace" },
        body: "The quick brown fox jumps over the lazy dog",
        done: index % 2 === 0,
        score: index * 1.5,
        tags: ["alpha", "beta", "gamma"],
    };
});

const args = { channel: "general", cursor: null, filter: { done: false, tags: ["alpha"] }, limit: 50 };

const encodedRows = structuredClone(encodeWire(rows));

describe("encodeWire", () => {
    bench("200-row query result", () => {
        encodeWire(rows);
    });

    bench("small args object", () => {
        encodeWire(args);
    });
});

describe("decodeWire", () => {
    bench("200-row query result", () => {
        decodeWire(encodedRows);
    });
});

describe("stableWireKey", () => {
    bench("small args object", () => {
        stableWireKey(args);
    });
});
