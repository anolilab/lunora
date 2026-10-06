import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import { runExportCommand, runImportCommand } from "../../src/commands/data-transfer";
import { EXIT_CODE } from "../../src/util/exit-code";
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

                expect(result.code).toBe(EXIT_CODE.AUTH);
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

        it("leaves no staged .partial behind once a mid-stream failure has been reported", async () => {
            expect.assertions(2);

            const outPath = join(workDir, "dump.ndjson");
            // Errors before the stream's lazy open can finish: the case where an
            // unlink issued straight after destroy() ran ahead of the file's creation.
            const failingBody = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.error(new Error("connection reset"));
                },
            });
            const fetchImpl: StreamingFetchLike = async () => {
                return { body: failingBody, json: async () => undefined, ok: true, status: 200, text: async () => "" };
            };

            await expect(runExportCommand({ fetchImpl, logger: silentLogger(), out: outPath, token: "t", url: "http://localhost:8787" })).rejects.toThrow(
                "connection reset",
            );

            // Give a still-pending open the chance to land before looking.
            await new Promise((resolve) => {
                setTimeout(resolve, 50);
            });

            expect(readdirSync(workDir).filter((entry) => entry.endsWith(".partial"))).toStrictEqual([]);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.NOT_FOUND);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

        describe("--replace", () => {
            /**
             * A worker with staged replace import: stages each batch, commits with one
             * deletion, recording the calls. `stageErrors` makes every batch refuse a
             * row; `staged: false` is a worker without staged import.
             */
            const replaceFetch =
                (calls: { body: string; url: string }[], worker: { staged?: boolean; stageErrors?: boolean } = {}): StreamingFetchLike =>
                async (url, init) => {
                    calls.push({ body: bodyText(init?.body), url });

                    const rows = bodyText(init?.body)
                        .split("\n")
                        .filter((line) => line.trim().length > 0);
                    let payload: Record<string, unknown> = {
                        errors: worker.stageErrors === true ? [{ code: "VALIDATION_ERROR", line: 1, message: "bad", table: "users" }] : [],
                        failed: [],
                        received: rows.length,
                        staged: { users: rows.length },
                    };

                    if (url.endsWith("/abort")) {
                        payload = { aborted: false };
                    } else if (url.endsWith("/commit")) {
                        payload = { deleted: { users: 2 }, inserted: { users: 2 }, status: "committed" };
                    }

                    const ok = worker.staged !== false || !url.endsWith("/abort");

                    return {
                        body: null,
                        json: async () => payload,
                        ok,
                        status: ok ? 200 : 404,
                        text: async () => "",
                    };
                };

            const writeRows = (rows: ReadonlyArray<unknown>): string => {
                const file = join(workDir, "replace.ndjson");

                writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");

                return file;
            };

            it("stages every batch of --tables into one session, commits it once, and reports what it deleted", async () => {
                expect.assertions(5);

                const file = writeRows([
                    { doc: { _id: "u1" }, table: "users" },
                    { doc: { _id: "m1" }, table: "messages" },
                    { doc: { key: "k", namespace: "CACHE", value: "AQ==" }, table: "$kv" },
                    { doc: { _id: "u2" }, table: "users" },
                ]);
                const calls: { body: string; url: string }[] = [];
                const infos: string[] = [];
                const warnings: string[] = [];

                const result = await runImportCommand({
                    batchSize: 1,
                    fetchImpl: replaceFetch(calls),
                    file,
                    logger: { ...silentLogger(), info: (message) => infos.push(message), warn: (message) => warnings.push(message) },
                    replace: true,
                    tables: "users",
                    token: "t",
                    url: "http://localhost:8787",
                    yes: true,
                });

                expect(result.code).toBe(0);
                expect(calls.map((call) => call.url.replace(/stage=cli-[\da-f-]+/u, "stage=<session>"))).toStrictEqual([
                    "http://localhost:8787/_lunora/admin/import/abort",
                    "http://localhost:8787/_lunora/admin/import?mode=replace&tables=users&stage=<session>",
                    "http://localhost:8787/_lunora/admin/import?mode=replace&tables=users&stage=<session>",
                    "http://localhost:8787/_lunora/admin/import/commit",
                ]);
                expect(result.body?.deleted).toStrictEqual({ users: 2 });
                expect(infos).toContain("replace: deleted 2 row(s) from users");
                expect(warnings).toStrictEqual([
                    "replace: skipped 1 row(s) of messages, which is not in --tables",
                    "replace: skipped 1 row(s) of $kv, which is not in --tables",
                ]);
            });

            it("sends an empty replace, since an empty file empties the tables", async () => {
                expect.assertions(2);

                const calls: { body: string; url: string }[] = [];

                const result = await runImportCommand({
                    fetchImpl: replaceFetch(calls),
                    file: writeRows([]),
                    logger: silentLogger(),
                    replace: true,
                    token: "t",
                    url: "http://localhost:8787",
                    yes: true,
                });

                expect(result.code).toBe(0);
                expect(
                    calls.map((call) => [call.url.replace(/stage=cli-[\da-f-]+/u, "stage=<session>"), call.url.endsWith("/abort") ? "" : call.body]),
                ).toStrictEqual([
                    ["http://localhost:8787/_lunora/admin/import/abort", ""],
                    ["http://localhost:8787/_lunora/admin/import?mode=replace&stage=<session>", ""],
                    ["http://localhost:8787/_lunora/admin/import/commit", calls[2]?.body],
                ]);
            });

            it("asks first, and writes nothing when the prompt is declined", async () => {
                expect.assertions(3);

                const calls: { body: string; url: string }[] = [];
                const prompts: string[] = [];

                const result = await runImportCommand({
                    confirm: async (prompt) => {
                        prompts.push(prompt);

                        return false;
                    },
                    fetchImpl: replaceFetch(calls),
                    file: writeRows([{ doc: { _id: "u1" }, table: "users" }]),
                    logger: silentLogger(),
                    replace: true,
                    table: "users",
                    token: "t",
                    url: "http://localhost:8787",
                });

                expect(result.code).toBe(EXIT_CODE.CANCELLED);
                expect(prompts[0]).toContain("the table(s) users");
                expect(calls).toHaveLength(0);
            });

            it("refuses without --yes when there is no TTY to ask on", async () => {
                expect.assertions(2);

                const calls: { body: string; url: string }[] = [];
                const { isTTY } = process.stdin;

                process.stdin.isTTY = false;

                try {
                    const result = await runImportCommand({
                        fetchImpl: replaceFetch(calls),
                        file: writeRows([{ doc: { _id: "u1" }, table: "users" }]),
                        logger: silentLogger(),
                        replace: true,
                        token: "t",
                        url: "http://localhost:8787",
                    });

                    expect(result.code).toBe(EXIT_CODE.USAGE);
                    expect(calls).toHaveLength(0);
                } finally {
                    process.stdin.isTTY = isTTY;
                }
            });

            it("refuses --tables without --replace", async () => {
                expect.assertions(1);

                const result = await runImportCommand({ file: writeRows([]), logger: silentLogger(), tables: "users", token: "t" });

                expect(result.code).toBe(EXIT_CODE.USAGE);
            });

            it("refuses a worker without staged import before it sends a row", async () => {
                expect.assertions(2);

                const calls: { body: string; url: string }[] = [];
                const result = await runImportCommand({
                    fetchImpl: replaceFetch(calls, { staged: false }),
                    file: writeRows([{ doc: { _id: "u1" }, table: "users" }]),
                    logger: silentLogger(),
                    replace: true,
                    token: "t",
                    url: "http://localhost:8787",
                    yes: true,
                });

                expect(result.code).toBe(1);
                expect(calls.map((call) => call.url)).toStrictEqual(["http://localhost:8787/_lunora/admin/import/abort"]);
            });

            it("aborts, and never commits, when a staged batch refuses a row", async () => {
                expect.assertions(2);

                const calls: { body: string; url: string }[] = [];
                const result = await runImportCommand({
                    fetchImpl: replaceFetch(calls, { stageErrors: true }),
                    file: writeRows([{ doc: { _id: "u1" }, table: "users" }]),
                    logger: silentLogger(),
                    replace: true,
                    token: "t",
                    url: "http://localhost:8787",
                    yes: true,
                });

                expect(result.code).toBe(1);
                expect(calls.map((call) => call.url.split("?")[0])).toStrictEqual([
                    "http://localhost:8787/_lunora/admin/import/abort",
                    "http://localhost:8787/_lunora/admin/import",
                    "http://localhost:8787/_lunora/admin/import/abort",
                ]);
            });
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
