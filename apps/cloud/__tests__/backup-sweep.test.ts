import { describe, expect, it, vi } from "vitest";

import { offsiteBucket } from "../src/backup/offsite";
import type { BackupBucket, BackupListing } from "../src/backup/sweep";
import { BACKUP_RETENTION_MS, backupKey, backupPrefix, runBackupSweep } from "../src/backup/sweep";
import type { StoredObject } from "./_helpers/fake-object-store";
import { fakeS3 } from "./_helpers/fake-object-store";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

/** An R2 double that records what was written and deleted. */
const fakeBucket = (
    objects: { key: string; uploaded: Date }[] = [],
    pages?: BackupListing[],
): {
    bucket: BackupBucket;
    deleted: string[];
    put: { key: string; value: ReadableStream | null }[];
} => {
    const deleted: string[] = [];
    const put: { key: string; value: ReadableStream | null }[] = [];
    let call = 0;

    return {
        bucket: {
            delete: async (keys) => {
                deleted.push(...keys);
            },
            // Reads back what was put: the stream R2 would have stored.
            get: async (key) => {
                const value = put.find((entry) => entry.key === key)?.value;

                return value ? { body: value } : null;
            },
            list: async () => {
                if (pages) {
                    const page = pages[call] ?? { objects: [], truncated: false };

                    call += 1;

                    return page;
                }

                return { objects, truncated: false };
            },
            put: async (key, value) => {
                put.push({ key, value });
            },
        },
        deleted,
        put,
    };
};

const okResponse = (): Response => new Response("PRAGMA foreign_keys=OFF;", { status: 200 });

describe(backupKey, () => {
    it("orders lexically the way the dumps order chronologically", () => {
        const earlier = backupKey("cell-a", Date.UTC(2026, 0, 9, 3, 4, 5));
        const later = backupKey("cell-a", Date.UTC(2026, 0, 10, 3, 4, 5));

        // The prune pass lists by prefix and never parses a key, but a human
        // reading the bucket relies on this, and so does any future cursor scan.
        expect([later, earlier].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([earlier, later]);
    });

    it("scopes each cell to its own prefix so one bucket can hold several", () => {
        expect(backupKey("eu-1", NOW).startsWith(backupPrefix("eu-1"))).toBe(true);
        expect(backupKey("us-1", NOW).startsWith(backupPrefix("eu-1"))).toBe(false);
    });
});

const OFFSITE_ENV = {
    BACKUP_OFFSITE_ACCESS_KEY_ID: "offsite-key-id",
    BACKUP_OFFSITE_BUCKET: "dr-backups",
    BACKUP_OFFSITE_ENDPOINT: "https://other-account.r2.cloudflarestorage.com/",
    BACKUP_OFFSITE_SECRET_ACCESS_KEY: "offsite-secret",
};

const sweepWithOffsite = async (remote: ReturnType<typeof fakeS3>, objects: { key: string; uploaded: Date }[] = []) => {
    const primary = fakeBucket(objects);
    const offsite = offsiteBucket(OFFSITE_ENV, remote.fetch);
    const result = await runBackupSweep({
        bucket: primary.bucket,
        cell: "eu-1",
        fetch: async () => okResponse(),
        now: NOW,
        ...(offsite ? { offsite } : {}),
        startExport: async () => {
            return { signedUrl: "https://d1.example.invalid/dump.sql" };
        },
    });

    return { ...primary, result };
};

describe("control-plane backup off-site copy", () => {
    it("stays inert unless every off-site value is set", () => {
        expect(offsiteBucket({})).toBeUndefined();
        expect(offsiteBucket({ ...OFFSITE_ENV, BACKUP_OFFSITE_SECRET_ACCESS_KEY: "" })).toBeUndefined();
        expect(offsiteBucket(OFFSITE_ENV)).toBeDefined();
    });

    it("copies the dump to the off-site account under the same key", async () => {
        const remote = fakeS3({ accessKeyId: "offsite-key-id", bucket: "dr-backups", now: () => new Date(NOW) });
        const { result } = await sweepWithOffsite(remote);

        expect(result.offsite).toStrictEqual({ pruned: 0, status: "succeeded" });
        expect(new TextDecoder().decode(remote.objects.get(result.written ?? "")?.body)).toBe("PRAGMA foreign_keys=OFF;");
    });

    it("prunes the off-site copy on the primary's schedule, across listing pages", async () => {
        const stored = (age: number): StoredObject => {
            return { body: new Uint8Array([1]), uploaded: new Date(NOW - age) };
        };
        const remote = fakeS3({
            accessKeyId: "offsite-key-id",
            bucket: "dr-backups",
            now: () => new Date(NOW),
            objects: new Map([
                ["control-plane/eu-1/a-old.sql", stored(BACKUP_RETENTION_MS + DAY_MS)],
                ["control-plane/eu-1/b-fresh.sql", stored(DAY_MS)],
                ["control-plane/eu-1/c-old.sql", stored(BACKUP_RETENTION_MS + DAY_MS)],
                ["control-plane/us-1/old.sql", stored(BACKUP_RETENTION_MS + DAY_MS)],
            ]),
            pageSize: 1,
        });
        const { result } = await sweepWithOffsite(remote);

        expect(result.offsite).toStrictEqual({ pruned: 2, status: "succeeded" });
        expect([...remote.objects.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "control-plane/eu-1/20260906T120000000Z.sql",
            "control-plane/eu-1/b-fresh.sql",
            // Another cell's prefix is that cell's business.
            "control-plane/us-1/old.sql",
        ]);
    });

    it("never fails the primary backup when the off-site copy fails, and prunes nothing there", async () => {
        const old = { body: new Uint8Array([1]), uploaded: new Date(NOW - BACKUP_RETENTION_MS - DAY_MS) };
        const remote = fakeS3({
            accessKeyId: "offsite-key-id",
            bucket: "dr-backups",
            intercept: (request) => (request.method === "PUT" ? new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }) : undefined),
            objects: new Map([["control-plane/eu-1/old.sql", old]]),
        });
        const { deleted, put, result } = await sweepWithOffsite(remote, [{ key: "control-plane/eu-1/expired.sql", uploaded: old.uploaded }]);

        expect(put).toHaveLength(1);
        expect(deleted).toStrictEqual(["control-plane/eu-1/expired.sql"]);
        expect(result.offsite).toMatchObject({ pruned: 0, status: "failed" });
        expect(result.offsite?.error).toContain("HTTP 500 InternalError");
        // The aborted upload left no partial object, and the last good dump survived.
        expect(remote.stats.aborted).toBe(1);
        expect([...remote.objects.keys()]).toStrictEqual(["control-plane/eu-1/old.sql"]);
    });
});

