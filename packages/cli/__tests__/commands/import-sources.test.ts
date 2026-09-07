/**
 * `lunora import --from supabase|firebase` — the foreign-source readers: CSV and
 * Firestore typed-value decoding, the declared reshapes, and the rule that a
 * reshape which would lose information errors rather than truncating.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** A 200 carrying `value` as JSON, in the shape the CLI's fetch wrapper reads. */
const jsonResponse = (value: unknown) => {
    return { arrayBuffer: async () => new ArrayBuffer(0), body: null, json: async () => value, ok: true, status: 200, text: async () => "" };
};

/**
 * The `/_lunora/admin/import` half of a worker stand-in: record every posted row
 * and answer with the tally the importer's parity check reads.
 *
 * Shared by all three fakes below, which differ only in what else they serve.
 */
const importRecorder = () => {
    const imported: { doc: Record<string, unknown>; table: string }[] = [];

    return {
        handle: (body: string | Uint8Array | undefined) => {
            const inserted: Record<string, number> = {};

            for (const line of (typeof body === "string" ? body : new TextDecoder().decode(body)).split("\n").filter((entry) => entry.trim().length > 0)) {
                const row = JSON.parse(line) as { doc: Record<string, unknown>; table: string };

                imported.push(row);
                inserted[row.table] = (inserted[row.table] ?? 0) + 1;
            }

            return jsonResponse({ conflicts: 0, errors: [], inserted, received: imported.length });
        },
        imported,
    };
};

