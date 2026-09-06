import { describe, expect, it, vi } from "vitest";

import type { ScheduledFunctionDoc, StorageMetadata, SystemReaderSchedulerLike, SystemReaderStorageLike } from "../src/system-reader";
import { createSystemReader } from "../src/system-reader";

const scheduledRecord = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => {
    return {
        args: { x: 1 },
        enqueuedAt: 1000,
        functionPath: "messages:send",
        id: "job_1",
        scheduledFor: 2000,
        ...overrides,
    };
};

describe("createSystemReader — _scheduled_functions", () => {
    it("proxies scheduler.list through query().collect() and maps to ScheduledFunctionDoc", async () => {
        expect.assertions(2);

        const list = vi.fn<() => Promise<Record<string, unknown>[]>>(async () => [
            scheduledRecord(),
            scheduledRecord({ attempts: 2, id: "job_2", shardKey: "tenant-a" }),
        ]);
        const scheduler: SystemReaderSchedulerLike = { get: vi.fn<SystemReaderSchedulerLike["get"]>(), list };

        const reader = createSystemReader({ scheduler });
        const docs = await reader.query("_scheduled_functions").collect();

        expect(list).toHaveBeenCalledTimes(1);
        expect(docs).toStrictEqual<ScheduledFunctionDoc[]>([
            { args: { x: 1 }, enqueuedAt: 1000, functionPath: "messages:send", id: "job_1", scheduledFor: 2000 },
            { args: { x: 1 }, attempts: 2, enqueuedAt: 1000, functionPath: "messages:send", id: "job_2", scheduledFor: 2000, shardKey: "tenant-a" },
        ]);
    });

    it("passes a Date/bigint arg through untouched rather than decoding it a second time", async () => {
        expect.assertions(2);

        // The source is `ctx.scheduler` — `@lunora/scheduler`'s `createScheduler`,
        // which `decodeWire`s every SchedulerDO response at its transport. Running
        // the codec again here is NOT a no-op on what it hands back: a `Date` has
        // no own enumerable keys, so a second `decodeWire` flattens it to `{}`.
        const dueAt = new Date("2026-06-01T12:00:00.000Z");
        const list = vi.fn<() => Promise<Record<string, unknown>[]>>(async () => [scheduledRecord({ args: { amountCents: 42n, dueAt } })]);
        const scheduler: SystemReaderSchedulerLike = { get: vi.fn<SystemReaderSchedulerLike["get"]>(), list };

        const reader = createSystemReader({ scheduler });
        const [doc] = await reader.query("_scheduled_functions").collect();

        expect(doc?.args["dueAt"]).toStrictEqual(dueAt);
        expect(doc?.args["amountCents"]).toBe(42n);
    });

    it("leaves functionPath absent on a workflow-targeted job instead of inventing an empty path", async () => {
        expect.assertions(1);

        // A job that starts a durable workflow carries `workflow` and NO
        // `functionPath`. Coercing the absent value to `""` made every such row
        // look like a function whose path happened to be empty, so an app
        // de-duplicating on `functionPath` never matched and scheduled a second
        // run on every invocation.
        const list = vi.fn<() => Promise<Record<string, unknown>[]>>(async () => [
            scheduledRecord({ functionPath: undefined, id: "job_wf", pool: "billing", workflow: "WORKFLOW_NIGHTLY" }),
        ]);
        const scheduler: SystemReaderSchedulerLike = { get: vi.fn<SystemReaderSchedulerLike["get"]>(), list };

        const reader = createSystemReader({ scheduler });

        const docs = await reader.query("_scheduled_functions").collect();

        expect(docs).toStrictEqual<ScheduledFunctionDoc[]>([
            { args: { x: 1 }, enqueuedAt: 1000, id: "job_wf", pool: "billing", scheduledFor: 2000, workflow: "WORKFLOW_NIGHTLY" },
        ]);
    });

    it("proxies scheduler.get through get(table, id)", async () => {
        expect.assertions(3);

        const get = vi.fn<SystemReaderSchedulerLike["get"]>(async (id) => (id === "job_1" ? scheduledRecord() : null));
        const scheduler: SystemReaderSchedulerLike = { get, list: vi.fn<SystemReaderSchedulerLike["list"]>() };

        const reader = createSystemReader({ scheduler });

        await expect(reader.get("_scheduled_functions", "job_1")).resolves.toStrictEqual({
            args: { x: 1 },
            enqueuedAt: 1000,
            functionPath: "messages:send",
            id: "job_1",
            scheduledFor: 2000,
        });
        await expect(reader.get("_scheduled_functions", "missing")).resolves.toBeNull();
        expect(get).toHaveBeenCalledWith("job_1");
    });

    it("throws a clear error when no scheduler is configured", async () => {
        expect.assertions(2);

        const reader = createSystemReader({});

        await expect(reader.query("_scheduled_functions").collect()).rejects.toThrow(/no scheduler configured/);
        await expect(reader.get("_scheduled_functions", "x")).rejects.toThrow(/no scheduler configured/);
    });
});

