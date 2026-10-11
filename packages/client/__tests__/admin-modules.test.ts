import { describe, expect, it, vi } from "vitest";

import { getCronJobs, runCronJob } from "../src/admin/functions";
import { listGlobalTables } from "../src/admin/global-tables";
import type { AdminHost } from "../src/admin/host";
import { deleteKvKey, listKvNamespaces } from "../src/admin/kv";
import { queryLogArchive, shardTraffic } from "../src/admin/observability";
import { cancelScheduledJob, listScheduledJobs } from "../src/admin/scheduler";
import { listStorageBuckets, uploadStorageObject } from "../src/admin/storage";
import { listVectorIndexes } from "../src/admin/vector-indexes";
import {
    CRON_JOBS_PATH,
    CRON_JOBS_RUN_PATH,
    GLOBAL_TABLES_PATH,
    KV_NAMESPACES_PATH,
    KV_VALUE_PATH,
    LOG_ARCHIVE_PATH,
    SCHEDULED_CANCEL_PATH,
    SCHEDULED_PATH,
    SHARD_TRAFFIC_PATH,
    STORAGE_BUCKETS_PATH,
    STORAGE_PATH,
    VECTOR_INDEXES_PATH,
} from "../src/client-paths";
import { LunoraClient } from "../src/lunora-client";

interface RecordedCall {
    contentType?: string;
    method: string;
    path: string;
    payload?: unknown;
}

/** A host that records every request and answers with `response`. `assertOpen` is a spy the test can read. */
const recordingHost = (response: unknown = {}, closed = false) => {
    const calls: RecordedCall[] = [];
    const assertOpen = vi.fn<() => void>(() => {
        if (closed) {
            throw new Error("client closed");
        }
    });
    const host: AdminHost = {
        adminFetch: async (path, method, payload, contentType) => {
            calls.push({ contentType, method, path, payload });

            return response;
        },
        assertOpen,
    };

    return { assertOpen, calls, host };
};