/** A worker stand-in that records every row the import posts. */
const sink = (): Sink => {
    const recorder = importRecorder();

    return {
        fetchImpl: async (input, init) =>
            new URL(input).pathname === "/_lunora/admin/import"
                ? recorder.handle(init?.body)
                : jsonResponse({ conflicts: 0, errors: [], inserted: {}, received: 0 }),
        imported: recorder.imported,
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

    it("keeps microsecond precision in `timestamp-iso`, and still rejects garbage", async () => {
        expect.assertions(2);

        const root = writeDump({ "t.csv": "id,at\nx1,2024-01-02 03:04:05.123456+00\n" });

        writeMapping("supabase", { tables: { t: { types: { at: "timestamp-iso" } } } });

        const { imported } = await runImport(root, "supabase");

        // Round-tripping through `Date` would truncate to .123; Postgres's
        // default precision is microseconds.
        expect(imported[0]?.doc["at"]).toBe("2024-01-02T03:04:05.123456+00:00");

        rmSync(join(workDir, "lunora"), { force: true, recursive: true });

        const bad = writeDump({ "t.csv": "id,at\nx1,not-a-date\n" }, "bad");

        writeMapping("supabase", { tables: { t: { types: { at: "timestamp-iso" } } } });

        const { logs } = await runImport(bad, "supabase");

        expect(logs.error.join("\n")).toContain("column `at`");
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

        const root = writeDump({ "public.users.csv": "id,email\nu1,a@b.com\n" });

        writeMapping("supabase", { tables: { users: { file: "public.users.csv" } } });

        const { imported } = await runImport(root, "supabase");

        expect(imported[0]?.table).toBe("users");
    });

    it("never imports an `auth.` dump as a table, even with no mapping file at all", async () => {
        expect.assertions(3);

        // The exclusion used to be built only from the mapping's `auth` block, so
        // a dump imported without one sent every hash and live reset token over
        // the wire as an ordinary row.
        // eslint-disable-next-line no-secrets/no-secrets -- a CSV header naming credential columns, which is the point of the fixture
        const authDump = "id,email,encrypted_password,recovery_token\nu1,a@b.com,$2a$10$SECRET,RESETTOKEN\n";
        const root = writeDump({ "auth.users.csv": authDump, "posts.csv": "id,title\np1,hello\n" });

        const { imported } = await runImport(root, "supabase");

        expect(imported.map((row) => row.table)).toStrictEqual(["posts"]);
        expect(JSON.stringify(imported)).not.toContain("$2a$10$");
        expect(JSON.stringify(imported)).not.toContain("RESETTOKEN");
    });

    it("refuses a credential column reaching the table path by any other route", async () => {
        expect.assertions(3);

        // Belt and braces: if a credential column ever arrives under a name the
        // `auth.` exclusion does not catch, refuse the row rather than filtering
        // the column — a silent filter would hide that the file is an auth dump.
        // eslint-disable-next-line no-secrets/no-secrets -- a CSV header naming a credential column, which is the point of the fixture
        const memberDump = "id,email,encrypted_password\nu1,a@b.com,$2a$10$SECRET\n";
        const root = writeDump({ "members.csv": memberDump });

        await expectAbort(root, "supabase", /credential material/);
    });

    it("fails loudly when no column matches the declared id, rather than dropping `_id`", async () => {
        expect.assertions(3);

        // Without this the row imports with no `_id`, the target mints a fresh
        // one, and every foreign key pointing at the old PK dangles — with
        // `--verify` green, because the row counts still match.
        const root = writeDump({ "profiles.csv": "user_id,bio\nu1,hello\n" });

        await expectAbort(root, "supabase", /no `id` column to preserve/);
    });

    it("preserves a non-default id column when the mapping names it", async () => {
        expect.assertions(1);

        const root = writeDump({ "profiles.csv": "user_id,bio\nu1,hello\n" });

        writeMapping("supabase", { tables: { profiles: { idColumn: "user_id" } } });

        const { imported } = await runImport(root, "supabase");

        expect(imported[0]?.doc).toStrictEqual({ _id: "u1", bio: "hello" });
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

    it("decodes the Admin SDK's `_fieldsProto` encoding, not just REST", async () => {
        expect.assertions(2);

        // `document._fieldsProto` — what the documented dump script reads — holds
        // a protobuf Timestamp (`{ seconds, nanos }`) and a Buffer, where REST
        // holds an RFC-3339 string and base64. Accepting only REST made that
        // script fail on every collection with a `createdAt`.
        const root = writeDump({
            "events.json": JSON.stringify({
                documents: [
                    {
                        fields: {
                            at: { timestampValue: { nanos: 500_000_000, seconds: "1704164645" } },
                            blob: { bytesValue: { data: [72, 105], type: "Buffer" } },
                        },
                        name: "projects/p/databases/(default)/documents/events/e1",
                    },
                ],
            }),
        });

        writeMapping("firebase", {});

        const { imported } = await runImport(root, "firebase");
        const decoded = imported.find((row) => row.table === "events")?.doc as { at: number; blob: string };

        expect(decoded.at).toBe(1_704_164_645_500);
        expect(decoded.blob).toBe("SGk=");
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
        const recorder = importRecorder();
        const uploads: string[] = [];
        let failAfterUploads = Number.POSITIVE_INFINITY;
        const fetchImpl: StreamingFetchLike = async (input, init) => {
            const url = new URL(input);
            const method = init?.method ?? "GET";

            if (url.pathname === "/_lunora/admin/import") {
                return recorder.handle(init?.body);
            }

            if (url.pathname === "/_lunora/admin/storage" && method === "GET") {
                return jsonResponse({
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

                return jsonResponse({ key, sha256: sha256Hex(bytes) });
            }

            throw new Error(`unexpected ${method} ${input}`);
        };

        return {
            bucket,
            fetchImpl,
            imported: recorder.imported,
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
        expect.assertions(5);

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

        // A realistic resume targets the SAME bucket, so the checkpoint and the
        // listing agree and only the un-transferred objects move.
        const second = storageWorker();

        for (const [key, value] of first.bucket) {
            second.bucket.set(key, value);
        }

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
        // The resume key is the `path` field. Renaming it without renaming the
        // reader turns every checkpoint into a full re-transfer, silently.
        expect(JSON.parse(checkpoint[0] as string)).toHaveProperty("path");
    });

    it("re-transfers when the checkpoint claims objects the target does not hold", async () => {
        expect.assertions(2);

        const root = writeDump({ "t.json": JSON.stringify({ x1: {} }) });
        const storage = join(workDir, "bucket");

        mkdirSync(storage, { recursive: true });
        writeFileSync(join(storage, "a.txt"), "content", "utf8");

        const first = storageWorker();

        await runImportCommand({
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

        // A different deployment, a wiped bucket, or a changed keyPrefix: the
        // checkpoint says "moved", the target says otherwise. Trusting the
        // checkpoint alone rewrote documents to keys that do not exist.
        const fresh = storageWorker();

        await runImportCommand({
            cwd: workDir,
            fetchImpl: fresh.fetchImpl,
            file: root,
            from: "firebase",
            logger: capturingLogger().logger,
            storageDir: storage,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(fresh.uploads).toStrictEqual([sha256Hex("content")]);
        expect(fresh.bucket.has(sha256Hex("content"))).toBe(true);
    });

    it("survives a torn final checkpoint line rather than stranding the migration", async () => {
        expect.assertions(2);

        const root = writeDump({ "t.json": JSON.stringify({ x1: {} }) });
        const storage = join(workDir, "bucket");

        mkdirSync(storage, { recursive: true });
        writeFileSync(join(storage, "a.txt"), "only", "utf8");
        mkdirSync(join(workDir, "lunora"), { recursive: true });
        // Exactly what a process killed mid-append leaves behind.
        writeFileSync(join(workDir, "lunora", ".import-storage-firebase.ndjson"), '{"path":"a.txt","key":"x","si', "utf8");

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

    it("refuses a storage-dir entry that resolves outside it", async () => {
        expect.assertions(1);

        const root = writeDump({ "t.json": JSON.stringify({ x1: {} }) });
        const storage = join(workDir, "bucket");
        const outside = join(workDir, "outside.txt");

        mkdirSync(storage, { recursive: true });
        writeFileSync(outside, "not yours", "utf8");
        symlinkSync(outside, join(storage, "escape.txt"));

        const worker = storageWorker();

        await runImportCommand({
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

        // Whether it is skipped or refused, the bytes outside the directory must
        // never reach the bucket.
        expect(worker.uploads).toStrictEqual([]);
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

describe("auth import", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-import-auth-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    it("maps Supabase users and identities to better-auth rows, without any password material", async () => {
        expect.assertions(4);

        const root = writeDump({
            "auth.identities.csv": "user_id,provider,provider_id\nu1,github,gh-99\n",
            "auth.users.csv":
                "id,email,email_confirmed_at,encrypted_password,raw_user_meta_data,created_at\n" +
                'u1,a@b.com,2024-01-02 03:04:05+00,"$2a$10$notportable","{""name"":""Ada"",""avatar_url"":""https://x/a.png""}",2024-01-01 00:00:00+00\n',
            "posts.csv": "id,title\np1,hello\n",
        });

        writeMapping("supabase", { auth: { file: "auth.users.csv", identitiesFile: "auth.identities.csv" } });

        const { imported, result } = await runImport(root, "supabase");
        const user = imported.find((row) => row.table === "user");
        const account = imported.find((row) => row.table === "account");

        expect(result.code).toBe(0);
        expect(user?.doc).toStrictEqual({
            _id: "u1",
            createdAt: Date.parse("2024-01-01T00:00:00+00:00"),
            email: "a@b.com",
            emailVerified: true,
            id: "u1",
            image: "https://x/a.png",
            name: "Ada",
        });
        // Keyed on the provider account id too: one user can hold two identities
        // at the same provider, and `user:provider` alone collides.
        expect(account?.doc).toStrictEqual({ _id: "u1:github:gh-99", accountId: "gh-99", id: "u1:github:gh-99", providerId: "github", userId: "u1" });
        // The bcrypt hash is in the dump and must not reach the target.
        expect(JSON.stringify(imported)).not.toContain("$2a$10$");
    });

    it("keeps two identities at the same provider distinct", async () => {
        expect.assertions(2);

        // Keying an account on `user:provider` alone collapses these two into
        // one id — the second silently replacing the first, or the import
        // failing on a duplicate.
        const root = writeDump({
            "auth.identities.csv": "user_id,provider,provider_id\nu1,github,gh-99\nu1,github,gh-100\n",
            "auth.users.csv": "id,email,created_at\nu1,a@b.com,2024-01-01 00:00:00+00\n",
            "posts.csv": "id,title\np1,hello\n",
        });

        writeMapping("supabase", { auth: { file: "auth.users.csv", identitiesFile: "auth.identities.csv" } });

        const { imported } = await runImport(root, "supabase");
        const accountIds = imported.filter((row) => row.table === "account").map((row) => (row.doc as { _id: string })._id);

        expect(accountIds).toStrictEqual(["u1:github:gh-99", "u1:github:gh-100"]);
        expect(new Set(accountIds).size).toBe(2);
    });

    it("maps a Firebase auth:export dump, dropping the password provider", async () => {
        expect.assertions(3);

        const root = writeDump({
            "auth.json": JSON.stringify({
                users: [
                    {
                        displayName: "Grace",
                        email: "g@h.com",
                        emailVerified: true,
                        localId: "f1",
                        passwordHash: "c2NyeXB0",
                        providerUserInfo: [
                            { providerId: "password", rawId: "g@h.com" },
                            { providerId: "google.com", rawId: "google-1" },
                        ],
                        salt: "abc",
                    },
                ],
            }),
            "t.json": JSON.stringify({ x1: {} }),
        });

        writeMapping("firebase", { auth: { file: "auth.json" } });

        const { imported } = await runImport(root, "firebase");
        const accounts = imported.filter((row) => row.table === "account");

        expect(imported.find((row) => row.table === "user")?.doc).toStrictEqual({
            _id: "f1",
            email: "g@h.com",
            emailVerified: true,
            id: "f1",
            name: "Grace",
        });
        // `password` is better-auth's own credential provider, not a linked
        // account — and its hash is unusable anyway.
        expect(accounts.map((row) => row.doc["providerId"])).toStrictEqual(["google.com"]);
        expect(JSON.stringify(imported)).not.toContain("c2NyeXB0");
    });

    it("refuses a dump where two users claim the same email", async () => {
        expect.assertions(3);

        const root = writeDump({
            "auth.users.csv": "id,email\nu1,dup@x.com\nu2,dup@x.com\n",
            "t.csv": "id\nx1\n",
        });

        writeMapping("supabase", { auth: { file: "auth.users.csv" } });

        await expectAbort(root, "supabase", /duplicate email/);
    });
});

describe("--scan for the foreign sources", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-import-scan-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    it("infers reshapes from a Supabase dump and writes them for review", async () => {
        expect.assertions(3);

        const root = writeDump({
            "events.csv": "id,at,flag,big,plain\ne1,2024-01-02 03:04:05+00,t,9007199254740993,hello\ne2,2024-02-03 04:05:06+00,f,9007199254740994,world\n",
        });

        const worker = sink();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            from: "supabase",
            logger: capturingLogger().logger,
            scan: true,
            token: "t",
            url: "http://localhost:8787",
        });

        const written = JSON.parse(readFileSync(join(workDir, "lunora", "import-supabase.json"), "utf8"));

        expect(result.code).toBe(0);
        expect(worker.imported).toStrictEqual([]);
        expect(written.tables.events.types).toStrictEqual({ at: "timestamp-ms", big: "int8-string", flag: "boolean" });
    });

    it("never overwrites a mapping the operator has already confirmed", async () => {
        expect.assertions(1);

        const root = writeDump({ "t.csv": "id,at\nx1,2024-01-02 03:04:05+00\n" });

        writeMapping("supabase", { tables: { t: { types: { at: "timestamp-iso" } } } });

        await runImportCommand({
            cwd: workDir,
            fetchImpl: sink().fetchImpl,
            file: root,
            from: "supabase",
            logger: capturingLogger().logger,
            scan: true,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(JSON.parse(readFileSync(join(workDir, "lunora", "import-supabase.json"), "utf8")).tables.t.types.at).toBe("timestamp-iso");
    });
});

describe("the live Supabase storage path", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-supabase-storage-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
        delete process.env["SUPABASE_URL"];
        delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
    });

    /** A Supabase project with two buckets, one of them holding a nested folder. */
    const supabaseProject = () => {
        const requests: { auth?: string; method: string; url: string }[] = [];
        const uploads: string[] = [];
        const fetchImpl: StreamingFetchLike = async (input, init) => {
            const url = new URL(input);
            const method = init?.method ?? "GET";

            requests.push({ auth: init?.headers?.["authorization"], method, url: input });

            if (url.pathname === "/storage/v1/bucket") {
                return jsonResponse([{ name: "avatars" }]);
            }

            if (url.pathname.startsWith("/storage/v1/object/list/")) {
                const { prefix } = JSON.parse(String(init?.body ?? "{}")) as { prefix: string };

                // One level at a time: a folder placeholder has a null `id`.
                if (prefix === "") {
                    return jsonResponse([
                        { id: "1", metadata: { mimetype: "image/png", size: 3 }, name: "top.png" },
                        { id: null, name: "nested" },
                    ]);
                }

                return jsonResponse(prefix === "nested" ? [{ id: "2", metadata: { mimetype: "image/jpeg", size: 3 }, name: "deep.jpg" }] : []);
            }

            if (url.hostname === "project.supabase.co" && url.pathname.startsWith("/storage/v1/object/")) {
                return {
                    arrayBuffer: async () => new TextEncoder().encode("img").buffer,
                    body: null,
                    json: async () => {
                        return {};
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            }

            if (url.pathname === "/_lunora/admin/storage" && method === "PUT") {
                uploads.push(url.searchParams.get("key") as string);

                return jsonResponse({ key: url.searchParams.get("key"), sha256: url.searchParams.get("expectedSha256") });
            }

            if (url.pathname === "/_lunora/admin/storage") {
                return jsonResponse({ objects: [], truncated: false });
            }

            if (url.pathname === "/_lunora/admin/import") {
                return jsonResponse({ conflicts: 0, errors: [], inserted: {}, received: 0 });
            }

            throw new Error(`unexpected ${method} ${input}`);
        };

        return { fetchImpl, requests, uploads };
    };

    it("walks every bucket and recurses into folders", async () => {
        expect.assertions(3);

        const root = writeDump({ "t.csv": "id\nx1\n" });

        process.env["SUPABASE_URL"] = "https://project.supabase.co";
        process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service-key";

        const project = supabaseProject();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: project.fetchImpl,
            file: root,
            from: "supabase",
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(0);
        // Both objects move — the nested one only if the folder placeholder was
        // followed, since the list endpoint returns one level at a time.
        expect(project.uploads).toHaveLength(2);
        // The key never carries the credential; it travels as a header only.
        expect(project.requests.every((request) => !request.url.includes("service-key"))).toBe(true);
    });

    it("refuses a cleartext SUPABASE_URL rather than sending the key over http", async () => {
        expect.assertions(2);

        const root = writeDump({ "t.csv": "id\nx1\n" });

        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the cleartext URL IS the thing under test
        process.env["SUPABASE_URL"] = "http://project.supabase.co";
        process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service-key";

        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: supabaseProject().fetchImpl,
            file: root,
            from: "supabase",
            logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(1);
        expect(logs.error.join("\n")).toContain("must be https");
    });

    it("keeps the bucket-list diagnostic instead of replacing it with a resume hint", async () => {
        expect.assertions(3);

        const root = writeDump({ "t.csv": "id\nx1\n" });

        process.env["SUPABASE_URL"] = "https://project.supabase.co";
        // The classic operator mistake: the anon key instead of the service-role
        // key. The bucket list answers 401 and the transfer throws a message naming
        // exactly that — which a bare `catch {}` discarded, printing only "it will
        // resume where it stopped" over a run that transferred nothing and has no
        // checkpoint to resume from.
        process.env["SUPABASE_SERVICE_ROLE_KEY"] = "anon-key";

        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: async (input) =>
                new URL(input).pathname === "/storage/v1/bucket"
                    ? {
                          arrayBuffer: async () => new ArrayBuffer(0),
                          body: null,
                          json: async () => {
                              return {};
                          },
                          ok: false,
                          status: 401,
                          text: async () => "Invalid JWT",
                      }
                    : jsonResponse({ conflicts: 0, errors: [], inserted: {}, received: 0 }),
            file: root,
            from: "supabase",
            logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        const errors = logs.error.join("\n");

        expect(result.code).toBe(1);
        expect(errors).toContain("service-role key, not the anon key");
        // And the resume advice no longer promises a checkpoint that may not exist.
        expect(errors).not.toContain("resume where it stopped");
    });
});