describe("createSystemReader — _storage", () => {
    it("proxies storage.list through query().collect() and maps to StorageMetadata", async () => {
        expect.assertions(2);

        const list = vi.fn<SystemReaderStorageLike["list"]>(async () => {
            return {
                objects: [
                    { httpMetadata: { contentType: "text/plain" }, key: "a.txt", sha256: "abc", size: 10, uploaded: new Date(5000) },
                    { customMetadata: { tag: "x" }, key: "b.bin", size: 20 },
                ],
            };
        });
        const storage: SystemReaderStorageLike = { getMetadata: vi.fn<SystemReaderStorageLike["getMetadata"]>(), list };

        const reader = createSystemReader({ storage });
        const docs = await reader.query("_storage").collect();

        expect(list).toHaveBeenCalledTimes(1);
        expect(docs).toStrictEqual<StorageMetadata[]>([
            { contentType: "text/plain", key: "a.txt", sha256: "abc", size: 10, uploaded: 5000 },
            { customMetadata: { tag: "x" }, key: "b.bin", size: 20 },
        ]);
    });

    it("proxies storage.getMetadata through get(table, key)", async () => {
        expect.assertions(3);

        const meta: StorageMetadata = { contentType: "image/png", key: "logo.png", size: 42 };
        const getMetadata = vi.fn<SystemReaderStorageLike["getMetadata"]>(async (key) => (key === "logo.png" ? meta : null));
        const storage: SystemReaderStorageLike = { getMetadata, list: vi.fn<SystemReaderStorageLike["list"]>() };

        const reader = createSystemReader({ storage });

        await expect(reader.get("_storage", "logo.png")).resolves.toStrictEqual(meta);
        await expect(reader.get("_storage", "missing")).resolves.toBeNull();
        expect(getMetadata).toHaveBeenCalledWith("logo.png");
    });

    it("throws a clear error when no storage is configured", async () => {
        expect.assertions(2);

        const reader = createSystemReader({});

        await expect(reader.query("_storage").collect()).rejects.toThrow(/no storage configured/);
        await expect(reader.get("_storage", "x")).rejects.toThrow(/no storage configured/);
    });
});

describe("createSystemReader — independence of sources", () => {
    it("keeps _scheduled_functions usable when only the scheduler is configured", async () => {
        expect.assertions(2);

        const scheduler: SystemReaderSchedulerLike = {
            get: vi.fn<SystemReaderSchedulerLike["get"]>(),
            list: vi.fn<SystemReaderSchedulerLike["list"]>(async () => []),
        };
        const reader = createSystemReader({ scheduler });

        await expect(reader.query("_scheduled_functions").collect()).resolves.toStrictEqual([]);
        await expect(reader.query("_storage").collect()).rejects.toThrow(/no storage configured/);
    });
});
