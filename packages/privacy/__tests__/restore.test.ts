import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { definePrivacy } from "../src/define";
import type { TombstonePort } from "../src/tombstones";
import { tombstoneKeyOf } from "../src/tombstones";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const SUBJECT = { sessionAgeMs: 60_000, subjectId: "u1" };
const SECRET = "test-tombstone-secret";

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

/** `null` leaves the secret out of the config, as an app that never set it would. */
const build = (tombstones?: TombstonePort, tombstoneSecret: string | null = SECRET) => {
    const data = memoryData({ tasks: 150 });
    const store = memoryRequests();
    let counter = 0;
    const privacy = definePrivacy({
        datasets: [tasks],
        ports: () => {
            return {
                identity: () => SUBJECT,
                data,
                files: memoryFiles(),
                newId: () => {
                    counter += 1;
                    return `r${String(counter)}`;
                },
                now: () => new Date("2026-10-11T10:00:00.000Z"),
                store,
                ...(tombstones === undefined ? {} : { tombstones }),
            };
        },
        ...(tombstoneSecret === null ? {} : { tombstoneSecret }),
    })(undefined);

    return { data, privacy, store };
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
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(privacy, opened.id);

        expect(tombstones.stored.has(tombstoneKeyOf("u1", SECRET))).toBe(true);
    });

    it("erases again a subject restored from a backup taken before their erasure", async () => {
        const tombstones = memoryTombstones();
        const { data, privacy } = build(tombstones);
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(privacy, opened.id);
        // The backup brings the rows back.
        data.rows.tasks = 150;

        await expect(privacy.restore({ restoredSubjectIds: ["u1", "u2"] })).resolves.toStrictEqual(["u1"]);
        expect(data.rows.tasks).toBe(0);
    });

    it("refuses to restore without the tombstone secret", async () => {
        const { privacy } = build(memoryTombstones(), null);

        await expect(privacy.restore({ restoredSubjectIds: ["u1"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("fails an erasure before erasing anything when the tombstone secret is missing", async () => {
        const tombstones = memoryTombstones();
        const { data, privacy, store } = build(tombstones, "");
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(privacy, opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect(data.rows.tasks).toBe(150);
        expect(tombstones.stored.size).toBe(0);
    });

    it("refuses the direct erasure entry without the tombstone secret", async () => {
        const { data, privacy, store } = build(memoryTombstones(), null);
        const opened = await privacy.requestErasure();

        store.rows.set(opened.id, { ...store.rows.get(opened.id)!, status: "received" });

        await expect(privacy.runErasure(opened.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(data.rows.tasks).toBe(150);
    });

    it("refuses to restore without a tombstone store", async () => {
        const { privacy } = build();

        await expect(privacy.restore({ restoredSubjectIds: ["u1"] })).rejects.toBeInstanceOf(LunoraError);
    });
});
