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

/** Records every row the import posts. */
const fakeWorker = () => {
    const imported: { doc: Record<string, unknown>; table: string }[] = [];

    const fetchImpl: StreamingFetchLike = async (input, init) => {
        const inserted: Record<string, number> = {};

        if (new URL(input).pathname === "/_lunora/admin/import") {
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
                return { conflicts: 0, errors: [], inserted, received: imported.length };
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
            if (new URL(input).pathname === "/_lunora/admin/import") {
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
});
