import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import type { RequestRecord, RequestStore } from "../src/requests";
import type { RetentionRule } from "../src/rules";
import type { DataPort, RunContext, StorePort } from "../src/run";
import { runErasure, runExport } from "../src/run";

const now = new Date("2026-10-11T10:00:00.000Z");

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

const memoryRequests = (): RequestStore & { events: string[]; rows: Map<string, RequestRecord> } => {
    const rows = new Map<string, RequestRecord>();
    const events: string[] = [];

    return {
        addEvent: async (requestId, _at, kind) => {
            events.push(`${requestId}:${kind}`);
        },
        events,
        findOpen: async () => undefined,
        get: async (id) => rows.get(id),
        listOpen: async () => [...rows.values()],
        insert: async (record) => {
            rows.set(record.id, record);
        },
        rows,
        update: async (id, patch) => {
            rows.set(id, { ...rows.get(id)!, ...patch });
        },
    };
};

const memoryFiles = (): StorePort & { files: Map<string, Uint8Array | string> } => {
    const files = new Map<string, Uint8Array | string>();

    return {
        files,
        put: async (requestId, file) => {
            files.set(`${requestId}/${file.name}`, file.data);

            return `${requestId}/${file.name}`;
        },
        read: async (requestId, name) => {
            const value = files.get(`${requestId}/${name}`);

            return typeof value === "string" ? value : undefined;
        },
        signedUrl: async (key, ttlSeconds) => `https://files.test/${key}?ttl=${String(ttlSeconds)}`,
    };
};

const contextFor = (data: DataPort, requests: RequestStore, files: StorePort): RunContext => {
    return {
        data,
        files,
        now: () => now,
        rules: new Map<string, RetentionRule>(),
        store: requests,
        subjectKey: "subject-1",
    };
};

const request = (overrides: Partial<RequestRecord> = {}): RequestRecord => {
    return {
        dueAt: new Date("2026-11-11T10:00:00.000Z"),
        id: "r1",
        receivedAt: now,
        status: "received",
        subjectId: "u1",
        type: "export",
        ...overrides,
    };
};

describe(runExport, () => {
    it("collects every dataset and stores the archive and the summary", async () => {
        const requests = memoryRequests();
        const files = memoryFiles();
        const { port } = memoryData({});

        requests.rows.set("r1", request());
        const outcome = await runExport(contextFor(port, requests, files), [tasks], request());

        expect(outcome).toMatchObject({ archiveKey: "r1/export.zip", status: "ready" });
        expect([...files.files.keys()]).toStrictEqual(expect.arrayContaining(["r1/export.zip", "r1/summary.pdf"]));
    });

    it("writes the table rows and a manifest that tags each dataset's articles", async () => {
        const requests = memoryRequests();
        const files = memoryFiles();
        const { port } = memoryData({});

        requests.rows.set("r1", request());
        await runExport(contextFor(port, requests, files), [tasks], request());

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
        const requests = memoryRequests();
        const files = memoryFiles();
        const { port } = memoryData({}, { failCollect: true });

        requests.rows.set("r1", request());
        const outcome = await runExport(contextFor(port, requests, files), [tasks], request());

        expect(outcome.status).toBe("failed");
        expect(requests.events).toContain("r1:failed");
        expect(files.files.size).toBe(0);
    });
});

describe(runErasure, () => {
    it("erases the quiesce dataset before the others", async () => {
        const requests = memoryRequests();
        const { calls, port } = memoryData({ goals: 0, jobs: 0, tasks: 0 });

        requests.rows.set("r2", request({ status: "processing", type: "erasure" }));
        await runErasure(contextFor(port, requests, memoryFiles()), [tasks, quiesced], request({ id: "r2", status: "grace", type: "erasure" }));

        expect(calls.filter((call) => call.startsWith("erase:"))).toStrictEqual(["erase:scheduler", "erase:tasks"]);
    });

    it("completes when every table reads zero afterwards", async () => {
        const requests = memoryRequests();
        const { port } = memoryData({ goals: 150, jobs: 0, tasks: 40 });

        requests.rows.set("r2", request({ status: "grace", type: "erasure" }));
        const outcome = await runErasure(contextFor(port, requests, memoryFiles()), [tasks, quiesced], request({ id: "r2", status: "grace", type: "erasure" }));

        expect(outcome).toStrictEqual({ leftover: [], status: "completed" });
        expect(requests.events).toContain("r2:completed");
    });

    it("fails and names the table that still has rows, rather than reporting success", async () => {
        const requests = memoryRequests();
        // The verify read reports goals still populated, even though the drain stopped.
        const data = memoryData({ goals: 0, jobs: 0, tasks: 0 });
        const stubborn: DataPort = {
            ...data.port,
            remaining: async () => {
                return { goals: 3, jobs: 0, tasks: 0 };
            },
        };

        requests.rows.set("r3", request({ status: "grace", type: "erasure" }));
        const outcome = await runErasure(
            contextFor(stubborn, requests, memoryFiles()),
            [tasks, quiesced],
            request({ id: "r3", status: "grace", type: "erasure" }),
        );

        expect(outcome).toStrictEqual({ leftover: ["goals"], status: "failed" });
    });
});

describe("omitted columns", () => {
    it("never writes a column the dataset omits into the archive", async () => {
        const requests = memoryRequests();
        const files = memoryFiles();
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
        const opened = request({ id: "r9" });

        requests.rows.set("r9", opened);
        await runExport(contextFor(data, requests, files), [secretDataset], opened);

        const archive = unzipSync(files.files.get("r9/export.zip") as Uint8Array);
        const session = new TextDecoder().decode(archive["data/auth/session.json"]);

        expect(session).not.toContain("live-secret");
        expect(session).toContain("s1");
    });
});
