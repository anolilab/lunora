/**
 * The SQL store's retention sweep on workerd's real `SqlStorage`, where a bare
 * double-quoted name or a DELETE-with-LIMIT shape can behave differently from
 * `node:sqlite`. Two things are checked: the planner finds expired rows through the
 * `ts` index rather than a table scan, and the sweep actually deletes them.
 *
 * The config is the `login` fixed window in `test-worker.ts` (60 s period, rate 1),
 * whose horizon is `period * (2 + capacity / rate)` = 180 s.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const NOW = 1_700_000_000_000;
const RETENTION = 180_000;

const freshStub = () => env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(`sql-retention-${crypto.randomUUID()}`));

describe("sql store retention on workerd", () => {
    it("finds expired rows through the ts index, not a table scan", async () => {
        expect.assertions(2);

        const stub = freshStub();

        // The first write creates the table and its partial index.
        await stub.sqlConsumeAt("warm", NOW);

        const plan = await stub.sqlSweepPlan();

        expect(plan.join("\n")).toContain("_lunora_rate_limits_ts");
        expect(plan.some((detail) => detail.startsWith("SCAN "))).toBe(false);
    });

    it("deletes at most 32 expired rows per write and keeps the live ones", async () => {
        expect.assertions(2);

        const stub = freshStub();

        for (let index = 0; index < 40; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential writes keep the fixture deterministic
            await stub.sqlConsumeAt(`old-${String(index)}`, NOW);
        }

        // Past the horizon: this write sweeps 32 of the 40 and adds its own row.
        await stub.sqlConsumeAt("trigger-1", NOW + RETENTION + 1);

        await expect(stub.sqlRowCount()).resolves.toBe(9);

        // The remaining 8 expired rows go; `trigger-1` is inside the horizon now and stays.
        await stub.sqlConsumeAt("trigger-2", NOW + RETENTION + 1);

        await expect(stub.sqlRowCount()).resolves.toBe(2);
    });
});
