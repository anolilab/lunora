import { describe, expect, it } from "vitest";

import type { QueryCtx } from "../lunora/_generated/server";
import { snapshotRows } from "../lunora/secrets";

type Row = Record<string, unknown>;

/** `findMany` the way D1 answers it: filtered by `where`, then one page of at most 1000 rows. */
const PAGE = 1000;

const queryCtx = (rows: Row[]): QueryCtx =>
    ({
        db: {
            secrets: {
                findMany: ({ where }: { where: Row }) => {
                    const matched = rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));

                    return Promise.resolve({
                        continueCursor: matched.length > PAGE ? "next" : null,
                        isDone: matched.length <= PAGE,
                        page: matched.slice(0, PAGE),
                    });
                },
            },
        },
        now: Date.now(),
    }) as unknown as QueryCtx;

const secretRow = (name: string, environment = "production"): Row => {
    return { ciphertext: `c-${name}`, environment, iv: `iv-${name}`, name, organizationId: "org_1", projectId: "proj_1" };
};

describe("secrets.snapshotRows", () => {
    /** A row the snapshot misses is one the catalog's rollback deletes instead of restoring. */
    it("snapshots a named secret that sits past the project's first page", async () => {
        const filler = Array.from({ length: PAGE }, (_, index) => secretRow(`FILLER_${String(index)}`));
        const context = queryCtx([...filler, secretRow("API_KEY"), secretRow("API_KEY", "all")]);

        const rows = await snapshotRows.handler(context, { names: ["API_KEY"], organizationId: "org_1", projectId: "proj_1" } as never);

        expect(rows.map((row) => `${row.environment}:${row.name}`).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["all:API_KEY", "production:API_KEY"]);
    });
});
