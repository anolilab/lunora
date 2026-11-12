import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listConvexSnapshotTables, resolveConvexSnapshot } from "../../src/commands/convex-snapshot";
import { readConvexExport } from "../../src/commands/data-transfer/import-source";
import type { Logger } from "../../src/util/logger";

interface EmittedRow {
    doc: unknown;
    table: string;
}

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

/** Stream every row of a snapshot into `rows`, so a refusal leaves what was emitted before it. */
const collect = async (path: string, rows: EmittedRow[]): Promise<void> => {
    const snapshot = await resolveConvexSnapshot(path);

    if (snapshot === undefined) {
        throw new Error(`${path} is not a Convex snapshot`);
    }

    const tables = await listConvexSnapshotTables(snapshot);

    if (tables === undefined) {
        throw new Error(`${path} holds no tables`);
    }

    for await (const line of readConvexExport(snapshot, tables, silentLogger(), false, new Map())) {
        rows.push(JSON.parse(line) as EmittedRow);
    }
};

/** A sidecar holding one JSON string, as the pre-2026 `generated_schema.jsonl` does. */
const sidecarLine = (shape: string): string => `${JSON.stringify(shape)}\n`;

const LEGACY_SHAPE = "{_creationTime: normalfloat64, _id: id<users>, n: int64}";

describe("convex export value handling", () => {
    let workDir: string;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-cli-convex-values-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    /** Write `<root>/<table>/documents.jsonl` (and an optional sidecar) from raw JSON text. */
    const writeExport = (table: string, documentLines: string[], sidecar?: string): string => {
        const root = join(workDir, "export");
        const tableDir = join(root, table);

        mkdirSync(tableDir, { recursive: true });
        writeFileSync(join(tableDir, "documents.jsonl"), `${documentLines.join("\n")}\n`);

        if (sidecar !== undefined) {
            writeFileSync(join(tableDir, "generated_schema.jsonl"), sidecar);
        }

        return root;
    };

    it("refuses an Int64 a JavaScript number would round, naming the field", async () => {
        expect.assertions(2);

        const root = writeExport("users", ['{"_id":"u1","_creationTime":1700000000000.5,"big":9007199254740993}']);

        const rows: EmittedRow[] = [];
        const rejection = collect(root, rows);

        await expect(rejection).rejects.toThrow(/users\/documents\.jsonl line 1: field `big`/);
        await expect(rejection).rejects.toThrow("9007199254740993");
    });

    it("refuses a $bytes encoding nested in an array, naming its path", async () => {
        expect.assertions(2);

        const root = writeExport("users", ['{"_id":"u1","list":[{"blob":{"$bytes":"AAE="}}]}']);

        const rows: EmittedRow[] = [];
        const rejection = collect(root, rows);

        await expect(rejection).rejects.toThrow(/field `list\[0\]\.blob`/);
        await expect(rejection).rejects.toThrow("$bytes");
    });

    it("refuses a $float encoding, naming the field", async () => {
        expect.assertions(1);

        const root = writeExport("users", ['{"_id":"u1","score":{"$float":"AAAAAAAA+H8="}}']);

        await expect(collect(root, [])).rejects.toThrow(/field `score`/);
    });

    it("imports ordinary values exactly as written", async () => {
        expect.assertions(2);

        const root = writeExport("users", [
            '{"_id":"u1","_creationTime":1700000000000.0,"n":1.5,"count":42,"edge":-9007199254740991,"huge":1e20,"s":"9007199254740993","nested":{"a":[1,2.5]}}',
        ]);

        const rows: EmittedRow[] = [];

        await collect(root, rows);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.doc).toStrictEqual({
            _creationTime: 1_700_000_000_000,
            _id: "u1",
            count: 42,
            edge: -9_007_199_254_740_991,
            huge: 1e20,
            n: 1.5,
            nested: { a: [1, 2.5] },
            s: "9007199254740993",
        });
    });

    it("imports a storage reference unchanged so the storage pass can rewrite it", async () => {
        expect.assertions(2);

        const root = writeExport("posts", ['{"_id":"p1","cover":{"$storage":"kg_cover"}}']);

        const rows: EmittedRow[] = [];

        await collect(root, rows);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.doc).toStrictEqual({ _id: "p1", cover: { $storage: "kg_cover" } });
    });

    it("refuses a pre-2026 table whose shape declares int64, before emitting any row", async () => {
        expect.assertions(2);

        const root = writeExport("users", ['{"_id":"u1","n":"5"}'], sidecarLine(LEGACY_SHAPE));

        const rows: EmittedRow[] = [];

        await expect(collect(root, rows)).rejects.toThrow(/users\/generated_schema\.jsonl/);
        expect(rows).toHaveLength(0);
    });

    it("imports a pre-2026 table whose shape declares only ordinary types", async () => {
        expect.assertions(2);

        const root = writeExport("users", ['{"_id":"u1","name":"a"}'], sidecarLine("{_creationTime: normalfloat64, _id: id<users>, name: string}"));

        const rows: EmittedRow[] = [];

        await collect(root, rows);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.doc).toStrictEqual({ _id: "u1", name: "a" });
    });

    it("imports a current export whose sidecar is the uniform marker", async () => {
        expect.assertions(2);

        const root = writeExport("users", ['{"_id":"u1","count":3}'], sidecarLine("uniform"));

        const rows: EmittedRow[] = [];

        await collect(root, rows);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.doc).toStrictEqual({ _id: "u1", count: 3 });
    });

    it("refuses a pre-2026 table inside a .zip snapshot", async () => {
        expect.assertions(1);

        const zipPath = join(workDir, "snapshot.zip");
        const zip = new AdmZip();

        zip.addFile("snapshot_1/users/documents.jsonl", Buffer.from('{"_id":"u1","n":"5"}\n'));
        zip.addFile("snapshot_1/users/generated_schema.jsonl", Buffer.from(sidecarLine(LEGACY_SHAPE)));
        zip.writeZip(zipPath);

        await expect(collect(zipPath, [])).rejects.toThrow(/generated_schema\.jsonl/);
    });
});
