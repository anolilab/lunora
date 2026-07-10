import { describe, expect, it } from "vitest";

import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import { groupBatchCallsByShard } from "../src/batch";

describe("groupBatchCallsByShard", () => {
    it("groups entries by shardKey, defaulting to the root shard, preserving id + fields", () => {
        expect.assertions(3);

        const groups = groupBatchCallsByShard(
            [
                { args: { a: 1 }, functionPath: "docs:x", id: 0, shardKey: "t1" },
                { functionPath: "docs:y", id: 1 },
                { clientId: "c", clientSeq: 3, functionPath: "docs:z", id: 2, mutationId: "m", shardKey: "t1" },
            ],
            "__root__",
        );

        expect([...groups.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["__root__", "t1"]);
        expect(groups.get("t1")?.map((e) => [e.id, e.functionPath])).toStrictEqual([
            [0, "docs:x"],
            [2, "docs:z"],
        ]);
        expect(groups.get("t1")?.[1]).toStrictEqual({ args: {}, clientId: "c", clientSeq: 3, functionPath: "docs:z", id: 2, mutationId: "m" });
    });

    it("falls back id to the array index when a call omits it", () => {
        expect.assertions(1);

        const groups = groupBatchCallsByShard([{ functionPath: "docs:a" }, { functionPath: "docs:b" }], "__root__");

        expect(groups.get("__root__")?.map((e) => e.id)).toStrictEqual([0, 1]);
    });

    it("rejects a reserved admin / relation prefix with FORBIDDEN", () => {
        expect.assertions(2);

        expect(() => groupBatchCallsByShard([{ functionPath: "__lunora_admin__:getMetrics", id: 0 }], "__root__")).toThrow(
            expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
        );
        expect(() => groupBatchCallsByShard([{ functionPath: "__lunora_relation__:read", id: 0 }], "__root__")).toThrow(
            expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
        );
    });

    it("rejects a non-string functionPath with BAD_REQUEST", () => {
        expect.assertions(1);

        expect(() => groupBatchCallsByShard([{ id: 0 }], "__root__")).toThrow(expect.objectContaining({ code: "BAD_REQUEST", status: 400 }));
    });

    it("rejects a non-object `args` (string/number/array) with BAD_REQUEST, matching the single-call envelope", () => {
        expect.assertions(3);

        // Parity with `parseEnvelope`: a non-object `args` must be a clean 400 at
        // the batch boundary, not forwarded to the shard as a malformed envelope.
        expect(() => groupBatchCallsByShard([{ args: "x", functionPath: "docs:x", id: 0 }], "__root__")).toThrow(
            expect.objectContaining({ code: "BAD_REQUEST", status: 400 }),
        );
        expect(() => groupBatchCallsByShard([{ args: 5, functionPath: "docs:x", id: 0 }], "__root__")).toThrow(
            expect.objectContaining({ code: "BAD_REQUEST", status: 400 }),
        );
        expect(() => groupBatchCallsByShard([{ args: [1, 2], functionPath: "docs:x", id: 0 }], "__root__")).toThrow(
            expect.objectContaining({ code: "BAD_REQUEST", status: 400 }),
        );
    });

    it("rejects a batch over the entry cap with BAD_REQUEST (DoS guard)", () => {
        expect.assertions(1);

        const tooMany = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, index) => {
            return { functionPath: "docs:x", id: index };
        });

        expect(() => groupBatchCallsByShard(tooMany, "__root__")).toThrow(expect.objectContaining({ code: "BAD_REQUEST", status: 400 }));
    });

    it("rejects a null / non-object call entry with BAD_REQUEST instead of a TypeError", () => {
        expect.assertions(3);

        // A JSON `null` in `calls[]` must surface as a clean 400, not a 500 TypeError.
        expect(() => groupBatchCallsByShard([null], "__root__")).toThrow(expect.objectContaining({ code: "BAD_REQUEST", status: 400 }));
        expect(() => groupBatchCallsByShard(["not-an-object"], "__root__")).toThrow(expect.objectContaining({ code: "BAD_REQUEST", status: 400 }));
        expect(() => groupBatchCallsByShard([[{ functionPath: "docs:x" }]], "__root__")).toThrow(expect.objectContaining({ code: "BAD_REQUEST", status: 400 }));
    });
});
