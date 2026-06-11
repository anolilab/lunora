import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

let workDir: string;

describe("cirrus backup", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "cirrus-cli-backup-"));
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

        const directory = join(workDir, ".cirrus-backups");
        const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { file: string; rows: number }[];

        expect(manifest).toHaveLength(1);
        expect(manifest[0]?.rows).toBe(1);
        expect(existsSync(join(directory, manifest[0]!.file))).toBe(true);
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
        const importFetch: StreamingFetchLike = async (url) => {
            importCalls.push(url);

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
        expect(importCalls[0]).toContain("/_cirrus/admin/import");
    });

    it("restore fails for an unknown target", async () => {
        expect.assertions(1);

        const { logger } = capturingLogger();

        const result = await runBackupCommand({ cwd: workDir, logger, subcommand: "restore", target: "does-not-exist" });

        expect(result.code).toBe(1);
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
            expect(calls[0]?.url).toBe("http://localhost:8787/_cirrus/admin/pitr");

            const body = JSON.parse(calls[0]?.body ?? "{}") as { args: Record<string, unknown>; functionPath: string };

            expect(body.functionPath).toBe("__cirrus_admin__:getPitrBookmark");
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

            expect(body.functionPath).toBe("__cirrus_admin__:getPitrBookmark");
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

            expect(body.functionPath).toBe("__cirrus_admin__:pitrRestore");
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
            const previous = process.env.CIRRUS_ADMIN_TOKEN;

            delete process.env.CIRRUS_ADMIN_TOKEN;

            try {
                const result = await runBackupCommand({ cwd: workDir, logger, subcommand: "pitr", url: "http://localhost:8787" });

                expect(result.code).toBe(1);
            } finally {
                if (previous !== undefined) {
                    process.env.CIRRUS_ADMIN_TOKEN = previous;
                }
            }
        });
    });
});
