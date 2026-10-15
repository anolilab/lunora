import { decodeWire } from "@lunora/wire";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import type { DataPort } from "../src/ports";
import { codeOf, setup } from "./harness";

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { goals: {}, tasks: { omit: ["activeCycle"] } },
});
const quiesced = defineDataset("scheduler", {
    legalBasis: "contract",
    origin: "derived",
    phase: "quiesce",
    purpose: "Scheduled work",
    tables: { jobs: {} },
});

/** Records every call, so a test can check order and content. */
const memoryData = (initial: Record<string, number>, options: { failCollect?: boolean } = {}) => {
    const rows: Record<string, number> = { ...initial };
    const calls: string[] = [];
    const port: DataPort = {
        collect: async (dataset) => {
            calls.push(`collect:${dataset.id}`);

            if (options.failCollect === true) {
                throw new Error("disk full");
            }

            return Object.fromEntries(dataset.tableNames.map((table) => [table, [{ id: `${table}-1` }]]));
        },
        eraseBatch: async (dataset) => {
            calls.push(`erase:${dataset.id}`);
            let hasMore = false;

            for (const table of dataset.tableNames) {
                rows[table] = Math.max(0, (rows[table] ?? 0) - 100);
                hasMore = hasMore || rows[table] > 0;
            }

            return { hasMore };
        },
        remaining: async (dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, rows[table] ?? 0])),
    };

    return { calls, port };
};

const NO_GRACE = { graceDays: 0 };

describe("runExport", () => {
    it("exports a bigint and a bytes column, writing each as the wire codec's tagged leaf", async () => {
        const row = { blob: new Uint8Array([0, 1, 254, 255]).buffer, id: 12_345_678_901_234_567_890n };
        const data: DataPort = {
            ...memoryData({}).port,
            collect: async () => {
                return { goals: [], tasks: [row] };
            },
        };
        const { files, privacy } = setup({ data });
        const opened = await privacy.requestExport();

        await expect(privacy.runExport(opened.id)).resolves.toMatchObject({ status: "ready" });

        const text = new TextDecoder().decode(unzipSync(files.files.get("r1/export.zip") as Uint8Array)["data/tasks/tasks.json"]);

        expect(text).toContain('"12345678901234567890"');
        expect(text).toContain('"AAH+/w=="');
        expect(decodeWire(JSON.parse(text))).toStrictEqual([row]);
    });

    it("collects every dataset and stores the archive and the summary", async () => {
        const { files, privacy } = setup({ data: memoryData({}).port });
        const opened = await privacy.requestExport();
        const outcome = await privacy.runExport(opened.id);

        expect(outcome).toMatchObject({ archiveKey: "r1/export.zip", status: "ready" });
        expect([...files.files.keys()]).toStrictEqual(expect.arrayContaining(["r1/export.zip", "r1/summary.pdf"]));
    });

    it("writes the table rows and a manifest that tags each dataset's articles", async () => {
        const { files, privacy } = setup({ data: memoryData({}).port });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        const extracted = unzipSync(files.files.get("r1/export.zip") as Uint8Array);
        const manifest = JSON.parse(new TextDecoder().decode(extracted["manifest.json"])) as { datasets: { articles: string[]; id: string }[] };

        expect(Object.keys(extracted).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "data/tasks/goals.json",
            "data/tasks/tasks.json",
            "manifest.json",
        ]);
        expect(manifest.datasets[0]).toMatchObject({ articles: ["15", "20"], id: "tasks" });
    });

    it("marks the request failed, and says why, when collection throws", async () => {
        const { files, privacy, store } = setup({ data: memoryData({}, { failCollect: true }).port });
        const opened = await privacy.requestExport();
        const outcome = await privacy.runExport(opened.id);

        expect(outcome.status).toBe("failed");
        expect(store.events).toContain("r1:failed");
        expect(files.files.size).toBe(0);
    });

    it("stops at the next step when the request leaves processing during the run, instead of writing over it", async () => {
        const second = defineDataset("notes", { legalBasis: "contract", origin: "provided", purpose: "Notes", tables: { notes: {} } });
        const { port } = memoryData({});
        let cancel: () => void = () => undefined;
        const interrupting: DataPort = {
            ...port,
            collect: async (dataset, subjectId) => {
                cancel();

                return port.collect(dataset, subjectId);
            },
        };
        const { files, privacy, store } = setup({ data: interrupting, datasets: [tasks, second] });
        const opened = await privacy.requestExport();

        cancel = () => {
            store.rows.set(opened.id, { ...store.rows.get(opened.id)!, status: "cancelled" });
        };

        await expect(privacy.runExport(opened.id)).resolves.toStrictEqual({ status: "cancelled" });
        expect(store.rows.get(opened.id)?.status).toBe("cancelled");
        expect(files.files.has(`${opened.id}/parts/notes.json`)).toBe(false);
    });
});

