import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import { runImportCommand } from "../../src/commands/data-transfer";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";

type Doc = Record<string, unknown> & { _id: string };

const stream = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });

const json = (value: unknown): Awaited<ReturnType<StreamingFetchLike>> => {
    return { body: null, json: async () => value, ok: true, status: 200, text: async () => JSON.stringify(value) };
};

/**
 * A worker over an in-memory store that speaks the admin export and import
 * endpoints, including `?onConflict=replace` and `op: "delete"` rows (only under `?deletes=true`). `refuse`
 * names `_id`s whose write it reports as a row error.
 */
const fakeWorker = (
    initial: Record<string, Doc[]>,
    options: {
        canDelete?: boolean;
        onExport?: () => void;
        refuse?: ReadonlyArray<string>;
        /** Tables whose delete rows fail the whole request, as a `.global()` importer without delete support does. */
        undeletable?: ReadonlyArray<string>;
        vanish?: ReadonlyArray<string>;
    } = {},
) => {
    const stored = new Map(Object.entries(initial).map(([table, docs]) => [table, new Map(docs.map((doc) => [doc._id, doc]))]));
    const writes: string[] = [];

    /** Apply one row to the store and name what happened to it. */
    const apply = (row: { doc: Doc; op?: string; table: string }, replace: boolean): "conflict" | "deleted" | "inserted" | "noop" | "refused" | "replaced" => {
        writes.push(`${row.op ?? "write"} ${row.table}/${row.doc._id}`);

        const table = stored.get(row.table) ?? new Map<string, Doc>();

        stored.set(row.table, table);

        if (row.op === "delete") {
            return table.delete(row.doc._id) ? "deleted" : "noop";
        }

        if (options.vanish?.includes(row.doc._id) === true) {
            return "noop";
        }

        if (options.refuse?.includes(row.doc._id) === true) {
            return "refused";
        }

        if (table.has(row.doc._id) && !replace) {
            return "conflict";
        }

        const outcome = table.has(row.doc._id) ? "replaced" : "inserted";

        table.set(row.doc._id, row.doc);

        return outcome;
    };

    const fetchImpl: StreamingFetchLike = async (url, init) => {
        const { pathname, searchParams } = new URL(url);
        const body = typeof init?.body === "string" ? init.body : "";

        if (pathname === "/_lunora/admin/export") {
            options.onExport?.();

            const { tables } = JSON.parse(body) as { tables: string[] };
            const lines = tables.flatMap((table) => [...(stored.get(table)?.values() ?? [])].map((doc) => `${JSON.stringify({ doc, table })}\n`));

            return { body: stream(lines.join("")), json: async () => undefined, ok: true, status: 200, text: async () => "" };
        }

        const dryRun = searchParams.get("dryRun") === "true";
        const replace = searchParams.get("onConflict") === "replace";
        const deletes = searchParams.get("deletes") === "true";
        const result = { conflicts: 0, deleted: 0, errors: [] as unknown[], inserted: {} as Record<string, number>, received: 0, replaced: 0 };
        const rows = body.split("\n").filter((entry) => entry.trim().length > 0);

        if (
            rows.some((raw) => {
                const row = JSON.parse(raw) as { op?: string; table: string };

                return row.op === "delete" && options.undeletable?.includes(row.table) === true;
            })
        ) {
            return { body: null, json: async () => undefined, ok: false, status: 400, text: async () => "delete rows target global tables" };
        }

        result.received = rows.length;

        if (!dryRun) {
            rows.forEach((raw, index) => {
                const row = JSON.parse(raw) as { doc: Doc; op?: string; table: string };

                // As the runtime does: a delete row counts only on a request that asked for deletes.
                if (row.op === "delete" && !deletes) {
                    result.errors.push({ code: "BAD_ROW", line: index + 1, message: "delete without ?deletes=true", table: row.table });

                    return;
                }

                const outcome = apply(row, replace);

                if (outcome === "refused") {
                    result.errors.push({ code: "VALIDATION_ERROR", line: index + 1, message: "refused", table: row.table });
                } else if (outcome === "inserted") {
                    result.inserted[row.table] = (result.inserted[row.table] ?? 0) + 1;
                } else if (outcome !== "noop") {
                    result[outcome === "conflict" ? "conflicts" : outcome] += 1;
                }
            });
        }

        const { deleted, ...rest } = result;

        return json({
            ...rest,
            ...(options.canDelete === false ? {} : { deleted }),
            ...(dryRun ? { dryRun: true } : {}),
            ...(replace ? { onConflict: "replace" } : {}),
        });
    };

    const ids = (table: string): string[] => [...(stored.get(table)?.keys() ?? [])].toSorted((a, b) => a.localeCompare(b));

    return { fetchImpl, ids, stored, writes };
};

