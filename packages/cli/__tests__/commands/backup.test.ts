import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBackupCommand } from "../../src/commands/backup.js";
import type { StreamingFetchLike } from "../../src/commands/data-transfer.js";
import type { Logger } from "../../src/util/logger.js";

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
});