describe("runErasure", () => {
    it("erases the quiesce dataset before the others", async () => {
        const { calls, port } = memoryData({ goals: 0, jobs: 0, tasks: 0 });
        const { privacy } = setup({ data: port, datasets: [tasks, quiesced], erasure: NO_GRACE });
        const opened = await privacy.requestErasure();

        await privacy.runErasure(opened.id);

        expect(calls.filter((call) => call.startsWith("erase:"))).toStrictEqual(["erase:scheduler", "erase:tasks"]);
    });

    it("completes when every table reads zero afterwards, with one event per phase", async () => {
        const { port } = memoryData({ goals: 150, jobs: 0, tasks: 40 });
        const { privacy, store } = setup({ data: port, datasets: [tasks, quiesced], erasure: NO_GRACE });
        const opened = await privacy.requestErasure();

        await expect(privacy.runErasure(opened.id)).resolves.toStrictEqual({ leftover: [], status: "completed" });
        expect(store.events).toStrictEqual(["r1:received", "r1:processing", "r1:completed"]);
    });

    it("refuses an erasure still inside its grace window", async () => {
        const { privacy, store } = setup();
        const opened = await privacy.requestErasure();

        await expect(privacy.runErasure(opened.id)).rejects.toMatchObject({ code: "UNPROCESSABLE" });
        expect(store.rows.get(opened.id)?.status).toBe("grace");
    });

    it("fails and names the table that still has rows, rather than reporting success", async () => {
        // The verify read reports goals still populated, even though the drain stopped.
        const { port } = memoryData({ goals: 0, jobs: 0, tasks: 0 });
        const stubborn: DataPort = {
            ...port,
            remaining: async () => {
                return { goals: 3, jobs: 0, tasks: 0 };
            },
        };
        const { privacy } = setup({ data: stubborn, datasets: [tasks, quiesced], erasure: NO_GRACE });
        const opened = await privacy.requestErasure();

        await expect(privacy.runErasure(opened.id)).resolves.toStrictEqual({ leftover: ["goals"], status: "failed" });
    });
});

describe("omitted columns", () => {
    it("never writes a column the dataset omits into the archive", async () => {
        const secretDataset = defineDataset("auth", {
            legalBasis: "contract",
            origin: "provided",
            purpose: "Sign-in",
            tables: { session: { omit: ["token"] } },
        });
        const data: DataPort = {
            collect: async () => {
                return { session: [{ id: "s1", token: "live-secret" }] };
            },
            eraseBatch: async () => {
                return { hasMore: false };
            },
            remaining: async () => {
                return { session: 0 };
            },
        };
        const { files, privacy } = setup({ data, datasets: [secretDataset] });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        const archive = unzipSync(files.files.get(`${opened.id}/export.zip`) as Uint8Array);
        const session = new TextDecoder().decode(archive["data/auth/session.json"]);

        expect(session).not.toContain("live-secret");
        expect(session).toContain("s1");
    });
});

describe("run entries", () => {
    it("refuses an export run on an erasure, and an erasure run on an export, without touching either", async () => {
        expect.assertions(4);

        const { privacy, store } = setup();
        const erasure = await privacy.requestErasure();
        const exported = await privacy.requestExport();

        await expect(codeOf(privacy.runExport(erasure.id))).resolves.toBe("UNPROCESSABLE");
        await expect(codeOf(privacy.runErasure(exported.id))).resolves.toBe("UNPROCESSABLE");
        expect(store.rows.get(erasure.id)?.status).toBe("grace");
        expect(store.rows.get(exported.id)?.status).toBe("received");
    });
});
