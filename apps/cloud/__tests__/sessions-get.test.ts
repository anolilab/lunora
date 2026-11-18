import { describe, expect, it } from "vitest";

import { get } from "../lunora/sessions";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

const PAGE = 1000;
const ORG = "org_1";

const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([field, value]) => row[field] === value);

/** `findMany` as the store answers it: at most one page, resumed from `cursor`. */
const pagedFindMany =
    (rows: Row[]) =>
    (args?: { cursor?: null | string; where?: Row }): Promise<{ continueCursor: null | string; isDone: boolean; page: Row[] }> => {
        const matching = rows.filter((row) => matches(row, args?.where ?? {}));
        const start = Number(args?.cursor ?? 0);
        const end = start + PAGE;
        const isDone = end >= matching.length;

        return Promise.resolve({ continueCursor: isDone ? null : String(end), isDone, page: matching.slice(start, end) });
    };

const turn = (index: number): Row => {
    return {
        _id: `obs_${String(index)}`,
        durationMs: 1,
        endedAt: index + 1,
        kind: "generation",
        level: "info",
        name: "chat",
        organizationId: ORG,
        sessionId: "sess",
        spanId: `span_${String(index)}`,
        startedAt: index,
        traceId: "trace",
    };
};

describe("sessions.get", () => {
    it("returns every turn of a session longer than one page", async () => {
        expect.assertions(2);

        const observations = Array.from({ length: PAGE + 5 }, (_, index) => turn(index));
        const { ctx } = makeCtx({ members: [owner(ORG)], observations, organizations: [{ _id: ORG }] });

        (ctx.db as unknown as { observations: Record<string, unknown> }).observations["findMany"] = pagedFindMany(observations);

        const turns = await get.handler(ctx, { organizationId: ORG as never, sessionId: "sess" });

        expect(turns).toHaveLength(PAGE + 5);
        expect(turns.at(-1)?.spanId).toBe(`span_${String(PAGE + 4)}`);
    });
});
