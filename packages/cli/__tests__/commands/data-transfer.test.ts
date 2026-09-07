import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import { runExportCommand, runImportCommand } from "../../src/commands/data-transfer";
import type { Logger } from "../../src/util/logger";

/** Decode a request body for assertions — the fetch shim also carries blob bytes. */
const bodyText = (body: string | Uint8Array | undefined): string => {
    if (typeof body === "string") {
        return body;
    }

    return body === undefined ? "" : new TextDecoder().decode(body);
};

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workDir: string;

describe("lunora data-transfer", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-cli-data-transfer-"));
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

    /** A worker that answers one NDJSON row carrying something worth not disclosing. */
    const oneRowFetch = (): StreamingFetchLike => async (): ReturnType<StreamingFetchLike> => {
        return {
            body: stringStream(`${JSON.stringify({ doc: { _id: "u1", ssn: "000-00-0000" }, table: "users" })}\n`),
            json: async () => undefined,
            ok: true,
            status: 200,
            text: async () => "",
        };
    };

    describe("runExportCommand", () => {
        it("fails when no admin token is provided", async () => {
            expect.hasAssertions();

            const previous = process.env["LUNORA_ADMIN_TOKEN"];

            delete process.env["LUNORA_ADMIN_TOKEN"];

            try {
                const result = await runExportCommand({ logger: silentLogger() });

                expect(result.code).toBe(1);
            } finally {
                if (previous !== undefined) {
                    process.env["LUNORA_ADMIN_TOKEN"] = previous;
                }
            }
        });

        it("streams NDJSON into the --out file when configured", async () => {
            expect.assertions(5);

            const calls: { body: unknown; headers?: Record<string, string>; url: string }[] = [];
            const ndjson = `${JSON.stringify({ doc: { _id: "u1" }, table: "users" })}\n${JSON.stringify({ doc: { _id: "u2" }, table: "users" })}\n`;

            const fetchImpl: StreamingFetchLike = async (url, init) => {
                calls.push({ body: init?.body ? JSON.parse(bodyText(init.body)) : undefined, headers: init?.headers, url });

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
            expect(calls[0]!.url).toBe("http://localhost:8787/_lunora/admin/export");
            expect(calls[0]!.headers?.["authorization"]).toBe("Bearer test-token");
            expect(readFileSync(outPath, "utf8")).toBe(ndjson);
        });

        it("forwards --tables to the request body", async () => {
            expect.assertions(1);

            const calls: { body: { tables?: unknown } }[] = [];

            const fetchImpl: StreamingFetchLike = async (_url, init) => {
                calls.push({ body: init?.body ? (JSON.parse(bodyText(init.body)) as { tables?: unknown }) : {} });

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

        it("leaves an existing --out file intact when the export fails mid-stream", async () => {
            expect.assertions(3);

            const outPath = join(workDir, "yesterday.ndjson");
            const yesterday = `${JSON.stringify({ doc: { _id: "old" }, table: "users" })}\n`;

            writeFileSync(outPath, yesterday, "utf8");

            // The body starts fine and then errors — the shape of a dropped
            // connection part-way through a large dump.
            const failingBody = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"table":"users","doc":{"_id":"u1"}}\n'));
                    controller.error(new Error("connection reset"));
                },
            });

            const fetchImpl: StreamingFetchLike = async () => {
                return { body: failingBody, json: async () => undefined, ok: true, status: 200, text: async () => "" };
            };

            await expect(runExportCommand({ fetchImpl, logger: silentLogger(), out: outPath, token: "t", url: "http://localhost:8787" })).rejects.toThrow(
                "connection reset",
            );

            // Yesterday's dump is still there, byte for byte.
            expect(existsSync(outPath)).toBe(true);
            expect(readFileSync(outPath, "utf8")).toBe(yesterday);
        });

        it("discards the staged dump when the commit rename fails", async () => {
            expect.assertions(2);

            // `--out` is an existing directory, so the stage → commit `rename`
            // rejects after every row is on disk. The staged `.partial` holds the
            // complete plaintext export; leaving it behind is the same disclosure
            // the stage/commit was added to prevent.
            const outPath = join(workDir, "already-a-directory");

            mkdirSync(outPath, { recursive: true });

            await expect(
                runExportCommand({ fetchImpl: oneRowFetch(), logger: silentLogger(), out: outPath, token: "t", url: "http://localhost:8787" }),
            ).rejects.toThrow(/EISDIR/u);

            expect(readdirSync(workDir).filter((entry) => entry.endsWith(".partial"))).toStrictEqual([]);
        });

        it("keeps the exported dump private under a permissive umask", async () => {
            expect.assertions(1);

            const outPath = join(workDir, "private.ndjson");

            // `createWriteStream` opens at 0666 before the umask, so without an
            // explicit mode the dump is world-readable on any box that does not
            // narrow it — and a dump is every row of every table.
            // eslint-disable-next-line sonarjs/file-permissions -- widening the umask IS the test: it is what makes an unset `mode` observable, and it is restored in the `finally`
            const previousUmask = process.umask(0o000);

            try {
                await runExportCommand({
                    fetchImpl: oneRowFetch(),
                    logger: silentLogger(),
                    out: outPath,
                    token: "t",
                    url: "http://localhost:8787",
                });

                // eslint-disable-next-line no-bitwise -- reading the permission bits IS the assertion
                expect(statSync(outPath).mode & 0o777).toBe(0o600);
            } finally {
                process.umask(previousUmask);
            }
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

        it("refuses a remote --url without --yes even when --prod is not passed", async () => {
            expect.assertions(3);

            const file = join(workDir, "remote.ndjson");

            writeFileSync(file, `${JSON.stringify({ doc: { _id: "u1" }, table: "users" })}\n`, "utf8");

            const errors: string[] = [];
            const calls: string[] = [];
            const fetchImpl: StreamingFetchLike = async (url) => {
                calls.push(url);

                return {
                    body: null,
                    json: async () => {
                        return { conflicts: 0, errors: [], inserted: {} };
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            const result = await runImportCommand({
                fetchImpl,
                file,
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
                token: "t",
                url: "https://prod.example.invalid",
            });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.join("\n")).toContain("--yes");
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
                calls.push({ body: bodyText(init?.body), url });

                const rows = bodyText(init?.body)
                    .split("\n")
                    .filter((line) => line.trim().length > 0);

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
            expect(calls[0]!.url).toBe("http://localhost:8787/_lunora/admin/import");
        });

        it("wraps bare docs with `--table` into `{table,doc}` envelopes", async () => {
            expect.assertions(1);

            const file = join(workDir, "users-bare.ndjson");

            writeFileSync(file, `${JSON.stringify({ _id: "u1", email: "a@b.com" })}\n${JSON.stringify({ _id: "u2", email: "c@d.com" })}\n`, "utf8");

            const captured: { body: string }[] = [];

            const fetchImpl: StreamingFetchLike = async (_url, init) => {
                captured.push({ body: bodyText(init?.body) });

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

        it("imports a Convex export directory, preserving ids and every foreign key", async () => {
            expect.assertions(4);

            // A two-pass import looks necessary here: insert with FKs
            // nulled, record `convexId -> lunoraId`, then patch the FKs back —
            // needed because Convex ids are opaque and a naive per-table import
            // would break every `v.id()` column, with self-referential cycles
            // (folders.parentId) defeating a topological sort.
            //
            // None of that is necessary. The admin import path inserts with
            // `allowExplicitId`, so `_id` survives verbatim, and `v.id()`
            // validates only "is a string". Ids carry across unchanged, so the
            // FKs that already point at them stay correct — one pass, no map.
            mkdirSync(join(workDir, "folders"), { recursive: true });
            mkdirSync(join(workDir, "messages"), { recursive: true });

            writeFileSync(
                join(workDir, "folders", "documents.jsonl"),
                // A self-referential FK — the shape that has no topological order.
                `${JSON.stringify({ _creationTime: 1, _id: "fld_root", name: "root", parentId: null })}\n` +
                    `${JSON.stringify({ _creationTime: 2, _id: "fld_child", name: "child", parentId: "fld_root" })}\n`,
                "utf8",
            );
            writeFileSync(
                join(workDir, "messages", "documents.jsonl"),
                `${JSON.stringify({ _creationTime: 3, _id: "msg_1", folderId: "fld_child" })}\n`,
                "utf8",
            );

            const captured: string[] = [];

            const fetchImpl: StreamingFetchLike = async (_url, init) => {
                captured.push(bodyText(init?.body));

                return {
                    body: null,
                    json: async () => {
                        return { conflicts: 0, errors: [], inserted: { folders: 2, messages: 1 } };
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            const result = await runImportCommand({ fetchImpl, file: workDir, logger: silentLogger(), token: "t" });
            const rows = captured
                .join("\n")
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line) as { doc: Record<string, unknown>; table: string });

            expect(result.inserted).toBe(3);
            // Tables come from the directory names, sorted.
            expect(rows.map((row) => row.table)).toStrictEqual(["folders", "folders", "messages"]);
            // The self-reference still points at the parent's original id.
            expect(rows[1]?.doc).toStrictEqual({ _creationTime: 2, _id: "fld_child", name: "child", parentId: "fld_root" });
            // And so does the cross-table FK.
            expect(rows[2]?.doc["folderId"]).toBe("fld_child");
        });

        it("reports an empty directory rather than silently importing nothing", async () => {
            expect.assertions(1);

            // A directory with no `<table>/documents.jsonl` is not a Convex
            // export; falling through to the NDJSON reader would try to
            // `createReadStream` a directory and fail obscurely.
            mkdirSync(join(workDir, "not-an-export"), { recursive: true });

            const fetchImpl: StreamingFetchLike = async () => {
                return {
                    body: null,
                    json: async () => {
                        return {};
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            const result = await runImportCommand({ fetchImpl, file: join(workDir, "not-an-export"), logger: silentLogger(), token: "t" });

            expect(result.code).toBe(1);
        });

        it("refuses --table alongside a Convex export directory", async () => {
            expect.assertions(2);

            // Each row's table comes from its source directory; a global
            // `--table` would silently relabel all of them.
            mkdirSync(join(workDir, "users"), { recursive: true });
            writeFileSync(join(workDir, "users", "documents.jsonl"), `${JSON.stringify({ _id: "u1" })}\n`, "utf8");

            let called = false;
            const fetchImpl: StreamingFetchLike = async () => {
                called = true;

                return {
                    body: null,
                    json: async () => {
                        return {};
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

            const result = await runImportCommand({ fetchImpl, file: workDir, logger: silentLogger(), table: "other", token: "t" });

            expect(result.code).toBe(1);
            expect(called).toBe(false);
        });

        it("refuses --prod without --yes (no request is made)", async () => {
            expect.assertions(2);

            const file = join(workDir, "in.ndjson");

            writeFileSync(file, JSON.stringify({ doc: { _id: "u1" }, table: "users" }), "utf8");

            const calls: string[] = [];
            const fetchImpl: StreamingFetchLike = async (url) => {
                calls.push(url);

                return {
                    body: null,
                    json: async () => {
                        return { inserted: {} };
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
                prod: true,
                token: "t",
                url: "https://app.example.com",
            });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
        });

        it("proceeds with --prod when --yes confirms", async () => {
            expect.assertions(2);

            const file = join(workDir, "in.ndjson");

            writeFileSync(file, JSON.stringify({ doc: { _id: "u1" }, table: "users" }), "utf8");

            const calls: string[] = [];
            const fetchImpl: StreamingFetchLike = async (url) => {
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

            const result = await runImportCommand({
                fetchImpl,
                file,
                logger: silentLogger(),
                prod: true,
                token: "t",
                url: "https://app.example.com",
                yes: true,
            });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
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
