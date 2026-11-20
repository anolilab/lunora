import { describe, expect, it } from "vitest";

import { create } from "../lunora/organizations";
import { makeCtx } from "./_helpers/fake-ctx";

/**
 * `organizations.create` with an explicit `cellId` used to check only that the
 * cell was active, so a caller asking for `jurisdiction: "eu"` could still land
 * the organization on a US cell by naming it.
 */
const cells = [
    { _id: "cell_us", jurisdiction: "us", status: "active" },
    { _id: "cell_eu", jurisdiction: "eu", status: "active" },
];

describe("organizations.create", () => {
    it("rejects an explicit cell outside the requested jurisdiction and inserts nothing", async () => {
        const { ctx, ops } = makeCtx({ cells, organizations: [] });

        await expect(create.handler(ctx, { cellId: "cell_us", jurisdiction: "eu", name: "Acme", slug: "acme" } as never)).rejects.toMatchObject({
            code: "UNPROCESSABLE",
        });
        expect(ops.filter((op) => op.kind === "insert" && op.table === "organizations")).toStrictEqual([]);
    });

    it("accepts an explicit cell inside the requested jurisdiction", async () => {
        const { ctx, ops } = makeCtx({ cells, organizations: [] });

        await create.handler(ctx, { cellId: "cell_eu", jurisdiction: "eu", name: "Acme", slug: "acme" } as never);

        expect(ops).toContainEqual(
            expect.objectContaining({ document: expect.objectContaining({ cellId: "cell_eu" }), kind: "insert", table: "organizations" }),
        );
    });
});
