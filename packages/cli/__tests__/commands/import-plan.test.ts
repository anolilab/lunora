import { describe, expect, it } from "vitest";

import { exportEndLine } from "../../../../shared/export-end";
import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import type { SourceIndex } from "../../src/commands/data-transfer/import-plan";
import { planImport, recordSourceRow } from "../../src/commands/data-transfer/import-plan";

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
});