const capture = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];

    return {
        lines,
        logger: {
            error: (message) => lines.push(`error: ${message}`),
            info: (message) => lines.push(message),
            success: (message) => lines.push(message),
            warn: (message) => lines.push(`warn: ${message}`),
        },
    };
};

let workDir: string;

const writeFile = (rows: ReadonlyArray<{ doc: Doc; table: string }>): string => {
    const file = join(workDir, "snapshot.ndjson");

    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");

    return file;
};

const SNAPSHOT = [
    { doc: { _id: "u1", name: "from the snapshot" }, table: "users" },
    { doc: { _id: "u3", name: "only in the snapshot" }, table: "users" },
];

describe("lunora import --mode", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-import-modes-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    it("replace makes each table in the file hold exactly its rows, and leaves other tables alone", async () => {
        expect.assertions(5);

        const worker = fakeWorker({
            posts: [{ _id: "p1" }],
            users: [
                { _id: "u1", name: "live" },
                { _id: "u2", name: "not in the snapshot" },
            ],
        });
        const { logger } = capture();

        const result = await runImportCommand({ fetchImpl: worker.fetchImpl, file: writeFile(SNAPSHOT), logger, mode: "replace", token: "t", yes: true });

        expect(result.code).toBe(0);
        expect(worker.ids("users")).toStrictEqual(["u1", "u3"]);
        expect(worker.stored.get("users")?.get("u1")).toStrictEqual({ _id: "u1", name: "from the snapshot" });
        expect(worker.ids("posts")).toStrictEqual(["p1"]);
        expect(result.body).toMatchObject({
            deleted: 1,
            plan: [{ add: 1, delete: 1, existing: 1, source: 2, table: "users", target: 2 }],
            replaced: 1,
        });
    });

    it("replace deletes nothing when the write did not finish cleanly, so a failed run never leaves fewer rows", async () => {
        expect.assertions(3);

        const worker = fakeWorker({ users: [{ _id: "u1" }, { _id: "u2" }] }, { refuse: ["u3"] });
        const { lines, logger } = capture();

        const result = await runImportCommand({ fetchImpl: worker.fetchImpl, file: writeFile(SNAPSHOT), logger, mode: "replace", token: "t", yes: true });

        expect(result.code).toBe(1);
        expect(worker.ids("users")).toStrictEqual(["u1", "u2"]);
        expect(lines.join("\n")).toMatch(/were NOT deleted; fix the errors and re-run the same command/u);
    });

    it("replace deletes nothing when --verify finds a row the worker never accounted for", async () => {
        expect.assertions(2);

        // `--verify` checks row parity only for a converted export, so the source is a Firestore dump.
        const dump = join(workDir, "dump");

        mkdirSync(dump, { recursive: true });
        writeFileSync(join(dump, "users.json"), JSON.stringify({ u1: { name: { stringValue: "a" } }, u3: { name: { stringValue: "b" } } }), "utf8");

        const worker = fakeWorker({ users: [{ _id: "u1" }, { _id: "u2" }] }, { vanish: ["u3"] });

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: dump,
            from: "firebase",
            logger: capture().logger,
            mode: "replace",
            token: "t",
            verify: true,
            yes: true,
        });

        expect(result.code).toBe(1);
        expect(worker.ids("users")).toStrictEqual(["u1", "u2"]);
    });

    it("replace keeps a row the file gained after the plan read it", async () => {
        expect.assertions(2);

        const file = writeFile(SNAPSHOT);
        const worker = fakeWorker(
            { users: [{ _id: "u1" }, { _id: "u2", name: "stored" }] },
            {
                onExport: () => {
                    writeFileSync(file, `${readFileSync(file, "utf8")}\n${JSON.stringify({ doc: { _id: "u2", name: "added" }, table: "users" })}`, "utf8");
                },
            },
        );

        const result = await runImportCommand({ fetchImpl: worker.fetchImpl, file, logger: capture().logger, mode: "replace", token: "t", yes: true });

        expect(result.code).toBe(0);
        expect(worker.stored.get("users")?.get("u2")).toStrictEqual({ _id: "u2", name: "added" });
    });

    it("upsert with --yes reads no stored rows, since its plan would only feed a confirmation", async () => {
        expect.assertions(2);

        let exports = 0;
        const worker = fakeWorker(
            { users: [{ _id: "u1", name: "live" }] },
            {
                onExport: () => {
                    exports += 1;
                },
            },
        );

        const result = await runImportCommand({
            fetchImpl: worker.fetchImpl,
            file: writeFile(SNAPSHOT),
            logger: capture().logger,
            mode: "upsert",
            token: "t",
            yes: true,
        });

        expect(result.code).toBe(0);
        expect(exports).toBe(0);
    });

    it("replace writes nothing when the worker would refuse some of the planned deletes", async () => {
        expect.assertions(3);

        const worker = fakeWorker({ settings: [{ _id: "s1" }, { _id: "s2" }], users: [{ _id: "u1" }, { _id: "u2" }] }, { undeletable: ["settings"] });
        const file = writeFile([...SNAPSHOT, { doc: { _id: "s1" }, table: "settings" }]);

        const result = await runImportCommand({ fetchImpl: worker.fetchImpl, file, logger: capture().logger, mode: "replace", token: "t", yes: true });

        expect(result.code).toBe(1);
        expect(result.error).toMatch(/would refuse the deletes/u);
        expect(worker.writes).toStrictEqual([]);
    });

    it("replace is refused before anything moves by a worker that cannot delete rows", async () => {
        expect.assertions(2);

        const worker = fakeWorker({ users: [{ _id: "u2" }] }, { canDelete: false });

        const result = await runImportCommand({
            fetchImpl: worker.fetchImpl,
            file: writeFile(SNAPSHOT),
            logger: capture().logger,
            mode: "replace",
            token: "t",
            yes: true,
        });

        expect(result.error).toMatch(/cannot delete rows/u);
        expect(worker.writes).toStrictEqual([]);
    });

    it("require-empty refuses a populated table and writes nothing", async () => {
        expect.assertions(3);

        const worker = fakeWorker({ users: [{ _id: "u9" }] });
        const { lines, logger } = capture();

        const result = await runImportCommand({ fetchImpl: worker.fetchImpl, file: writeFile(SNAPSHOT), logger, mode: "require-empty", token: "t" });

        expect(result.code).toBe(1);
        expect(worker.writes).toStrictEqual([]);
        expect(lines.join("\n")).toMatch(/the target already holds users \(1 rows\)/u);
    });

    it("require-empty imports into empty tables", async () => {
        expect.assertions(2);

        const worker = fakeWorker({ posts: [{ _id: "p1" }] });

        const result = await runImportCommand({
            fetchImpl: worker.fetchImpl,
            file: writeFile(SNAPSHOT),
            logger: capture().logger,
            mode: "require-empty",
            token: "t",
        });

        expect(result.code).toBe(0);
        expect(worker.ids("users")).toStrictEqual(["u1", "u3"]);
    });

    it("--dry-run prints the plan and writes nothing", async () => {
        expect.assertions(3);

        const worker = fakeWorker({ users: [{ _id: "u1" }, { _id: "u2" }] });
        const { lines, logger } = capture();

        const result = await runImportCommand({ dryRun: true, fetchImpl: worker.fetchImpl, file: writeFile(SNAPSHOT), logger, mode: "replace", token: "t" });

        expect(result.code).toBe(0);
        expect(worker.writes).toStrictEqual([]);
        expect(lines).toContain("  users: 2 in file, 2 stored — 1 to add, 1 replaced, 1 to delete");
    });

    it("an overwrite needs --yes without a TTY, and a declined prompt writes nothing", async () => {
        expect.assertions(4);

        const worker = fakeWorker({ users: [{ _id: "u1" }] });
        const file = writeFile(SNAPSHOT);

        const unattended = await runImportCommand({ fetchImpl: worker.fetchImpl, file, logger: capture().logger, mode: "upsert", token: "t" });
        const declined = await runImportCommand({
            confirm: async () => false,
            fetchImpl: worker.fetchImpl,
            file,
            logger: capture().logger,
            mode: "upsert",
            token: "t",
        });

        expect(unattended.code).toBe(EXIT_CODE.USAGE);
        expect(declined.code).toBe(EXIT_CODE.CANCELLED);
        expect(worker.writes).toStrictEqual([]);

        const confirmed = await runImportCommand({
            confirm: async () => true,
            fetchImpl: worker.fetchImpl,
            file,
            logger: capture().logger,
            mode: "upsert",
            token: "t",
        });

        expect(confirmed.code).toBe(0);
    });
});
