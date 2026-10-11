import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { definePrivacy } from "../src/define";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { tasks: {} },
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("tick", () => {
    it("lists a request within seven days of its deadline as approaching", async () => {
        const store = memoryRequests();
        let clock = new Date("2026-04-10T00:00:00.000Z");
        const privacy = definePrivacy({
            datasets: [tasks],
            ports: () => {
                return {
                    data: memoryData({ tasks: 0 }),
                    files: memoryFiles(),
                    newId: () => "r1",
                    now: () => clock,
                    store,
                };
            },
        })(undefined);

        await privacy.requestExport({ subjectId: "u1" });
        // Deadline is 10 May; seven days before it is 3 May.
        clock = new Date(new Date("2026-05-04T00:00:00.000Z"));

        const result = await privacy.tick();

        expect(result.approaching.map((record) => record.id)).toStrictEqual(["r1"]);
        expect(result.overdue).toStrictEqual([]);
    });

    it("lists an unfinished request past its deadline as overdue", async () => {
        const store = memoryRequests();
        let clock = new Date("2026-04-10T00:00:00.000Z");
        const privacy = definePrivacy({
            datasets: [tasks],
            ports: () => {
                return {
                    data: memoryData({ tasks: 0 }),
                    files: memoryFiles(),
                    newId: () => "r2",
                    now: () => clock,
                    store,
                };
            },
        })(undefined);

        await privacy.requestExport({ subjectId: "u1" });
        clock = new Date(new Date("2026-05-10T00:00:00.000Z").getTime() + DAY_MS);

        const result = await privacy.tick();

        expect(result.overdue.map((record) => record.id)).toStrictEqual(["r2"]);
    });

    it("does not list a finished request", async () => {
        const store = memoryRequests();
        const clock = new Date("2026-04-10T00:00:00.000Z");
        const privacy = definePrivacy({
            datasets: [tasks],
            ports: () => {
                return {
                    data: memoryData({ tasks: 0 }),
                    files: memoryFiles(),
                    newId: () => "r3",
                    now: () => clock,
                    store,
                };
            },
        })(undefined);

        await privacy.requestExport({ subjectId: "u1" });
        store.rows.set("r3", { ...store.rows.get("r3")!, status: "completed" });

        await expect(privacy.tick()).resolves.toStrictEqual({ approaching: [], overdue: [] });
    });
});
