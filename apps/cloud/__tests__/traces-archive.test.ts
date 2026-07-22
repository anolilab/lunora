import { describe, expect, it } from "vitest";

import type { ActionCtx, QueryCtx } from "../lunora/_generated/server";
import { getArchived, list as listTraces } from "../lunora/traces";

type Row = Record<string, unknown>;

/** A member row so `assertMember` passes for `u1`/`org_1`. */
const memberDb = {
    members: {
        findMany: ({ where }: { where: Row }) =>
            Promise.resolve({
                page: where.organizationId === "org_1" && where.userId === "u1" ? [{ _id: "m1", organizationId: "org_1", role: "owner", userId: "u1" }] : [],
            }),
    },
};

/** One archived span row, as the R2-SQL read returns it (a flat `spanArchiveRecord`). */
const archivedRow: Row = {
    durationMs: 100,
    endedAt: 1100,
    kind: "worker",
    level: "info",
    name: "messages:send",
    organizationId: "org_1",
    recordType: "span",
    spanId: "s1",
    startedAt: 1000,
    traceId: "t_old",
};

/** A fetch double that answers the R2-SQL query with `rows`, matching the `{ result: { rows } }` envelope. */
const fakeFetch = (rows: Row[]): typeof globalThis.fetch =>
    (async () =>
        new Response(JSON.stringify({ result: { rows } }), {
            headers: { "content-type": "application/json" },
            status: 200,
        })) as unknown as typeof globalThis.fetch;

/** Build a fake action ctx: member auth + an env (R2 config) + an injected fetch. */
const makeCtx = (options: { env?: Row; fetch?: typeof globalThis.fetch }): ActionCtx =>
    ({
        auth: { getIdentity: () => Promise.resolve(null), userId: "u1" },
        db: memberDb,
        env: options.env,
        fetch: options.fetch ?? globalThis.fetch,
    }) as unknown as ActionCtx;

describe("traces.getArchived (D1-empty fallback)", () => {
    it("reads a trace's spans back from the columnar archive when R2 SQL is configured", async () => {
        const ctx = makeCtx({
            env: { CLOUDFLARE_ACCOUNT_ID: "acc_1", R2_SQL_TOKEN: "tok", TELEMETRY_BUCKET_NAME: "bucket" },
            fetch: fakeFetch([archivedRow]),
        });

        const spans = await getArchived.handler(ctx, { organizationId: "org_1" as never, traceId: "t_old" });

        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({ durationMs: 100, name: "messages:send", spanId: "s1", traceId: "t_old" });
        // The wire view drops the archive-only `serviceName`/`recordType`/`organizationId`.
        expect("recordType" in spans[0]).toBe(false);
        expect("organizationId" in spans[0]).toBe(false);
    });

    it("fails open to [] when R2 SQL is not configured (no ctx.env)", async () => {
        const ctx = makeCtx({ fetch: fakeFetch([archivedRow]) });

        await expect(getArchived.handler(ctx, { organizationId: "org_1" as never, traceId: "t_old" })).resolves.toStrictEqual([]);
    });

    it("still requires membership (rejects a non-member)", async () => {
        const ctx = makeCtx({ env: { CLOUDFLARE_ACCOUNT_ID: "acc_1", R2_SQL_TOKEN: "tok", TELEMETRY_BUCKET_NAME: "bucket" } });

        await expect(getArchived.handler(ctx, { organizationId: "org_2" as never, traceId: "t_old" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});

/** A span row in a trace, as `observations.findMany` returns it. */
const span = (traceId: string, startedAt: number): Row => ({
    _id: `obs_${traceId}_${String(startedAt)}`,
    durationMs: 10,
    endedAt: startedAt + 10,
    kind: "worker",
    level: "info",
    name: `${traceId}:root`,
    organizationId: "org_1",
    spanId: `s_${traceId}_${String(startedAt)}`,
    startedAt,
    traceId,
});

describe("traces.list (time-range window threads through as from/to)", () => {
    const listCtx = (rows: Row[]): QueryCtx =>
        ({
            auth: { getIdentity: () => Promise.resolve(null), userId: "u1" },
            db: {
                ...memberDb,
                observations: { findMany: () => Promise.resolve({ page: rows }) },
            },
        }) as unknown as QueryCtx;

    it("keeps only traces that start within the [from, to] window", async () => {
        const ctx = listCtx([span("t_old", 1000), span("t_mid", 5000), span("t_new", 9000)]);

        const traces = await listTraces.handler(ctx, { from: 4000, organizationId: "org_1" as never, to: 6000 });

        expect(traces.map((trace) => trace.traceId)).toStrictEqual(["t_mid"]);
    });
});
