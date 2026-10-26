/**
 * The import batcher's ceilings and partial-failure reporting. These drive
 * `runImportCommand` because that is where a batch is actually POSTed, but none
 * of them are about storage — they were living in the storage test file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import { runImportCommand } from "../../src/commands/data-transfer";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { logger: Logger; logs: { error: string[]; warn: string[] } } => {
    const logs = { error: [] as string[], warn: [] as string[] };

    return {
        logger: {
            error: (message: string) => logs.error.push(message),
            info: () => {},
            success: () => {},
            warn: (message: string) => logs.warn.push(message),
        },
        logs,
    };
};

let workDir: string;

/** Write a `npx convex export` directory with the given tables. */
const writeConvexExport = (_blobs: Record<string, string>, tables: Record<string, Record<string, unknown>[]>): string => {
    const root = join(workDir, "convex-export");

    mkdirSync(root, { recursive: true });

    for (const [table, rows] of Object.entries(tables)) {
        mkdirSync(join(root, table), { recursive: true });
        writeFileSync(join(root, table, "documents.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    }

    return root;
};

/**
 * The probe the command sends before any row: a `?dryRun=true` POST whose body is a blank line. A worker that honours the flag answers it with
 * the echo, and nothing else.
 */
const isProbe = (input: string, init?: { body?: string | Uint8Array }): boolean =>
    new URL(input).searchParams.get("dryRun") === "true" && String(init?.body ?? "").trim() === "";

const probeReply = (): Awaited<ReturnType<StreamingFetchLike>> => {
    return {
        body: null,
        json: async () => {
            return { conflicts: 0, dryRun: true, errors: [], inserted: {}, received: 0 };
        },
        ok: true,
        status: 200,
        text: async () => "",
    };
};

/** Records every row the import posts. A `dryRun` POST is a check: it answers as the real pass would, and records and inserts nothing. */
const fakeWorker = () => {
    const imported: { doc: Record<string, unknown>; table: string }[] = [];

    const fetchImpl: StreamingFetchLike = async (input, init) => {
        const inserted: Record<string, number> = {};
        const dryRun = new URL(input).searchParams.get("dryRun") === "true";

        if (new URL(input).pathname === "/_lunora/admin/import" && !dryRun) {
            for (const line of String(init?.body ?? "")
                .split("\n")
                .filter((entry) => entry.trim().length > 0)) {
                const row = JSON.parse(line) as { doc: Record<string, unknown>; table: string };

                imported.push(row);
                inserted[row.table] = (inserted[row.table] ?? 0) + 1;
            }
        }

        return {
            body: null,
            json: async () => {
                return { conflicts: 0, errors: [], inserted, received: imported.length, ...(dryRun ? { dryRun: true } : {}) };
            },
            ok: true,
            status: 200,
            text: async () => "",
        };
    };

    return { fetchImpl, imported };
};

/** Wrap a worker's fetch so each import POST's body size is recorded. */
const measureImportBodies = (worker: { fetchImpl: StreamingFetchLike }): { bodies: number[]; measuringFetch: StreamingFetchLike } => {
    const bodies: number[] = [];

    return {
        bodies,
        measuringFetch: async (input, init) => {
            if (new URL(input).pathname === "/_lunora/admin/import") {
                bodies.push(Buffer.byteLength(init?.body as string));
            }

            return worker.fetchImpl(input, init);
        },
    };
};

describe("the import batcher", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-import-batcher-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    it("does not claim rows were written when no batch was acknowledged", async () => {
        expect.assertions(3);

        const root = writeConvexExport({}, { docs: [{ _id: "d1" }] });
        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: async (input, init) => {
                if (isProbe(input, init)) {
                    return probeReply();
                }

                throw new TypeError("fetch failed");
            },
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(logs.error[0]).toBe("import failed before any batch was acknowledged: fetch failed");
        expect(logs.error.join("\n")).not.toContain("already been written");
    });

    it("splits a batch on byte size, not just row count", async () => {
        expect.assertions(2);

        // Ten rows of ~200 KiB: one 500-row batch would be ~2 MiB, over the
        // import endpoint's 1 MiB body cap.
        const rows = Array.from({ length: 10 }, (_, index) => {
            return { _id: `d${String(index)}`, blob: "y".repeat(200 * 1024) };
        });
        const root = writeConvexExport({}, { docs: rows });
        const worker = fakeWorker();
        const { bodies, measuringFetch } = measureImportBodies(worker);

        await runImportCommand({
            cwd: workDir,
            fetchImpl: measuringFetch,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(bodies.length).toBeGreaterThan(1);
        expect(Math.max(...bodies)).toBeLessThan(1_048_576);
    });

    it("never POSTs a body past the byte ceiling, even by one row", async () => {
        expect.assertions(2);

        // Rows just under a third of the ceiling: appending before flushing would
        // send four of them (~1.2 MiB) and 413 against the endpoint's 1 MiB cap.
        const rows = Array.from({ length: 9 }, (_, index) => {
            return { _id: `d${String(index)}`, blob: "z".repeat(300 * 1024) };
        });
        const root = writeConvexExport({}, { docs: rows });
        const worker = fakeWorker();
        const { bodies, measuringFetch } = measureImportBodies(worker);

        await runImportCommand({
            cwd: workDir,
            fetchImpl: measuringFetch,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(Math.max(...bodies)).toBeLessThanOrEqual(900_000);
        expect(worker.imported).toHaveLength(9);
    });

    it("reports what it managed to write when a batch fails part-way", async () => {
        expect.assertions(3);

        const root = writeConvexExport(
            {},
            {
                users: Array.from({ length: 5 }, (_, index) => {
                    return { _id: `u${String(index)}` };
                }),
            },
        );
        const worker = fakeWorker();
        let batches = 0;

        const failingFetch: StreamingFetchLike = async (input, init) => {
            // Counts the real batches only: a check POST runs first and must not use up the failure meant for the real pass.
            if (new URL(input).pathname === "/_lunora/admin/import" && new URL(input).searchParams.get("dryRun") !== "true") {
                batches += 1;

                if (batches === 2) {
                    return {
                        body: null,
                        json: async () => {
                            return {};
                        },
                        ok: false,
                        status: 500,
                        text: async () => "boom",
                    };
                }
            }

            return worker.fetchImpl(input, init);
        };

        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            batchSize: 2,
            cwd: workDir,
            fetchImpl: failingFetch,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
        });

        // The first batch landed; the operator has to be told how far it got
        // rather than just that something threw.
        expect(result.code).toBe(1);
        expect(result.inserted).toBe(2);
        expect(logs.error.join("\n")).toContain("import failed part-way through");
    });

    it("fails the run on a 207 partial import instead of reporting success", async () => {
        expect.assertions(4);

        // Regression: `Response.ok` is TRUE for 207, so a partial import — a shard
        // the fan-out never reached, its rows in neither `inserted` nor `errors` —
        // was reported as a clean success with exit 0.
        const root = writeConvexExport(
            {},
            {
                users: Array.from({ length: 2 }, (_, index) => {
                    return { _id: `u${String(index)}` };
                }),
            },
        );

        const partialFetch: StreamingFetchLike = async (input, init) => {
            if (isProbe(input, init)) {
                return probeReply();
            }

            if (new URL(input).pathname !== "/_lunora/admin/import") {
                return {
                    body: null,
                    json: async () => {
                        return {};
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            }

            return {
                body: null,
                json: async () => {
                    return {
                        conflicts: 0,
                        errors: [],
                        failed: [{ message: "shard did not respond", shardKey: "tenant-7", timedOut: true }],
                        inserted: { users: 1 },
                        received: 2,
                    };
                },
                ok: true,
                status: 207,
                text: async () => "",
            };
        };

        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: partialFetch,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(logs.error.join("\n")).toContain("tenant-7");
        expect(logs.error.join("\n")).toContain("timed out");
        expect(result.body?.failed).toStrictEqual([{ message: "shard did not respond", shardKey: "tenant-7", timedOut: true }]);
    });

    /** A worker that honours `?dryRun=true`: it refuses any row marked `refuse`, and writes the rest only on a real pass. */
    const checkingWorker =
        (writes: string[], dryRuns: boolean[]): StreamingFetchLike =>
        async (input, init) => {
            const dryRun = new URL(input).searchParams.get("dryRun") === "true";
            const rows = String(init?.body ?? "")
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line) as { doc: { _id: string; refuse?: boolean }; table: string });
            const errors = rows
                .filter((row) => row.doc.refuse === true)
                .map((row, index) => {
                    return { code: "INVALID", line: index + 1, message: "refused", table: row.table };
                });

            // The probe carries no row and is not a check, so only a POST with rows is recorded as one.
            if (rows.length > 0) {
                dryRuns.push(dryRun);
            }

            if (!dryRun) {
                writes.push(...rows.filter((row) => row.doc.refuse !== true).map((row) => row.doc._id));
            }

            return {
                body: null,
                json: async () => {
                    return { conflicts: 0, errors, inserted: {}, received: rows.length, ...(dryRun ? { dryRun: true } : {}) };
                },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

    it("writes no row when a later row would be refused, so the rows before it are not left behind", async () => {
        expect.assertions(4);

        const root = writeConvexExport({}, { docs: [{ _id: "d1" }, { _id: "d2" }, { _id: "d3", refuse: true }] });
        const writes: string[] = [];
        const dryRuns: boolean[] = [];
        const { logger } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: checkingWorker(writes, dryRuns),
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(result.error).toBe(`import: ${root} was not written: 1 row(s) would be refused`);
        expect(dryRuns).toStrictEqual([true]);
        expect(writes).toStrictEqual([]);
    });

    it("stops before the real pass when a worker writes during its check, as one that ignores the flag does", async () => {
        expect.assertions(5);

        const root = writeConvexExport({}, { docs: [{ _id: "d1" }, { _id: "d2" }] });
        const writes: string[] = [];
        const dryRuns: boolean[] = [];
        const { logger } = capturingLogger();
        const ignoringFlag: StreamingFetchLike = async (input, init) => {
            const worker = checkingWorker(writes, dryRuns);
            const response = await worker(input, init);

            // It echoes the flag, so the probe passes, but writes whatever a check is sent: the post-check still has to catch it.
            if (new URL(input).searchParams.get("dryRun") === "true") {
                writes.push(
                    ...String(init?.body ?? "")
                        .split("\n")
                        .filter((line) => line.trim().length > 0)
                        .map((line) => (JSON.parse(line) as { doc: { _id: string } }).doc._id),
                );

                return {
                    ...response,
                    json: async () => {
                        return { conflicts: 0, errors: [], inserted: { docs: 2 }, received: 2, dryRun: true };
                    },
                };
            }

            return response;
        };

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: ignoringFlag,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(result.error).toContain("wrote rows during its check");
        // The check's two rows are in the shard, so the refusal must not say nothing was written.
        expect(result.error).toContain("rows may already be written");
        expect(result.inserted).toBe(2);
        expect(dryRuns).toStrictEqual([true]);
    });

    it("says rows may already be written when the check only met _ids already in use", async () => {
        expect.assertions(3);

        const root = writeConvexExport({}, { docs: [{ _id: "d1" }] });
        const writes: string[] = [];
        const dryRuns: boolean[] = [];
        const { logger } = capturingLogger();
        const conflictingWorker: StreamingFetchLike = async (input, init) => {
            const worker = checkingWorker(writes, dryRuns);
            const response = await worker(input, init);

            if (new URL(input).searchParams.get("dryRun") === "true") {
                return {
                    ...response,
                    json: async () => {
                        return { conflicts: 1, errors: [], inserted: {}, received: 1, dryRun: true };
                    },
                };
            }

            return response;
        };

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: conflictingWorker,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(result.error).toContain("was refused, and rows may already be written");
        expect(writes).toStrictEqual([]);
    });

    it("refuses before sending any row to a worker that predates the dry-run flag, so the file is never written", async () => {
        expect.assertions(3);

        const root = writeConvexExport({}, { docs: [{ _id: "d1" }, { _id: "d2" }] });
        const writes: string[] = [];
        const { logger } = capturingLogger();
        // A worker from before the flag: it ignores `?dryRun=true`, writes every row it is sent, and never echoes the flag.
        const olderWorker: StreamingFetchLike = async (_input, init) => {
            const rows = String(init?.body ?? "")
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => (JSON.parse(line) as { doc: { _id: string } }).doc._id);

            writes.push(...rows);

            return {
                body: null,
                json: async () => {
                    return { conflicts: 0, errors: [], inserted: { docs: rows.length }, received: rows.length };
                },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: olderWorker,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(result.error).toContain("predates ?dryRun=true");
        expect(writes).toStrictEqual([]);
    });
});
