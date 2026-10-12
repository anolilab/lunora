import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import type { PrivacyWorkflowContext } from "../src/define";
import { definePrivacy } from "../src/define";
import { eu } from "../src/eu";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const SUBJECT = { sessionAgeMs: 60_000, subjectId: "u1" };

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { goals: {}, tasks: {} },
});

const now = new Date("2026-10-11T10:00:00.000Z");

/** A step runner that runs each step once, in order, and records the step names it saw. */
const fakeStep = (onSleep?: () => void) => {
    const names: string[] = [];
    const step: PrivacyWorkflowContext["step"] = {
        do: async (name, run) => {
            names.push(name);

            return run();
        },
        sleepUntil: async (name) => {
            names.push(`sleep:${name}`);
            onSleep?.();
        },
    };

    return { names, step };
};

const EMPTY_TABLES: Readonly<Record<string, number>> = { goals: 0, tasks: 0 };

const setup = (rows: Readonly<Record<string, number>> = EMPTY_TABLES, failCollect = false) => {
    const store = memoryRequests();
    const files = memoryFiles();
    const data = memoryData(rows);
    const failing = failCollect
        ? {
              ...data,
              collect: async () => {
                  throw new Error("disk full");
              },
          }
        : data;
    let counter = 0;
    const privacy = definePrivacy({
        datasets: [tasks],
        ports: () => {
            return {
                identity: () => SUBJECT,
                data: failing,
                files,
                newId: () => {
                    counter += 1;
                    return `req-${String(counter)}`;
                },
                now: () => now,
                store,
            };
        },
        presets: [eu()],
    })(undefined);

    return { data, files, privacy, store };
};

describe("exportHandler", () => {
    it("runs one collect step per dataset, then assembles, then marks the request ready", async () => {
        const { files, privacy, store } = setup();
        const opened = await privacy.requestExport();
        const { names, step } = fakeStep();

        await privacy.workflows.exportHandler({ params: { requestId: opened.id }, step });

        expect(names).toStrictEqual(["load", "start", "collect:tasks", "assemble", "ready"]);
        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect([...files.files.keys()].some((key) => key.endsWith("export.zip"))).toBe(true);
    });

    it("marks the request failed and records why when a collect step throws", async () => {
        const { privacy, store } = setup({}, true);
        const opened = await privacy.requestExport();
        const { names, step } = fakeStep();

        await privacy.workflows.exportHandler({ params: { requestId: opened.id }, step });

        expect(names).toContain("fail");
        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect(store.events).toContain(`${opened.id}:failed`);
    });
});

describe("erasureHandler", () => {
    it("waits out the grace, then erases every table and completes", async () => {
        const { data, privacy, store } = setup({ goals: 150, tasks: 40 });
        const opened = await privacy.requestErasure();
        const { names, step } = fakeStep();

        await privacy.workflows.erasureHandler({ params: { requestId: opened.id }, step });

        expect(names.slice(0, 3)).toStrictEqual(["load", "sleep:grace", "recheck"]);
        expect(data.rows).toStrictEqual({ goals: 0, tasks: 0 });
        expect(store.rows.get(opened.id)?.status).toBe("completed");
    });

    it("stops without erasing when the subject cancels during the grace", async () => {
        const { data, privacy, store } = setup({ goals: 150, tasks: 40 });
        const opened = await privacy.requestErasure();
        const { names, step } = fakeStep(() => {
            // The subject cancels while the workflow sleeps.
            store.rows.set(opened.id, { ...store.rows.get(opened.id)!, status: "cancelled" });
        });

        await privacy.workflows.erasureHandler({ params: { requestId: opened.id }, step });

        expect(names).not.toContain("start");
        expect(data.rows).toStrictEqual({ goals: 150, tasks: 40 });
        expect(store.rows.get(opened.id)?.status).toBe("cancelled");
    });
});

/** A value after a JSON round trip. `structuredClone` would keep a `Date`, which is the point of the test. */
const throughJson = (value: unknown): unknown => {
    const text = JSON.stringify(value) as string | undefined;

    return text === undefined ? undefined : JSON.parse(text);
};

/** A step runner that stores each result as JSON, as a durable host does, and hands back the parsed copy. */
const jsonStep = () => {
    const sleeps: unknown[] = [];
    const step: PrivacyWorkflowContext["step"] = {
        do: async (_name, run) => {
            const result = await run();

            return throughJson(result) as typeof result;
        },
        sleepUntil: async (_name, when) => {
            sleeps.push(when);
        },
    };

    return { sleeps, step };
};

describe("step results survive a JSON round trip", () => {
    it("sleeps until the grace end as a Date and still completes the erasure", async () => {
        const { data, privacy, store } = setup({ goals: 150, tasks: 40 });
        const opened = await privacy.requestErasure();
        const { sleeps, step } = jsonStep();

        await privacy.workflows.erasureHandler({ params: { requestId: opened.id }, step });

        expect(sleeps).toHaveLength(1);
        expect(sleeps[0]).toBeInstanceOf(Date);
        expect((sleeps[0] as Date).getTime()).toBe(opened.erasureGraceUntil?.getTime());
        expect(data.rows).toStrictEqual({ goals: 0, tasks: 0 });
        expect(store.rows.get(opened.id)?.status).toBe("completed");
    });

    it("returns a load result that is plain JSON, with dates as ISO strings", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestErasure();
        const results: unknown[] = [];

        await privacy.workflows.erasureHandler({
            params: { requestId: opened.id },
            step: {
                do: async (name, run) => {
                    const result = await run();

                    if (name === "load") {
                        results.push(result);
                    }

                    return result;
                },
                sleepUntil: async () => undefined,
            },
        });

        expect(results[0]).toStrictEqual(throughJson(results[0]));
        expect(results[0]).toMatchObject({ erasureGraceUntil: opened.erasureGraceUntil?.toISOString(), receivedAt: now.toISOString() });
    });

    it("runs the export handler to ready", async () => {
        const { privacy, store } = setup();
        const opened = await privacy.requestExport();
        const { step } = jsonStep();

        await privacy.workflows.exportHandler({ params: { requestId: opened.id }, step });

        expect(store.rows.get(opened.id)?.status).toBe("ready");
    });
});
