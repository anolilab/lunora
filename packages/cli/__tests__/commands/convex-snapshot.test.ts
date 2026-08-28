import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConvexSnapshot } from "../../src/commands/convex-snapshot";
import {
    CONVEX_STORAGE_TABLE,
    isConvexSystemTable,
    listConvexSnapshotTables,
    readSnapshotLines,
    readSnapshotStorageBlob,
    resolveConvexSnapshot,
} from "../../src/commands/convex-snapshot";

/** Drain a table's lines into an array. */
const lines = async (snapshot: ConvexSnapshot, file: string, table: string): Promise<string[]> => {
    const out: string[] = [];

    for await (const line of readSnapshotLines(snapshot, { file, table })) {
        out.push(line);
    }

    return out;
};

/** Narrow a resolve result, failing loudly rather than propagating `undefined`. */
const resolved = async (path: string): Promise<ConvexSnapshot> => {
    const snapshot = await resolveConvexSnapshot(path);

    if (snapshot === undefined) {
        throw new Error(`expected ${path} to resolve to a snapshot`);
    }

    return snapshot;
};

describe("convex snapshot reader", () => {
    let workDir: string;

    beforeEach(async () => {
        workDir = await mkdtemp(join(tmpdir(), "lunora-convex-snapshot-"));
    });

    afterEach(async () => {
        await rm(workDir, { force: true, recursive: true });
    });

    /** An exploded `npx convex export --path <dir>` directory. */
    const buildDirectory = async (tables: Record<string, string>, blobs: Record<string, string> = {}): Promise<string> => {
        const root = join(workDir, "export");

        for (const [table, body] of Object.entries(tables)) {
            // eslint-disable-next-line no-await-in-loop -- tiny fixture, sequential is clearer
            await mkdir(join(root, table), { recursive: true });
            // eslint-disable-next-line no-await-in-loop -- ditto
            await writeFile(join(root, table, "documents.jsonl"), body, "utf8");
        }

        await mkdir(join(root, "_storage"), { recursive: true });

        for (const [id, body] of Object.entries(blobs)) {
            // eslint-disable-next-line no-await-in-loop -- ditto
            await writeFile(join(root, "_storage", id), body, "utf8");
        }

        return root;
    };

    /** A `snapshot.zip`, whose real layout roots everything under `snapshot_<ts>/`. */
    const buildZip = async (entries: Record<string, string>, name = "snapshot.zip"): Promise<string> => {
        const zip = new AdmZip();

        for (const [entry, body] of Object.entries(entries)) {
            zip.addFile(entry, Buffer.from(body, "utf8"));
        }

        const path = join(workDir, name);

        await writeFile(path, zip.toBuffer());

        return path;
    };

    describe("isConvexSystemTable / CONVEX_STORAGE_TABLE", () => {
        it("treats every `_`-prefixed table as a system table", () => {
            expect.assertions(3);

            expect(isConvexSystemTable("_storage")).toBe(true);
            expect(isConvexSystemTable("_scheduled_functions")).toBe(true);
            expect(isConvexSystemTable("_")).toBe(true);
        });

        it("does not match a name that merely contains or trails an underscore", () => {
            expect.assertions(4);

            expect(isConvexSystemTable("users")).toBe(false);
            expect(isConvexSystemTable("my_storage")).toBe(false);
            expect(isConvexSystemTable("storage_")).toBe(false);
            expect(isConvexSystemTable("")).toBe(false);
        });

        it("classifies the storage table it names", () => {
            expect.assertions(2);

            expect(CONVEX_STORAGE_TABLE).toBe("_storage");
            expect(isConvexSystemTable(CONVEX_STORAGE_TABLE)).toBe(true);
        });
    });

    describe("resolveConvexSnapshot", () => {
        it("resolves an exploded directory", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: "{}\n" });

            await expect(resolveConvexSnapshot(root)).resolves.toStrictEqual({ kind: "directory", root });
        });

        it("resolves a .zip and locates its `snapshot_<ts>/_storage` prefix", async () => {
            expect.assertions(2);

            const snapshot = await resolved(await buildZip({ "snapshot_1700/_storage/blob1": "bytes", "snapshot_1700/users/documents.jsonl": "{}\n" }));

            expect(snapshot.kind).toBe("zip");
            expect(snapshot.kind === "zip" ? snapshot.storagePrefix : undefined).toBe("snapshot_1700/_storage");
        });

        it("falls back to a bare `_storage` prefix when the archive has no storage entries", async () => {
            expect.assertions(1);

            const snapshot = await resolved(await buildZip({ "snapshot_1700/users/documents.jsonl": "{}\n" }));

            expect(snapshot.kind === "zip" ? snapshot.storagePrefix : undefined).toBe("_storage");
        });

        it("matches the `.zip` suffix case-insensitively", async () => {
            expect.assertions(1);

            const snapshot = await resolved(await buildZip({ "users/documents.jsonl": "{}\n" }, "SNAPSHOT.ZIP"));

            expect(snapshot.kind).toBe("zip");
        });

        it("returns undefined for a missing path", async () => {
            expect.assertions(1);

            await expect(resolveConvexSnapshot(join(workDir, "nope"))).resolves.toBeUndefined();
        });

        it("returns undefined for a file that is not a .zip", async () => {
            expect.assertions(1);

            const path = join(workDir, "export.ndjson");

            await writeFile(path, "{}\n", "utf8");

            await expect(resolveConvexSnapshot(path)).resolves.toBeUndefined();
        });
    });

    describe("listConvexSnapshotTables", () => {
        it("lists a directory's tables sorted by name", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ messages: "{}\n", users: "{}\n", zones: "{}\n" });
            const found = await listConvexSnapshotTables({ kind: "directory", root });

            expect(found?.map((entry) => entry.table)).toStrictEqual(["messages", "users", "zones"]);
        });

        it("skips a directory without a documents.jsonl, and loose files", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: "{}\n" });

            await mkdir(join(root, "empty-table"), { recursive: true });
            await writeFile(join(root, "README.md"), "hi", "utf8");

            const found = await listConvexSnapshotTables({ kind: "directory", root });

            expect(found?.map((entry) => entry.table)).toStrictEqual(["users"]);
        });

        it("returns undefined when a directory holds no tables at all", async () => {
            expect.assertions(1);

            const root = await buildDirectory({});

            await expect(listConvexSnapshotTables({ kind: "directory", root })).resolves.toBeUndefined();
        });

        it("lists an archive's tables sorted, naming them by their parent entry segment", async () => {
            expect.assertions(2);

            const snapshot = await resolved(
                await buildZip({
                    "snapshot_1700/_storage/blob1": "bytes",
                    "snapshot_1700/users/documents.jsonl": "{}\n",
                    "snapshot_1700/messages/documents.jsonl": "{}\n",
                }),
            );
            const found = await listConvexSnapshotTables(snapshot);

            expect(found?.map((entry) => entry.table)).toStrictEqual(["messages", "users"]);
            expect(found?.map((entry) => entry.file)).toStrictEqual(["snapshot_1700/messages/documents.jsonl", "snapshot_1700/users/documents.jsonl"]);
        });

        it("returns undefined for an archive with no documents.jsonl entries", async () => {
            expect.assertions(1);

            const snapshot = await resolved(await buildZip({ "snapshot_1700/README.md": "hi" }));

            await expect(listConvexSnapshotTables(snapshot)).resolves.toBeUndefined();
        });
    });

    describe("readSnapshotLines", () => {
        it("yields a directory table's lines without an extra empty line for the trailing newline", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: '{"_id":"a"}\n{"_id":"b"}\n' });

            await expect(lines({ kind: "directory", root }, join(root, "users", "documents.jsonl"), "users")).resolves.toStrictEqual([
                '{"_id":"a"}',
                '{"_id":"b"}',
            ]);
        });

        it("yields blank and malformed lines verbatim — parsing is the caller's job", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: '{"_id":"a"}\n\nnot json\n' });

            await expect(lines({ kind: "directory", root }, join(root, "users", "documents.jsonl"), "users")).resolves.toStrictEqual([
                '{"_id":"a"}',
                "",
                "not json",
            ]);
        });

        it("yields nothing for an empty table file", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: "" });

            await expect(lines({ kind: "directory", root }, join(root, "users", "documents.jsonl"), "users")).resolves.toStrictEqual([]);
        });

        it("streams the same lines out of an archive entry", async () => {
            expect.assertions(1);

            const snapshot = await resolved(await buildZip({ "snapshot_1700/users/documents.jsonl": '{"_id":"a"}\n{"_id":"b"}\n' }));

            await expect(lines(snapshot, "snapshot_1700/users/documents.jsonl", "users")).resolves.toStrictEqual(['{"_id":"a"}', '{"_id":"b"}']);
        });

        it("yields nothing for an empty archive entry", async () => {
            expect.assertions(1);

            const snapshot = await resolved(await buildZip({ "snapshot_1700/users/documents.jsonl": "" }));

            await expect(lines(snapshot, "snapshot_1700/users/documents.jsonl", "users")).resolves.toStrictEqual([]);
        });

        it("throws when the archive has no such entry", async () => {
            expect.assertions(1);

            const snapshot = await resolved(await buildZip({ "snapshot_1700/users/documents.jsonl": "{}\n" }));

            await expect(lines(snapshot, "snapshot_1700/ghosts/documents.jsonl", "ghosts")).rejects.toThrow(
                /missing snapshot_1700\/ghosts\/documents.jsonl in archive/,
            );
        });
    });

    describe("readSnapshotStorageBlob", () => {
        it("reads a blob out of a directory's _storage", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: "{}\n" }, { kg2abc: "png-bytes" });
            const blob = await readSnapshotStorageBlob({ kind: "directory", root }, "kg2abc");

            expect(blob.toString("utf8")).toBe("png-bytes");
        });

        it("refuses a blob id that escapes _storage with `..`", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: "{}\n" });

            await writeFile(join(root, "secret.txt"), "top secret", "utf8");

            await expect(readSnapshotStorageBlob({ kind: "directory", root }, "../secret.txt")).rejects.toThrow(/resolves outside the snapshot's _storage/);
        });

        it("refuses a blob that is a symlink pointing out of _storage", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: "{}\n" });
            const outside = join(workDir, "outside.txt");

            await writeFile(outside, "top secret", "utf8");
            await symlink(outside, join(root, "_storage", "kg2evil"));

            await expect(readSnapshotStorageBlob({ kind: "directory", root }, "kg2evil")).rejects.toThrow(/resolves outside the snapshot's _storage/);
        });

        it("refuses a blob id that does not exist on disk", async () => {
            expect.assertions(1);

            const root = await buildDirectory({ users: "{}\n" });

            await expect(readSnapshotStorageBlob({ kind: "directory", root }, "kg2missing")).rejects.toThrow(/resolves outside the snapshot's _storage/);
        });

        it("reads a blob out of the archive's storage prefix", async () => {
            expect.assertions(1);

            const snapshot = await resolved(await buildZip({ "snapshot_1700/_storage/kg2abc": "png-bytes", "snapshot_1700/users/documents.jsonl": "{}\n" }));
            const blob = await readSnapshotStorageBlob(snapshot, "kg2abc");

            expect(blob.toString("utf8")).toBe("png-bytes");
        });

        it("throws when the archive has no such blob", async () => {
            expect.assertions(1);

            const snapshot = await resolved(await buildZip({ "snapshot_1700/_storage/kg2abc": "png-bytes" }));

            await expect(readSnapshotStorageBlob(snapshot, "kg2missing")).rejects.toThrow(/missing blob kg2missing in archive/);
        });
    });
});
