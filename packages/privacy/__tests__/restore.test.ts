import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { definePrivacy } from "../src/define";
import type { TombstonePort } from "../src/tombstones";
import { tombstoneKeyOf } from "../src/tombstones";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { tasks: {} },
});

const memoryTombstones = (): TombstonePort & { stored: Map<string, Date> } => {
    const stored = new Map<string, Date>();

    return {
        add: async (key, erasedAt) => {
            stored.set(key, erasedAt);
        },
        keys: async () => new Set(stored.keys()),
        stored,
    };
};

const build = (tombstones?: TombstonePort) => {
    const data = memoryData({ tasks: 150 });
    let counter = 0;
    const privacy = definePrivacy({
        datasets: [tasks],
        ports: () => {
            return {
                data,
                files: memoryFiles(),
                newId: () => {
                    counter += 1;
                    return `r${String(counter)}`;
                },
                now: () => new Date("2026-10-11T10:00:00.000Z"),
                store: memoryRequests(),
                ...(tombstones === undefined ? {} : { tombstones }),
            };
        },
    })(undefined);

    return { data, privacy };
};

/** Run the erasure workflow to the end, with each step run inline. The grace sleep is skipped for the test. */
const runErasureWorkflow = (
    privacy: {
        workflows: {
            erasureHandler: (context: {
                params: { requestId: string };
                step: { do: <T>(name: string, run: () => Promise<T>) => Promise<T>; sleepUntil: (name: string, when: Date) => Promise<void> };
            }) => Promise<void>;
        };
    },
    requestId: string,
): Promise<void> =>
    privacy.workflows.erasureHandler({
        params: { requestId },
        step: {
            do: async (_name, run) => run(),
            sleepUntil: async () => undefined,
        },
    });

describe("restore", () => {
    it("tombstones a subject once their erasure completes", async () => {
        const tombstones = memoryTombstones();
        const { privacy } = build(tombstones);
        const opened = await privacy.requestErasure({ sessionAgeMs: 1000, subjectId: "u1" });

        await runErasureWorkflow(privacy, opened.id);

        expect(tombstones.stored.has(tombstoneKeyOf("u1"))).toBe(true);
    });

    it("erases again a subject restored from a backup taken before their erasure", async () => {
        const tombstones = memoryTombstones();
        const { data, privacy } = build(tombstones);
        const opened = await privacy.requestErasure({ sessionAgeMs: 1000, subjectId: "u1" });

        await runErasureWorkflow(privacy, opened.id);
        // The backup brings the rows back.
        data.rows.tasks = 150;

        await expect(privacy.restore({ restoredSubjectIds: ["u1", "u2"] })).resolves.toStrictEqual(["u1"]);
        expect(data.rows.tasks).toBe(0);
    });

    it("refuses to restore without a tombstone store", async () => {
        const { privacy } = build();

        await expect(privacy.restore({ restoredSubjectIds: ["u1"] })).rejects.toBeInstanceOf(LunoraError);
    });
});
