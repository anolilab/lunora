import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBackupCommand } from "../../src/commands/backup/handler";
import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import type { FetchLike } from "../../src/commands/run/handler";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { logger: Logger; logs: string[] } => {
    const logs: string[] = [];

    return {
        logger: {
            error: (message) => logs.push(message),
            info: (message) => logs.push(message),
            success: (message) => logs.push(message),
            warn: (message) => logs.push(message),
        },
        logs,
    };
};

const stringStream = (text: string): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
};

/** A `fetch` double that serves the export NDJSON body. */
const exportFetch =
    (ndjson: string): StreamingFetchLike =>
    async () => {
        return { body: stringStream(ndjson), json: async () => undefined, ok: true, status: 200, text: async () => "" };
    };

const NDJSON = `${JSON.stringify({ doc: { _id: "u1" }, table: "users" })}\n`;
const FIXED_NOW = (): Date => new Date("2026-06-03T12:00:00.000Z");

const capturingImportFetch =
    (calls: string[]): StreamingFetchLike =>
    async (url) => {
        calls.push(url);

        return {
            body: null,
            json: async () => {
                return { inserted: { users: 1 } };
            },
            ok: true,
            status: 200,
            text: async () => "",
        };
    };

let workDir: string;

describe("lunora backup", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-cli-backup-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    it("create writes a timestamped snapshot and records it in the manifest", async () => {
        expect.assertions(4);

        const { logger } = capturingLogger();

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: exportFetch(NDJSON),
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(0);

        const directory = join(workDir, ".lunora-backups");
        const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { file: string; rows: number }[];

        expect(manifest).toHaveLength(1);
        expect(manifest[0]?.rows).toBe(1);
        expect(existsSync(join(directory, manifest[0]!.file))).toBe(true);
    });

    it("writes exactly these snapshot bytes and this manifest JSON", async () => {
        expect.assertions(2);

        const { logger } = capturingLogger();

        await runBackupCommand({
            cwd: workDir,
            fetchImpl: exportFetch(NDJSON),
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            tables: "users",
            token: "t",
            url: "http://localhost:8787",
        });

        // Byte-for-byte, not "it worked": moving the filesystem writes behind a
        // destination interface must not shift a single byte of what lands on
        // disk, because these bytes are what an operator restores from.
        const directory = join(workDir, ".lunora-backups");

        expect(readFileSync(join(directory, "lunora-backup-2026-06-03T12-00-00-000Z.ndjson"), "utf8")).toBe(NDJSON);

        expect(readFileSync(join(directory, "manifest.json"), "utf8")).toBe(
            `[
  {
    "bytes": 37,
    "createdAt": "2026-06-03T12:00:00.000Z",
    "file": "lunora-backup-2026-06-03T12-00-00-000Z.ndjson",
    "id": "2026-06-03T12:00:00.000Z",
    "rows": 1,
    "sha256": "84528e00c324faff7e650ef1fb502f3afef91ae32a542c2130ae415c242e1708",
    "tables": "users"
  }
]
`,
        );
    });

    it("list prints recorded backups", async () => {
        expect.assertions(1);

        const { logger, logs } = capturingLogger();

        await runBackupCommand({
            cwd: workDir,
            fetchImpl: exportFetch(NDJSON),
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });
        await runBackupCommand({ cwd: workDir, logger, subcommand: "list" });

        expect(logs.some((line) => line.includes("2026-06-03"))).toBe(true);
    });

    it("restore imports a snapshot resolved by its manifest id", async () => {
        expect.assertions(2);

        const { logger } = capturingLogger();

        const created = await runBackupCommand({
            cwd: workDir,
            fetchImpl: exportFetch(NDJSON),
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        const importCalls: string[] = [];
        const importFetch = capturingImportFetch(importCalls);

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: importFetch,
            logger,
            subcommand: "restore",
            target: created.entry?.id,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(0);
        expect(importCalls[0]).toContain("/_lunora/admin/import");
    });

    it("restore refuses --prod without --yes (no import request)", async () => {
        expect.assertions(2);

        const { logger } = capturingLogger();

        const created = await runBackupCommand({
            cwd: workDir,
            fetchImpl: exportFetch(NDJSON),
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        const importCalls: string[] = [];
        const importFetch = capturingImportFetch(importCalls);

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: importFetch,
            logger,
            prod: true,
            subcommand: "restore",
            target: created.entry?.id,
            token: "t",
            url: "https://app.example.com",
        });

        expect(result.code).toBe(1);
        expect(importCalls).toHaveLength(0);
    });

    it("restore proceeds with --prod when --yes confirms", async () => {
        expect.assertions(2);

        const { logger } = capturingLogger();

        const created = await runBackupCommand({
            cwd: workDir,
            fetchImpl: exportFetch(NDJSON),
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        const importCalls: string[] = [];
        const importFetch = capturingImportFetch(importCalls);

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: importFetch,
            logger,
            prod: true,
            subcommand: "restore",
            target: created.entry?.id,
            token: "t",
            url: "https://app.example.com",
            yes: true,
        });

        expect(result.code).toBe(0);
        expect(importCalls[0]).toContain("/_lunora/admin/import");
    });

    it("restore --verify refuses a directory snapshot that no longer matches its manifest", async () => {
        expect.assertions(3);

        const { logger, logs } = capturingLogger();

        const created = await runBackupCommand({
            cwd: workDir,
            fetchImpl: exportFetch(NDJSON),
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        const importCalls: string[] = [];

        const verified = await runBackupCommand({
            cwd: workDir,
            fetchImpl: capturingImportFetch(importCalls),
            logger,
            subcommand: "restore",
            target: created.entry?.id,
            token: "t",
            url: "http://localhost:8787",
            verify: true,
        });

        expect(verified.code).toBe(0);

        // Bit rot on the operator's disk is exactly what the portable tier has
        // to survive being lied to about.
        writeFileSync(join(workDir, ".lunora-backups", created.entry!.file), `${NDJSON}${NDJSON}`, "utf8");

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: capturingImportFetch(importCalls),
            logger,
            subcommand: "restore",
            target: created.entry?.id,
            token: "t",
            url: "http://localhost:8787",
            verify: true,
        });

        expect(result.code).toBe(1);
        expect(logs.some((line) => line.includes("does not match its recorded checksum"))).toBe(true);
    });

    it.each([
        ["a relative escape", "../../outside.ndjson"],
        ["an absolute path", "/etc/hosts"],
        ["a sibling directory sharing the prefix", "../.lunora-backups-evil/snapshot.ndjson"],
    ])("restore refuses a manifest entry that points outside the backup directory (%s)", async (_label, file) => {
        expect.assertions(3);

        const { logger, logs } = capturingLogger();
        const directory = join(workDir, ".lunora-backups");

        mkdirSync(directory, { recursive: true });
        // A manifest is data: `file` reaching out of the directory would make
        // `restore <id>` read and import a file from anywhere on disk. The shape
        // guard that accepts the entry only knows it is a string.
        writeFileSync(
            join(directory, "manifest.json"),
            `${JSON.stringify([{ bytes: 1, createdAt: "2026-06-03T12:00:00.000Z", file, id: "2026-06-03T12:00:00.000Z", rows: 1 }], undefined, 2)}\n`,
            "utf8",
        );

        const importCalls: string[] = [];

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: capturingImportFetch(importCalls),
            logger,
            subcommand: "restore",
            target: "2026-06-03T12:00:00.000Z",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(importCalls).toHaveLength(0);
        expect(logs.some((line) => line.includes("points outside"))).toBe(true);
    });

    it("restore refuses a symlink that leaves the backup directory", async () => {
        expect.assertions(3);

        const { logger, logs } = capturingLogger();
        const directory = join(workDir, ".lunora-backups");
        const outside = join(workDir, "outside.ndjson");

        mkdirSync(directory, { recursive: true });
        writeFileSync(outside, NDJSON, "utf8");
        // Nothing about this entry is suspicious as text — no `..`, not
        // absolute, and the file is right there in the directory. `resolve()`
        // is pure string manipulation and makes no filesystem query, so only
        // canonicalising both sides catches it.
        symlinkSync(outside, join(directory, "snapshot.ndjson"));
        writeFileSync(
            join(directory, "manifest.json"),
            `${JSON.stringify(
                [{ bytes: 1, createdAt: "2026-06-03T12:00:00.000Z", file: "snapshot.ndjson", id: "2026-06-03T12:00:00.000Z", rows: 1 }],
                undefined,
                2,
            )}\n`,
            "utf8",
        );

        const importCalls: string[] = [];

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: capturingImportFetch(importCalls),
            logger,
            subcommand: "restore",
            target: "2026-06-03T12:00:00.000Z",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(importCalls).toHaveLength(0);
        expect(logs.some((line) => line.includes("points outside"))).toBe(true);
    });

    it("restores through a symlink that stays inside the backup directory", async () => {
        expect.assertions(2);

        const { logger } = capturingLogger();
        const directory = join(workDir, ".lunora-backups");

        mkdirSync(join(directory, "archive"), { recursive: true });
        writeFileSync(join(directory, "archive", "real.ndjson"), NDJSON, "utf8");
        // The containment check canonicalises the backup directory too — on
        // macOS every temp directory is itself reached through a symlink, so
        // resolving only the candidate would reject perfectly good paths.
        symlinkSync(join(directory, "archive", "real.ndjson"), join(directory, "snapshot.ndjson"));
        writeFileSync(
            join(directory, "manifest.json"),
            `${JSON.stringify(
                [{ bytes: 1, createdAt: "2026-06-03T12:00:00.000Z", file: "snapshot.ndjson", id: "2026-06-03T12:00:00.000Z", rows: 1 }],
                undefined,
                2,
            )}\n`,
            "utf8",
        );

        const importCalls: string[] = [];

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: capturingImportFetch(importCalls),
            logger,
            subcommand: "restore",
            target: "2026-06-03T12:00:00.000Z",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(0);
        expect(importCalls[0]).toContain("/_lunora/admin/import");
    });

    it("leaves no partial snapshot behind when the export fails", async () => {
        expect.assertions(3);

        const { logger } = capturingLogger();
        const failingExport: StreamingFetchLike = async () => {
            return { body: null, json: async () => undefined, ok: false, status: 500, text: async () => "boom" };
        };

        const result = await runBackupCommand({
            cwd: workDir,
            fetchImpl: failingExport,
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);

        // A half-written `.ndjson` with no manifest entry is invisible to
        // `list`, so it would sit in the operator's directory forever.
        const directory = join(workDir, ".lunora-backups");

        expect(existsSync(directory) ? readdirSync(directory) : []).toStrictEqual([]);
        expect(existsSync(join(directory, "lunora-backup-2026-06-03T12-00-00-000Z.ndjson"))).toBe(false);
    });

    it("restore fails for an unknown target", async () => {
        expect.assertions(1);

        const { logger } = capturingLogger();

        const result = await runBackupCommand({ cwd: workDir, logger, subcommand: "restore", target: "does-not-exist" });

        expect(result.code).toBe(1);
    });

    describe("retention", () => {
        const previewFetch =
            (body: unknown, calls: { method: string; url: string }[] = []): FetchLike =>
            async (url, init) => {
                calls.push({ method: init?.method ?? "GET", url });

                return {
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => body,
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify(body),
                };
            };

        it("prints what retention would delete, phrased like the cron's own record", async () => {
            expect.assertions(4);

            const { logger, logs } = capturingLogger();
            const calls: { method: string; url: string }[] = [];

            const result = await runBackupCommand({
                cwd: workDir,
                logger,
                pitrFetch: previewFetch(
                    {
                        cron: "0 3 * * *",
                        eligible: 5,
                        keep: 3,
                        prefix: "backups/",
                        wouldDelete: ["backups/lunora-backup-2026-06-01T03-00-00-000Z.ndjson.manifest.json"],
                    },
                    calls,
                ),
                subcommand: "retention",
                token: "t",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(0);
            // A read, and only a read.
            expect(calls).toStrictEqual([{ method: "GET", url: "http://localhost:8787/_lunora/admin/backup/retention" }]);
            expect(logs.some((line) => line.includes("would keep the newest 3 of 5 under backups/ and delete 1"))).toBe(true);
            // The snapshot is named, not its sidecar — that is the file an
            // operator would go looking for.
            expect(logs.some((line) => line.includes("  backups/lunora-backup-2026-06-01T03-00-00-000Z.ndjson"))).toBe(true);
        });

        it("says so when retention is off rather than reporting an empty deletion", async () => {
            expect.assertions(2);

            const { logger, logs } = capturingLogger();

            const result = await runBackupCommand({
                cwd: workDir,
                logger,
                pitrFetch: previewFetch({ cron: "0 3 * * *", eligible: 4, keep: 0, prefix: "backups/", wouldDelete: [] }),
                subcommand: "retention",
                token: "t",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(0);
            expect(logs.some((line) => line.includes("retention is off"))).toBe(true);
        });

        it("explains an empty selection on a bucket this cron never wrote to", async () => {
            expect.assertions(2);

            const { logger, logs } = capturingLogger();

            const result = await runBackupCommand({
                cwd: workDir,
                logger,
                // The legacy-bucket case: snapshots exist, none carry the marker.
                pitrFetch: previewFetch({ cron: "0 3 * * *", eligible: 0, keep: 3, prefix: "backups/", wouldDelete: [] }),
                subcommand: "retention",
                token: "t",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(0);
            expect(logs.some((line) => line.includes("was written by this cron"))).toBe(true);
        });

        it("requires an admin token", async () => {
            expect.assertions(2);

            const { logger, logs } = capturingLogger();
            const previous = process.env.LUNORA_ADMIN_TOKEN;

            delete process.env.LUNORA_ADMIN_TOKEN;

            try {
                const result = await runBackupCommand({ cwd: workDir, logger, subcommand: "retention", url: "http://localhost:8787" });

                expect(result.code).toBe(1);
                expect(logs.some((line) => line.includes("admin token required"))).toBe(true);
            } finally {
                if (previous !== undefined) {
                    process.env.LUNORA_ADMIN_TOKEN = previous;
                }
            }
        });
    });

    describe("pitr", () => {
        interface PitrCall {
            body: string;
            url: string;
        }

        const captureFetch =
            (calls: PitrCall[], result: unknown): FetchLike =>
            async (url, init) => {
                calls.push({ body: init?.body ?? "", url });

                return {
                    json: async () => {
                        return { result };
                    },
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ result }),
                };
            };

        it("reads the current bookmark via getPitrBookmark on the root shard", async () => {
            expect.assertions(4);

            const { logger } = capturingLogger();
            const calls: PitrCall[] = [];

            const result = await runBackupCommand({
                cwd: workDir,
                logger,
                pitrFetch: captureFetch(calls, { current: "bm-123" }),
                subcommand: "pitr",
                token: "admintok",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(0);
            expect(calls[0]?.url).toBe("http://localhost:8787/_lunora/admin/pitr");

            const body = JSON.parse(calls[0]?.body ?? "{}") as { args: Record<string, unknown>; functionPath: string };

            expect(body.functionPath).toBe("__lunora_admin__:getPitrBookmark");
            expect(body.args).toStrictEqual({});
        });

        it("previews the bookmark for a time and targets the named shard", async () => {
            expect.assertions(3);

            const { logger } = capturingLogger();
            const calls: PitrCall[] = [];

            await runBackupCommand({
                at: "2026-06-01T00:00:00.000Z",
                cwd: workDir,
                logger,
                pitrFetch: captureFetch(calls, { current: "bm-now", forTime: "bm-then" }),
                shard: "tenant-7",
                subcommand: "pitr",
                token: "admintok",
                url: "http://localhost:8787",
            });

            const body = JSON.parse(calls[0]?.body ?? "{}") as { args: Record<string, unknown>; functionPath: string; shardKey?: string };

            expect(body.functionPath).toBe("__lunora_admin__:getPitrBookmark");
            expect(body.args).toStrictEqual({ time: "2026-06-01T00:00:00.000Z" });
            expect(body.shardKey).toBe("tenant-7");
        });

        it("arms a restore to an explicit bookmark with restart", async () => {
            expect.assertions(3);

            const { logger } = capturingLogger();
            const calls: PitrCall[] = [];

            const result = await runBackupCommand({
                bookmark: "bm-target",
                cwd: workDir,
                logger,
                pitrFetch: captureFetch(calls, { restoredTo: "bm-target", undoBookmark: "bm-undo" }),
                restart: true,
                restore: true,
                subcommand: "pitr",
                token: "admintok",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(0);

            const body = JSON.parse(calls[0]?.body ?? "{}") as { args: Record<string, unknown>; functionPath: string };

            expect(body.functionPath).toBe("__lunora_admin__:pitrRestore");
            expect(body.args).toStrictEqual({ bookmark: "bm-target", restart: true });
        });

        it("refuses --restore without --at or --bookmark", async () => {
            expect.assertions(2);

            const { logger } = capturingLogger();
            const calls: PitrCall[] = [];

            const result = await runBackupCommand({
                cwd: workDir,
                logger,
                pitrFetch: captureFetch(calls, {}),
                restore: true,
                subcommand: "pitr",
                token: "admintok",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
        });

        it("refuses a production restore without --yes", async () => {
            expect.assertions(2);

            const { logger } = capturingLogger();
            const calls: PitrCall[] = [];

            const result = await runBackupCommand({
                at: "2026-06-01T00:00:00.000Z",
                cwd: workDir,
                logger,
                pitrFetch: captureFetch(calls, {}),
                prod: true,
                restore: true,
                subcommand: "pitr",
                token: "admintok",
                url: "https://app.example.com",
            });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
        });

        it("requires an admin token", async () => {
            expect.assertions(1);

            const { logger } = capturingLogger();
            const previous = process.env.LUNORA_ADMIN_TOKEN;

            delete process.env.LUNORA_ADMIN_TOKEN;

            try {
                const result = await runBackupCommand({ cwd: workDir, logger, subcommand: "pitr", url: "http://localhost:8787" });

                expect(result.code).toBe(1);
            } finally {
                if (previous !== undefined) {
                    process.env.LUNORA_ADMIN_TOKEN = previous;
                }
            }
        });
    });
});
