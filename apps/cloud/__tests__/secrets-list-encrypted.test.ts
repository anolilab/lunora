import { describe, expect, it, vi } from "vitest";

import type { QueryCtx } from "../lunora/_generated/server";
import { listEncrypted } from "../lunora/secrets";

// The role and ownership checks are covered elsewhere; this test is about which rows the deploy gets.
vi.mock(import("../lunora/authz"), async (importOriginal) => {
    return {
        ...(await importOriginal()),
        assertMember: vi.fn<(...args: unknown[]) => Promise<never>>(async () => undefined as never),
        assertRowInOrg: vi.fn<(...args: unknown[]) => Promise<never>>(async () => undefined as never),
    };
});

type Row = Record<string, unknown>;

/** `findMany` the way D1 answers it: filtered by `where`, then pages of at most 1000 rows, resumed by cursor. */
const PAGE = 1000;

const queryCtx = (rows: Row[]): QueryCtx =>
    ({
        db: {
            secrets: {
                findMany: ({ cursor, where }: { cursor?: null | string; where: Row }) => {
                    const matched = rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
                    const start = cursor ? Number(cursor) : 0;
                    const end = start + PAGE;

                    return Promise.resolve({
                        continueCursor: end < matched.length ? String(end) : null,
                        isDone: end >= matched.length,
                        page: matched.slice(start, end),
                    });
                },
            },
        },
        now: Date.now(),
    }) as unknown as QueryCtx;

const secretRow = (name: string): Row => {
    return { ciphertext: `c-${name}`, environment: "production", iv: `iv-${name}`, name, organizationId: "org_1", projectId: "proj_1" };
};

describe("secrets.listEncrypted", () => {
    /** A secret the list misses is one the deployed Worker never receives. */
    it("hands the deploy a secret that sits past the project's first page", async () => {
        const filler = Array.from({ length: PAGE }, (_, index) => secretRow(`FILLER_${String(index)}`));
        const context = queryCtx([...filler, secretRow("API_KEY")]);

        const rows = await listEncrypted.handler(context, { environment: "production", organizationId: "org_1", projectId: "proj_1" } as never);

        expect(rows).toHaveLength(PAGE + 1);
        expect(rows.map((row) => row.name)).toContain("API_KEY");
    });
});