describe("admin modules: request shape", () => {
    it("shardTraffic posts the table and maps a missing body to zeroed totals", async () => {
        expect.assertions(4);

        const { assertOpen, calls, host } = recordingHost();

        await expect(shardTraffic(host, "todos")).resolves.toStrictEqual({ failed: 0, ok: 0, shards: [] });
        expect(calls).toStrictEqual([{ contentType: undefined, method: "POST", path: SHARD_TRAFFIC_PATH, payload: { table: "todos" } }]);
        expect(assertOpen).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(1);
    });

    it("listScheduledJobs gets the schedule and defaults to no records", async () => {
        expect.assertions(2);

        const { calls, host } = recordingHost();

        await expect(listScheduledJobs(host)).resolves.toStrictEqual([]);
        expect(calls[0]).toMatchObject({ method: "GET", path: SCHEDULED_PATH });
    });

    it("cancelScheduledJob posts the id and reports cancelled only on an explicit true", async () => {
        expect.assertions(3);

        const silent = recordingHost();

        await expect(cancelScheduledJob(silent.host, "job-1")).resolves.toStrictEqual({ cancelled: false });
        expect(silent.calls[0]).toMatchObject({ method: "POST", path: SCHEDULED_CANCEL_PATH, payload: { id: "job-1" } });

        const confirmed = recordingHost({ cancelled: true });

        await expect(cancelScheduledJob(confirmed.host, "job-1")).resolves.toStrictEqual({ cancelled: true });
    });

    it("listStorageBuckets gets the bucket list and defaults to none", async () => {
        expect.assertions(2);

        const { calls, host } = recordingHost();

        await expect(listStorageBuckets(host)).resolves.toStrictEqual([]);
        expect(calls[0]).toMatchObject({ method: "GET", path: STORAGE_BUCKETS_PATH });
    });

    it("listGlobalTables returns the server's array untouched", async () => {
        expect.assertions(2);

        const tables = [{ name: "orders" }];
        const { calls, host } = recordingHost(tables);

        await expect(listGlobalTables(host)).resolves.toBe(tables);
        expect(calls[0]).toMatchObject({ method: "GET", path: GLOBAL_TABLES_PATH });
    });

    it("listKvNamespaces gets the namespaces and defaults to none", async () => {
        expect.assertions(2);

        const { calls, host } = recordingHost();

        await expect(listKvNamespaces(host)).resolves.toStrictEqual([]);
        expect(calls[0]).toMatchObject({ method: "GET", path: KV_NAMESPACES_PATH });
    });

    it("getCronJobs gets the jobs and defaults to none", async () => {
        expect.assertions(2);

        const { calls, host } = recordingHost();

        await expect(getCronJobs(host)).resolves.toStrictEqual([]);
        expect(calls[0]).toMatchObject({ method: "GET", path: CRON_JOBS_PATH });
    });

    it("runCronJob posts the name and falls back to the requested name and ran: false", async () => {
        expect.assertions(2);

        const { calls, host } = recordingHost();

        await expect(runCronJob(host, "nightly")).resolves.toStrictEqual({ name: "nightly", ran: false });
        expect(calls[0]).toMatchObject({ method: "POST", path: CRON_JOBS_RUN_PATH, payload: { name: "nightly" } });
    });

    it("queryLogArchive defaults to an empty query and falls back to no rows", async () => {
        expect.assertions(3);

        const { calls, host } = recordingHost();

        await expect(queryLogArchive(host)).resolves.toStrictEqual({ nextCursor: undefined, rows: [] });
        expect(calls[0]).toMatchObject({ method: "POST", path: LOG_ARCHIVE_PATH, payload: {} });
        expect(calls).toHaveLength(1);
    });

    it("deleteKvKey sends a DELETE whose path carries the key and namespace", async () => {
        expect.assertions(3);

        const { calls, host } = recordingHost();

        await deleteKvKey(host, { key: "k 1", namespace: "ns" });

        expect(calls[0]?.method).toBe("DELETE");
        expect(calls[0]?.path.startsWith(KV_VALUE_PATH)).toBe(true);
        expect(calls[0]?.path).toContain("namespace=ns");
    });

    it("uploadStorageObject PUTs the body with its content type and returns the stored key", async () => {
        expect.assertions(3);

        const body = new Blob(["hi"]);
        const { calls, host } = recordingHost({ etag: "e1" });

        await expect(uploadStorageObject(host, { body, contentType: "text/plain", key: "a.txt" })).resolves.toStrictEqual({ etag: "e1", key: "a.txt" });
        expect(calls[0]).toMatchObject({ contentType: "text/plain", method: "PUT", payload: body });
        expect(calls[0]?.path).toBe(`${STORAGE_PATH}?key=a.txt`);
    });

    it("listVectorIndexes gets the indexes and defaults to none", async () => {
        expect.assertions(2);

        const { calls, host } = recordingHost();

        await expect(listVectorIndexes(host)).resolves.toStrictEqual([]);
        expect(calls[0]).toMatchObject({ method: "GET", path: VECTOR_INDEXES_PATH });
    });
});

describe("admin modules: closed client", () => {
    it("rejects instead of throwing when the client is closed, so callers can await the failure", async () => {
        expect.assertions(3);

        const { calls, host } = recordingHost({}, true);

        const pending = listScheduledJobs(host);

        expect(pending).toBeInstanceOf(Promise);
        await expect(pending).rejects.toThrow("client closed");
        expect(calls).toHaveLength(0);
    });
});

describe("lunoraClient admin wiring", () => {
    it("rejects an admin call on a closed client through the real assertOpen, without reaching fetch", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>();
        const client = new LunoraClient({
            fetch: fetchMock,
            url: "https://app.example",
            WebSocket: vi.fn<() => void>() as unknown as typeof WebSocket,
        });

        client.close();

        await expect(client.listScheduledJobs()).rejects.toThrow("LunoraClient is closed");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
