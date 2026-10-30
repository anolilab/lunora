import { describe, expect, it } from "vitest";

import { exportEndLine } from "../../../../shared/export-end";
import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import type { SourceIndex } from "../../src/commands/data-transfer/import-plan";
import { planDestroysRows, planImport, recordSourceRow } from "../../src/commands/data-transfer/import-plan";

const wireRow = (id: string): string => JSON.stringify({ doc: { _id: id }, table: "users" });

const indexOf = (ids: ReadonlyArray<string>): SourceIndex => {
    const index: SourceIndex = new Map();

    for (const id of ids) {
        recordSourceRow(index, wireRow(id));
    }

    return index;
};

const storing = (ids: ReadonlyArray<string>): { baseUrl: string; fetchImpl: StreamingFetchLike; token: string } => {
    const text = `${ids.map((id) => `${wireRow(id)}\n`).join("")}${exportEndLine(ids.length)}`;
    const fetchImpl: StreamingFetchLike = async () => {
        return {
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                },
            }),
            json: async () => undefined,
            ok: true,
            status: 200,
            text: async () => text,
        };
    };

    return { baseUrl: "https://app.example", fetchImpl, token: "t" };
};

describe(planImport, () => {
    it("counts a repeated _id's later copies as overwrites of the first, never as additions", async () => {
        expect.assertions(2);

        // a is stored and repeated; b is new and repeated twice.
        const plan = await planImport(storing(["a"]), indexOf(["a", "a", "b", "b", "b"]), "upsert");

        expect(plan.tables).toStrictEqual([{ add: 1, delete: 0, existing: 4, source: 5, table: "users", target: 1 }]);

        const clean = await planImport(storing(["a"]), indexOf(["a", "b"]), "upsert");

        expect(clean.tables).toStrictEqual([{ add: 1, delete: 0, existing: 1, source: 2, table: "users", target: 1 }]);
    });

    it("asks to confirm an overwrite only when a stored row would be overwritten, not for a file that repeats its own _id", async () => {
        expect.assertions(2);

        const empty = await planImport(storing([]), indexOf(["a", "a"]), "upsert");
        const held = await planImport(storing(["a"]), indexOf(["a"]), "upsert");

        expect(planDestroysRows(empty, "upsert")).toBe(false);
        expect(planDestroysRows(held, "upsert")).toBe(true);
    });

    it("refuses a replace for rows that carry no _id, which the import would write under new ids on every run", async () => {
        expect.assertions(1);

        const index = indexOf(["a"]);

        recordSourceRow(index, JSON.stringify({ doc: { name: "no id" }, table: "users" }));

        await expect(planImport(storing(["a"]), index, "replace")).rejects.toThrow(/carry an _id/u);
    });

    it("keeps no planned deletions when asked not to, and still counts them", async () => {
        expect.assertions(2);

        const plan = await planImport(storing(["a", "z"]), indexOf(["a"]), "replace", false);

        expect(plan.deletions).toStrictEqual([]);
        expect(plan.tables[0]).toMatchObject({ delete: 1 });
    });
});
