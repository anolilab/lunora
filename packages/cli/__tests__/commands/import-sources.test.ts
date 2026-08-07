/**
 * `lunora import --from supabase|firebase` — the foreign-source readers: CSV and
 * Firestore typed-value decoding, the declared reshapes, and the rule that a
 * reshape which would lose information errors rather than truncating.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface Sink {
    fetchImpl: StreamingFetchLike;
    imported: { doc: Record<string, unknown>; table: string }[];
}

/** A worker stand-in that records every row the import posts. */
const sink = (): Sink => {
    const imported: { doc: Record<string, unknown>; table: string }[] = [];

    return {
        fetchImpl: async (input, init) => {
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
        },
        imported,
    };
};

let workDir: string;

const writeDump = (files: Record<string, string>, directory = "dump"): string => {
    const root = join(workDir, directory);

    mkdirSync(root, { recursive: true });

    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(root, name), content, "utf8");
    }

    return root;
};

const writeMapping = (source: "firebase" | "supabase", mapping: unknown): void => {
    mkdirSync(join(workDir, "lunora"), { recursive: true });
    writeFileSync(join(workDir, "lunora", `import-${source}.json`), JSON.stringify(mapping), "utf8");
};

const runImport = async (file: string, from: "firebase" | "supabase", extra: Record<string, unknown> = {}) => {
    const worker = sink();
    const { logger, logs } = capturingLogger();

    const result = await runImportCommand({
        cwd: workDir,
        fetchImpl: worker.fetchImpl,
        file,
        from,
        logger,
        token: "t",
        url: "http://localhost:8787",
        ...extra,
    });

    return { imported: worker.imported, logs, result };
};

/**
 * A data-level failure (a bad cell, an undecodable document) aborts the run and
 * is reported: the command exits 1 with the reason logged, rather than throwing.
 * Config-level failures (an unknown reshape, a missing dump) throw before any
 * row is written — those are asserted with `rejects` directly.
 */
const expectAbort = async (file: string, from: "firebase" | "supabase", pattern: RegExp): Promise<void> => {
    const { imported, logs, result } = await runImport(file, from);

    expect(result.code).toBe(1);
    expect(logs.error.join("\n")).toMatch(pattern);
    expect(imported).toStrictEqual([]);
};

