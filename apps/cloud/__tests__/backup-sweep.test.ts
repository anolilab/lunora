import { describe, expect, it, vi } from "vitest";

import type { BackupBucket, BackupListing } from "../src/backup/sweep";
import { BACKUP_RETENTION_MS, backupKey, backupPrefix, runBackupSweep } from "../src/backup/sweep";

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
