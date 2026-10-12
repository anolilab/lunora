import { describe, expect, it } from "vitest";

import { DAY_MS, setup } from "./harness";

describe("tick", () => {
    it("lists a request within seven days of its deadline as approaching", async () => {
        const { operator, privacy, setClock } = setup({ now: new Date("2026-04-10T00:00:00.000Z") });

        await privacy.requestExport();
        // Deadline is 10 May; seven days before it is 3 May.
        setClock(new Date("2026-05-04T00:00:00.000Z"));

        const result = await operator.tick();

        expect(result.approaching.map((record) => record.id)).toStrictEqual(["r1"]);
        expect(result.overdue).toStrictEqual([]);
    });

    it("lists an unfinished request past its deadline as overdue", async () => {
        const { operator, privacy, setClock } = setup({ now: new Date("2026-04-10T00:00:00.000Z") });

        await privacy.requestExport();
        setClock(new Date(new Date("2026-05-10T00:00:00.000Z").getTime() + DAY_MS));

        const result = await operator.tick();

        expect(result.overdue.map((record) => record.id)).toStrictEqual(["r1"]);
    });

    it("does not list a finished request", async () => {
        const { operator, privacy, store } = setup({ now: new Date("2026-04-10T00:00:00.000Z") });

        await privacy.requestExport();
        store.rows.set("r1", { ...store.rows.get("r1")!, status: "completed" });

        await expect(operator.tick()).resolves.toStrictEqual({ approaching: [], overdue: [] });
    });
});

describe("tick on a finished export", () => {
    it("lists a ready export as neither approaching nor overdue, since the response was given", async () => {
        const { operator, privacy, setClock } = setup({ now: new Date("2026-04-10T00:00:00.000Z") });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        setClock(new Date("2026-05-05T00:00:00.000Z"));

        await expect(operator.tick()).resolves.toStrictEqual({ approaching: [], overdue: [] });

        // Past the deadline, but before the sweep has expired it.
        setClock(new Date("2026-05-11T00:00:00.000Z"));

        await expect(operator.tick()).resolves.toStrictEqual({ approaching: [], overdue: [] });
    });
});