describe("lunora import --from supabase", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-import-sources-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    it("preserves the id column as `_id` so foreign keys survive", async () => {
        expect.assertions(2);

        const root = writeDump({
            "posts.csv": "id,author_id,title\np1,u1,hello\np2,u1,world\n",
            "users.csv": "id,email\nu1,a@b.com\n",
        });

        const { imported, result } = await runImport(root, "supabase");

        expect(result.code).toBe(0);
        expect(imported).toStrictEqual([
            { doc: { _id: "p1", author_id: "u1", title: "hello" }, table: "posts" },
            { doc: { _id: "p2", author_id: "u1", title: "world" }, table: "posts" },
            { doc: { _id: "u1", email: "a@b.com" }, table: "users" },
        ]);
    });

    it("distinguishes an unquoted empty field (NULL) from a quoted empty string", async () => {
        expect.assertions(1);

        const root = writeDump({ "users.csv": 'id,bio,nickname\nu1,,""\n' });
        const { imported } = await runImport(root, "supabase");

        expect(imported[0]?.doc).toStrictEqual({ _id: "u1", bio: null, nickname: "" });
    });

    it("handles quoted commas, embedded newlines, and doubled quotes", async () => {
        expect.assertions(1);

        const root = writeDump({ "notes.csv": 'id,body\nn1,"a, b\nc ""quoted"""\n' });
        const { imported } = await runImport(root, "supabase");

        expect(imported[0]?.doc).toStrictEqual({ _id: "n1", body: 'a, b\nc "quoted"' });
    });

    it("applies the declared reshapes", async () => {
        expect.assertions(1);

        const root = writeDump({
            "events.csv": 'id,at,payload,blob,tags,big,ok\ne1,2024-01-02 03:04:05+00,"{""k"":1}",\\x48690a,"{a,b}",9007199254740993,t\n',
        });

        writeMapping("supabase", {
            tables: {
                events: {
                    types: { at: "timestamp-ms", big: "int8-string", blob: "bytea-base64", ok: "boolean", payload: "json", tags: "text-array" },
                },
            },
        });

        const { imported } = await runImport(root, "supabase");

        expect(imported[0]?.doc).toStrictEqual({
            _id: "e1",
            at: Date.parse("2024-01-02T03:04:05+00:00"),
            big: "9007199254740993",
            blob: Buffer.from("4869 0a".replace(" ", ""), "hex").toString("base64"),
            ok: true,
            payload: { k: 1 },
            tags: ["a", "b"],
        });
    });

    it("copies a column the mapping does not name straight through", async () => {
        expect.assertions(1);

        const root = writeDump({ "t.csv": "id,untouched\nx1,2024-01-02 03:04:05+00\n" });

        writeMapping("supabase", { tables: { t: { types: {} } } });

        const { imported } = await runImport(root, "supabase");

        expect(imported[0]?.doc["untouched"]).toBe("2024-01-02 03:04:05+00");
    });

    describe("the reshape rule — lossy conversions error, they never truncate", () => {
        it("refuses an int8 past Number.MAX_SAFE_INTEGER declared as `number`", async () => {
            expect.assertions(3);

            const root = writeDump({ "t.csv": "id,n\nx1,9007199254740993\n" });

            writeMapping("supabase", { tables: { t: { types: { n: "number" } } } });

            await expectAbort(root, "supabase", /exceeds Number\.MAX_SAFE_INTEGER/);
        });

        it("refuses a high-precision numeric that does not round-trip", async () => {
            expect.assertions(3);

            const root = writeDump({ "t.csv": "id,amount\nx1,12345678901234567890.12345\n" });

            writeMapping("supabase", { tables: { t: { types: { amount: "number" } } } });

            await expectAbort(root, "supabase", /more precision than a JS number holds/);
        });

        it("refuses a bytea that is not hex output", async () => {
            expect.assertions(3);

            const root = writeDump({ "t.csv": "id,b\nx1,notbytea\n" });

            writeMapping("supabase", { tables: { t: { types: { b: "bytea-base64" } } } });

            await expectAbort(root, "supabase", /bytea_output/);
        });

        it("names the column and the offending value", async () => {
            expect.assertions(3);

            const root = writeDump({ "t.csv": "id,when\nx1,not-a-date\n" });

            writeMapping("supabase", { tables: { t: { types: { when: "timestamp-ms" } } } });

            await expectAbort(root, "supabase", /column `when`.*not-a-date/);
        });
    });

    it("rejects an unknown reshape name in the mapping rather than ignoring it", async () => {
        expect.assertions(1);

        const root = writeDump({ "t.csv": "id\nx1\n" });

        writeMapping("supabase", { tables: { t: { types: { c: "timestamp-nanoseconds" } } } });

        await expect(runImport(root, "supabase")).rejects.toThrow(/unknown reshape/);
    });

    it("routes a mapping-named file to its declared table", async () => {
        expect.assertions(1);

        const root = writeDump({ "auth.users.csv": "id,email\nu1,a@b.com\n" });

        writeMapping("supabase", { tables: { users: { file: "auth.users.csv" } } });

        const { imported } = await runImport(root, "supabase");

        expect(imported[0]?.table).toBe("users");
    });

    it("fails when the directory holds no CSV at all", async () => {
        expect.assertions(1);

        const root = writeDump({ "readme.txt": "nothing here" });

        await expect(runImport(root, "supabase")).rejects.toThrow(/holds no .csv files/);
    });
});

