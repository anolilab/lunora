import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import { runExportCommand, runImportCommand } from "../../src/commands/data-transfer";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workDir: string;

describe("cirrus data-transfer", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "cirrus-cli-data-transfer-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    /** Build a fake response body as a ReadableStream over the given text. */
    const stringStream = (text: string): ReadableStream<Uint8Array> => {
        const encoder = new TextEncoder();

        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(text));
                controller.close();
            },
        });
    };

    describe("runExportCommand", () => {
        it("fails when no admin token is provided", async () => {
            expect.hasAssertions();

            const previous = process.env["CIRRUS_ADMIN_TOKEN"];

            delete process.env["CIRRUS_ADMIN_TOKEN"];

            try {
                const result = await runExportCommand({ logger: silentLogger() });

                expect(result.code).toBe(1);
            } finally {
                if (previous !== undefined) {
                    process.env["CIRRUS_ADMIN_TOKEN"] = previous;
                }
            }
        });

        it("streams NDJSON into the --out file when configured", async () => {
            expect.assertions(5);

            const calls: { body: unknown; headers?: Record<string, string>; url: string }[] = [];
            const ndjson = `${JSON.stringify({ doc: { _id: "u1" }, table: "users" })}\n${JSON.stringify({ doc: { _id: "u2" }, table: "users" })}\n`;

            const fetchImpl: StreamingFetchLike = async (url, init) => {
                calls.push({ body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers, url });

                return {
                    body: stringStream(ndjson),
                    json: async () => undefined,
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            const outPath = join(workDir, "dump.ndjson");

            const result = await runExportCommand({
                fetchImpl,
                logger: silentLogger(),
                out: outPath,
                token: "test-token",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(0);
            expect(result.rows).toBe(2);
            expect(calls[0]!.url).toBe("http://localhost:8787/_cirrus/admin/export");
            expect(calls[0]!.headers?.["authorization"]).toBe("Bearer test-token");
            expect(readFileSync(outPath, "utf8")).toBe(ndjson);
        });

        it("forwards --tables to the request body", async () => {
            expect.assertions(1);

            const calls: { body: { tables?: unknown } }[] = [];

            const fetchImpl: StreamingFetchLike = async (_url, init) => {
                calls.push({ body: init?.body ? (JSON.parse(init.body) as { tables?: unknown }) : {} });

                return {
                    body: stringStream(""),
                    json: async () => undefined,
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            await runExportCommand({
                fetchImpl,
                logger: silentLogger(),
                out: join(workDir, "x.ndjson"),
                tables: "users,messages",
                token: "t",
            });

            expect(calls[0]!.body.tables).toEqual(["users", "messages"]);
        });

        it("refuses to target localhost with --prod", async () => {
            expect.assertions(1);

            const result = await runExportCommand({
                logger: silentLogger(),
                prod: true,
                token: "t",
            });

            expect(result.code).toBe(1);
        });
    });

    describe("runImportCommand", () => {
        it("fails when the file does not exist", async () => {
            expect.assertions(1);

            const result = await runImportCommand({
                file: join(workDir, "does-not-exist.ndjson"),
                logger: silentLogger(),
                token: "t",
            });

            expect(result.code).toBe(1);
        });

        it("pOSTs batches and aggregates the inserted counts", async () => {
            expect.assertions(4);

            const file = join(workDir, "in.ndjson");

            writeFileSync(
                file,
                [
                    JSON.stringify({ doc: { _id: "u1" }, table: "users" }),
                    JSON.stringify({ doc: { _id: "u2" }, table: "users" }),
                    JSON.stringify({ doc: { _id: "u3" }, table: "users" }),
                ].join("\n"),
                "utf8",
            );

            const calls: { body: string; url: string }[] = [];

            const fetchImpl: StreamingFetchLike = async (url, init) => {
                calls.push({ body: init?.body ?? "", url });

                const rows = (init?.body ?? "").split("\n").filter((line) => line.trim().length > 0);

                return {
                    body: null,
                    json: async () => {
                        return { conflicts: 0, errors: [], inserted: { users: rows.length } };
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            const result = await runImportCommand({
                batchSize: 2,
                fetchImpl,
                file,
                logger: silentLogger(),
                token: "t",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(0);
            expect(result.inserted).toBe(3);
            expect(calls).toHaveLength(2);
            expect(calls[0]!.url).toBe("http://localhost:8787/_cirrus/admin/import");
        });

        it("wraps bare docs with `--table` into `{table,doc}` envelopes", async () => {
            expect.assertions(1);

            const file = join(workDir, "users-bare.ndjson");

            writeFileSync(file, `${JSON.stringify({ _id: "u1", email: "a@b.com" })}\n${JSON.stringify({ _id: "u2", email: "c@d.com" })}\n`, "utf8");

            const captured: { body: string }[] = [];

            const fetchImpl: StreamingFetchLike = async (_url, init) => {
                captured.push({ body: init?.body ?? "" });

                return {
                    body: null,
                    json: async () => {
                        return { conflicts: 0, errors: [], inserted: { users: 2 } };
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            await runImportCommand({
                fetchImpl,
                file,
                logger: silentLogger(),
                table: "users",
                token: "t",
            });

            const firstLine = captured[0]!.body.split("\n").find((line) => line.length > 0);

            expect(JSON.parse(firstLine!)).toEqual({ doc: { _id: "u1", email: "a@b.com" }, table: "users" });
        });

        it("returns a non-zero exit code when the server reports errors", async () => {
            expect.assertions(1);

            const file = join(workDir, "in.ndjson");

            writeFileSync(file, JSON.stringify({ doc: { _id: "u1" }, table: "users" }), "utf8");

            const fetchImpl: StreamingFetchLike = async () => {
                return {
                    body: null,
                    json: async () => {
                        return {
                            conflicts: 0,
                            errors: [{ code: "VALIDATION_ERROR", line: 1, message: "bad", table: "users" }],
                            inserted: {},
                        };
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            const result = await runImportCommand({
                fetchImpl,
                file,
                logger: silentLogger(),
                token: "t",
            });

            expect(result.code).toBe(1);
        });
    });
});
