import { describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server";
import { cleanupExpiredPreviews } from "../lunora/deployments";

type Row = Record<string, unknown>;

/** Fake mutation ctx: a `deployments.findMany` over in-memory rows + a recording `patch`. */
const makeCtx = (rows: Row[]): { ctx: MutationCtx; patched: { id: string; patch: Row }[] } => {
    const patched: { id: string; patch: Row }[] = [];

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: null },
        db: {
            deployments: {
                findMany: (args?: { where?: Row }) => {
                    const where = args?.where ?? {};
                    const page = rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));

                    return Promise.resolve({ page });
                },
            },
            patch: (id: string, patch: Row) => {
                patched.push({ id, patch });

                return Promise.resolve();
            },
        },
        log: {},
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return { ctx, patched };
};

describe("deployments.cleanupExpiredPreviews", () => {
    it("destroys only expired, not-yet-destroyed previews", async () => {
        const now = Date.now();
        const { ctx, patched } = makeCtx([
            { _id: "live_expired", expiresAt: now - 1000, kind: "preview", status: "live" },
            { _id: "queued_expired", expiresAt: now - 1, kind: "preview", status: "queued" },
            { _id: "not_expired", expiresAt: now + 100_000, kind: "preview", status: "live" },
            { _id: "already_destroyed", expiresAt: now - 1000, kind: "preview", status: "destroyed" },
            { _id: "no_expiry", kind: "preview", status: "live" },
        ]);

        const result = await cleanupExpiredPreviews.handler(ctx, {});

        expect(result).toStrictEqual({ destroyed: 2 });
        expect(patched.map((entry) => entry.id).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["live_expired", "queued_expired"]);
        expect(patched.every((entry) => entry.patch["status"] === "destroyed")).toBe(true);
    });

    it("is a no-op when nothing is expired", async () => {
        const now = Date.now();
        const { ctx, patched } = makeCtx([{ _id: "fresh", expiresAt: now + 100_000, kind: "preview", status: "live" }]);

        const result = await cleanupExpiredPreviews.handler(ctx, {});

        expect(result).toStrictEqual({ destroyed: 0 });
        expect(patched).toHaveLength(0);
    });
});