describe("lunora import --from firebase", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-import-sources-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    it("decodes every Firestore typed value and takes `_id` from the resource path", async () => {
        expect.assertions(1);

        const root = writeDump({
            "events.json": JSON.stringify({
                documents: [
                    {
                        fields: {
                            active: { booleanValue: true },
                            at: { timestampValue: "2024-01-02T03:04:05Z" },
                            blob: { bytesValue: "SGk=" },
                            count: { integerValue: "42" },
                            missing: { nullValue: null },
                            nested: { mapValue: { fields: { deep: { stringValue: "yes" } } } },
                            owner: { referenceValue: "projects/p/databases/(default)/documents/users/u1" },
                            ratio: { doubleValue: 1.5 },
                            tags: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } },
                            title: { stringValue: "hello" },
                            where: { geoPointValue: { latitude: 1, longitude: 2 } },
                        },
                        name: "projects/p/databases/(default)/documents/events/e1",
                    },
                ],
            }),
        });

        const { imported } = await runImport(root, "firebase");

        expect(imported[0]?.doc).toStrictEqual({
            _id: "e1",
            active: true,
            at: Date.parse("2024-01-02T03:04:05Z"),
            blob: "SGk=",
            count: 42,
            missing: null,
            nested: { deep: "yes" },
            owner: "u1",
            ratio: 1.5,
            tags: ["a", "b"],
            title: "hello",
            where: { latitude: 1, longitude: 2 },
        });
    });

    it("keeps an integerValue past the safe range as a string rather than rounding it", async () => {
        expect.assertions(1);

        const root = writeDump({
            "t.json": JSON.stringify({
                documents: [{ fields: { big: { integerValue: "9007199254740993" } }, name: "projects/p/databases/(default)/documents/t/x1" }],
            }),
        });

        const { imported } = await runImport(root, "firebase");

        expect(imported[0]?.doc["big"]).toBe("9007199254740993");
    });

    it("accepts the community `{ docId: fields }` container, taking the id from the key", async () => {
        expect.assertions(1);

        const root = writeDump({ "users.json": JSON.stringify({ u1: { email: { stringValue: "a@b.com" } } }) });
        const { imported } = await runImport(root, "firebase");

        expect(imported[0]).toStrictEqual({ doc: { _id: "u1", email: "a@b.com" }, table: "users" });
    });

    it("accepts NDJSON, one document per line", async () => {
        expect.assertions(1);

        const root = writeDump({
            "posts.ndjson": [
                JSON.stringify({ fields: { t: { stringValue: "a" } }, name: "projects/p/databases/(default)/documents/posts/p1" }),
                JSON.stringify({ fields: { t: { stringValue: "b" } }, name: "projects/p/databases/(default)/documents/posts/p2" }),
            ].join("\n"),
        });

        const { imported } = await runImport(root, "firebase");

        expect(imported.map((row) => row.doc["_id"])).toStrictEqual(["p1", "p2"]);
    });

    it("rejects a document with no id rather than inventing one", async () => {
        expect.assertions(3);

        const root = writeDump({ "t.json": JSON.stringify([{ fields: { a: { stringValue: "x" } } }]) });

        await expectAbort(root, "firebase", /no document id/);
    });

    it("rejects an unrecognised value shape rather than dropping the field", async () => {
        expect.assertions(3);

        const root = writeDump({
            "t.json": JSON.stringify({ documents: [{ fields: { odd: { quantumValue: 1 } }, name: "projects/p/databases/(default)/documents/t/x1" }] }),
        });

        await expectAbort(root, "firebase", /unrecognised Firestore value/);
    });

    it("refuses --with-storage without --storage-dir, which would migrate nothing", async () => {
        expect.assertions(2);

        const root = writeDump({ "t.json": JSON.stringify({ x1: {} }) });
        const { logs, result } = await runImport(root, "firebase", { withStorage: true });

        expect(result.code).toBe(1);
        expect(logs.error.join("\n")).toContain("gcloud storage cp");
    });
});