describe(runBackupSweep, () => {
    it("writes the dump under a timestamped key for this cell", async () => {
        const { bucket, put } = fakeBucket();
        const result = await runBackupSweep({
            bucket,
            cell: "eu-1",
            fetch: async () => okResponse(),
            now: NOW,
            startExport: async () => {
                return { signedUrl: "https://d1.example.invalid/dump.sql" };
            },
        });

        expect(result.written).toBe("control-plane/eu-1/20260906T120000000Z.sql");
        expect(put).toHaveLength(1);
        expect(put[0]?.key).toBe(result.written);
    });

    it("streams the body through rather than buffering the dump", async () => {
        const { bucket, put } = fakeBucket();
        const response = okResponse();

        await runBackupSweep({
            bucket,
            cell: "eu-1",
            fetch: async () => response,
            now: NOW,
            startExport: async () => {
                return { signedUrl: "https://d1.example.invalid/dump.sql" };
            },
        });

        // The value handed to R2 is the response's own stream. Reading it into a
        // string first would put the whole control plane in a 128MB isolate.
        expect(put[0]?.value).toBe(response.body);
    });

    it("deletes dumps past the retention window and keeps the rest", async () => {
        const { bucket, deleted } = fakeBucket([
            { key: "control-plane/eu-1/old.sql", uploaded: new Date(NOW - BACKUP_RETENTION_MS - DAY_MS) },
            { key: "control-plane/eu-1/fresh.sql", uploaded: new Date(NOW - DAY_MS) },
        ]);
        const result = await runBackupSweep({
            bucket,
            cell: "eu-1",
            fetch: async () => okResponse(),
            now: NOW,
            startExport: async () => {
                return { signedUrl: "https://d1.example.invalid/dump.sql" };
            },
        });

        expect(deleted).toStrictEqual(["control-plane/eu-1/old.sql"]);
        expect(result.pruned).toBe(1);
    });

    it("follows the listing cursor, so retention holds past one page", async () => {
        const expired = (key: string): { key: string; uploaded: Date } => {
            return { key, uploaded: new Date(NOW - BACKUP_RETENTION_MS - DAY_MS) };
        };
        const { bucket, deleted } = fakeBucket(
            [],
            [
                { cursor: "page-2", objects: [expired("control-plane/eu-1/a.sql")], truncated: true },
                { objects: [expired("control-plane/eu-1/b.sql")], truncated: false },
            ],
        );

        await runBackupSweep({
            bucket,
            cell: "eu-1",
            fetch: async () => okResponse(),
            now: NOW,
            startExport: async () => {
                return { signedUrl: "https://d1.example.invalid/dump.sql" };
            },
        });

        // A single-page prune would have left `b.sql` behind forever, and the
        // sweep would still have reported success.
        expect(deleted).toStrictEqual(["control-plane/eu-1/a.sql", "control-plane/eu-1/b.sql"]);
    });

    it("throws without writing when the dump cannot be downloaded", async () => {
        const { bucket, put } = fakeBucket();

        await expect(
            runBackupSweep({
                bucket,
                cell: "eu-1",
                fetch: async () => new Response("gone", { status: 403 }),
                now: NOW,
                startExport: async () => {
                    return { signedUrl: "https://d1.example.invalid/dump.sql" };
                },
            }),
        ).rejects.toThrow("HTTP 403");

        // A presigned URL expires after an hour; a truncated or empty object under
        // a fresh key is worse than no object, because the prune would then age
        // out the last good dump behind it.
        expect(put).toStrictEqual([]);
    });

    it("does not prune when the export never starts", async () => {
        const { bucket, deleted } = fakeBucket([{ key: "control-plane/eu-1/old.sql", uploaded: new Date(NOW - BACKUP_RETENTION_MS - DAY_MS) }]);
        const startExport = vi.fn<() => Promise<{ signedUrl: string }>>(async () => {
            throw new Error("d1 export failed");
        });

        await expect(runBackupSweep({ bucket, cell: "eu-1", fetch: async () => okResponse(), now: NOW, startExport })).rejects.toThrow("d1 export failed");

        expect(deleted).toStrictEqual([]);
    });
});