describe("storage transfer with a resumable checkpoint", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-import-storage-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    const sha256Hex = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

    /** A worker that stores uploads, plus a counter so re-runs can be told apart. */
    const storageWorker = () => {
        const bucket = new Map<string, { sha256: string; size: number }>();
        const imported: { doc: Record<string, unknown>; table: string }[] = [];
        const uploads: string[] = [];
        let failAfterUploads = Number.POSITIVE_INFINITY;

        const json = (value: unknown) => {
            return { arrayBuffer: async () => new ArrayBuffer(0), body: null, json: async () => value, ok: true, status: 200, text: async () => "" };
        };

        const fetchImpl: StreamingFetchLike = async (input, init) => {
            const url = new URL(input);
            const method = init?.method ?? "GET";

            if (url.pathname === "/_lunora/admin/import") {
                const inserted: Record<string, number> = {};

                for (const line of String(init?.body ?? "")
                    .split("\n")
                    .filter((entry) => entry.trim().length > 0)) {
                    const row = JSON.parse(line) as { doc: Record<string, unknown>; table: string };

                    imported.push(row);
                    inserted[row.table] = (inserted[row.table] ?? 0) + 1;
                }

                return json({ conflicts: 0, errors: [], inserted, received: imported.length });
            }

            if (url.pathname === "/_lunora/admin/storage" && method === "GET") {
                return json({
                    objects: [...bucket.entries()].map(([key, o]) => {
                        return { key, ...o };
                    }),
                    truncated: false,
                });
            }

            if (url.pathname === "/_lunora/admin/storage" && method === "PUT") {
                if (uploads.length >= failAfterUploads) {
                    return {
                        arrayBuffer: async () => new ArrayBuffer(0),
                        body: null,
                        json: async () => {
                            return {};
                        },
                        ok: false,
                        status: 500,
                        text: async () => "boom",
                    };
                }

                const key = url.searchParams.get("key") as string;
                const bytes = new TextDecoder().decode(init?.body as Uint8Array);

                uploads.push(key);
                bucket.set(key, { sha256: sha256Hex(bytes), size: bytes.length });

                return json({ key, sha256: sha256Hex(bytes) });
            }

            throw new Error(`unexpected ${method} ${input}`);
        };

        return {
            bucket,
            fetchImpl,
            imported,
            failAfter: (count: number) => {
                failAfterUploads = count;
            },
            uploads,
        };
    };

    it("uploads a local bucket dir and rewrites the mapped path column to the R2 key", async () => {
        expect.assertions(3);

        const root = writeDump({ "users.json": JSON.stringify({ u1: { avatar: { stringValue: "avatars/a.png" } } }) });
        const storage = join(workDir, "bucket");

        mkdirSync(join(storage, "avatars"), { recursive: true });
        writeFileSync(join(storage, "avatars", "a.png"), "image-bytes", "utf8");

        writeMapping("firebase", { tables: { users: { storageColumns: ["avatar"] } } });

        const worker = storageWorker();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            from: "firebase",
            logger: capturingLogger().logger,
            storageDir: storage,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(0);
        expect(worker.uploads).toStrictEqual([sha256Hex("image-bytes")]);
        expect(worker.imported[0]?.doc["avatar"]).toBe(sha256Hex("image-bytes"));
    });

    it("checkpoints each object, and a resumed run re-uploads none of them", async () => {
        expect.assertions(4);

        const root = writeDump({ "t.json": JSON.stringify({ x1: {} }) });
        const storage = join(workDir, "bucket");

        mkdirSync(storage, { recursive: true });

        for (const name of ["a.txt", "b.txt", "c.txt"]) {
            writeFileSync(join(storage, name), `content-${name}`, "utf8");
        }

        const first = storageWorker();

        // Kill the run on the second object: the first is checkpointed, the rest are not.
        first.failAfter(1);

        const failed = await runImportCommand({
            cwd: workDir,
            fetchImpl: first.fetchImpl,
            file: root,
            from: "firebase",
            logger: capturingLogger().logger,
            storageDir: storage,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(failed.code).toBe(1);
        expect(existsSync(join(workDir, "lunora", ".import-storage-firebase.ndjson"))).toBe(true);

        // A second worker with an empty bucket: anything re-uploaded would show up.
        const second = storageWorker();

        await runImportCommand({
            cwd: workDir,
            fetchImpl: second.fetchImpl,
            file: root,
            from: "firebase",
            logger: capturingLogger().logger,
            storageDir: storage,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        const checkpoint = readFileSync(join(workDir, "lunora", ".import-storage-firebase.ndjson"), "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0);

        // All three end up recorded exactly once, and the resumed run only had
        // to move the two the failed run never reached.
        expect(checkpoint).toHaveLength(3);
        expect(second.uploads).toHaveLength(2);
    });

    it("survives a torn final checkpoint line rather than stranding the migration", async () => {
        expect.assertions(2);

        const root = writeDump({ "t.json": JSON.stringify({ x1: {} }) });
        const storage = join(workDir, "bucket");

        mkdirSync(storage, { recursive: true });
        writeFileSync(join(storage, "a.txt"), "only", "utf8");
        mkdirSync(join(workDir, "lunora"), { recursive: true });
        // Exactly what a process killed mid-append leaves behind.
        writeFileSync(join(workDir, "lunora", ".import-storage-firebase.ndjson"), '{"source":"a.txt","key":"x","si', "utf8");

        const worker = storageWorker();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            from: "firebase",
            logger: capturingLogger().logger,
            storageDir: storage,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(0);
        expect(worker.uploads).toStrictEqual([sha256Hex("only")]);
    });

    it("reports a mapped path the transfer never saw instead of guessing at it", async () => {
        expect.assertions(3);

        const root = writeDump({ "users.json": JSON.stringify({ u1: { avatar: { stringValue: "avatars/missing.png" } } }) });
        const storage = join(workDir, "bucket");

        mkdirSync(storage, { recursive: true });
        writeFileSync(join(storage, "other.png"), "x", "utf8");

        writeMapping("firebase", { tables: { users: { storageColumns: ["avatar"] } } });

        const worker = storageWorker();
        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            from: "firebase",
            logger,
            storageDir: storage,
            token: "t",
            url: "http://localhost:8787",
            verify: true,
            withStorage: true,
        });

        expect(result.code).toBe(1);
        expect(worker.imported[0]?.doc["avatar"]).toBe("avatars/missing.png");
        expect(logs.warn.join("\n")).toContain("storage path never transferred: users.avatar: avatars/missing.png");
    });
});
