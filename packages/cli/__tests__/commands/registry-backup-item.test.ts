/**
 * The shipped `registry/backup` item, EXECUTED — not read as text.
 *
 * `registry/` is copy-in source with no test harness of its own: its only gate is
 * `registry/tsconfig.json`, which type-checks the items and cannot catch a
 * serialiser that throws on a `bigint`. That is exactly what shipped here — the
 * item wrote its NDJSON with a bare `JSON.stringify`, so a `v.bigint()` column
 * (the `payment` item ships three) made every scheduled run throw and write
 * nothing, while a `v.bytes()` column flattened to `{}` and reported healthy
 * counts. `packages/cli/vitest.config.ts` aliases the three specifiers the item
 * imports so it can be invoked here with a stub `ctx`.
 *
 * The expectations are read from `shared/wire-codec`'s `encodeWire` — the codec
 * the shard admin plane wraps every export in and `lunora backup restore` decodes
 * on `/apply` — so the item's own copy of it cannot drift from the reference
 * without this file going red.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { decodeWire, encodeWire } from "../../../../shared/wire-codec";
import { env } from "../fixtures/registry-runtime/cloudflare-workers";
import { resetStoredObjects, storedObjects } from "../fixtures/registry-runtime/lunora-storage";

const testDirectory = dirname(fileURLToPath(import.meta.url));
// __tests__/commands → packages/cli → packages → repo root → registry
const registryRoot = resolve(testDirectory, "..", "..", "..", "..", "registry");

/** One row as `ctx.db` hands it back — decoded, so `bigint` and bytes are real. */
type Document = Record<string, unknown>;

interface SnapshotResult {
    bytes: number;
    key: string;
    rows: number;
    tables: Record<string, number>;
}

type SnapshotHandler = (invocation: {
    args: { tables?: string[] };
    ctx: { db: { query: (table: string) => { collect: () => Promise<Document[]> } }; log: { warn: (message: string, fields?: unknown) => void } };
}) => Promise<SnapshotResult>;

/**
 * Load the item through a computed specifier.
 *
 * A literal path would pull `registry/backup/backup.ts` into THIS package's
 * `tsc --noEmit` program, where none of its three aliased imports resolve. The
 * item's types are checked by `registry/tsconfig.json`, which is the program
 * that has the stubs for them; here only its behaviour is under test.
 */
const loadSnapshot = async (): Promise<SnapshotHandler> => {
    const itemPath = pathToFileURL(join(registryRoot, "backup", "backup.ts")).href;
    const loaded = (await import(itemPath)) as { snapshot: SnapshotHandler };

    return loaded.snapshot;
};

/** A minimal R2 binding — the aliased `@lunora/storage` stub never touches it. */
const bucketStub = {};

/** `ctx` with just the two surfaces `snapshot` uses. */
const contextOver = (rows: Record<string, Document[]>): { ctx: Parameters<SnapshotHandler>[0]["ctx"]; warnings: { fields?: unknown; message: string }[] } => {
    const warnings: { fields?: unknown; message: string }[] = [];

    return {
        ctx: {
            db: {
                query: (table: string) => {
                    return { collect: async (): Promise<Document[]> => rows[table] ?? [] };
                },
            },
            log: {
                warn: (message: string, fields?: unknown) => {
                    warnings.push({ fields, message });
                },
            },
        },
        warnings,
    };
};

/** The NDJSON body the last `store()` call was handed, as lines. */
const storedLines = (): string[] => {
    const object = storedObjects.at(-1);

    if (object === undefined) {
        throw new Error("nothing was stored");
    }

    return new TextDecoder()
        .decode(object.body)
        .split("\n")
        .filter((line) => line.length > 0);
};

describe("registry item: backup", () => {
    beforeEach(() => {
        resetStoredObjects();
        env["BACKUP_BUCKET"] = bucketStub;
    });

    it("writes a `v.bigint()` column instead of throwing on it", async () => {
        expect.assertions(3);

        const snapshot = await loadSnapshot();
        const record: Document = { _id: "p1", amountMinor: 9_007_199_254_740_993n, currency: "eur" };
        const { ctx } = contextOver({ paymentSessions: [record] });

        // Before the fix this rejected with
        // `TypeError: Do not know how to serialize a BigInt` and stored nothing.
        const result = await snapshot({ args: { tables: ["paymentSessions"] }, ctx });

        expect(result.rows).toBe(1);

        const [line] = storedLines();
        const row = JSON.parse(line as string) as { doc: Record<string, unknown>; table: string };

        expect(row).toStrictEqual({ doc: encodeWire(record), table: "paymentSessions" });
        // …and `lunora backup restore` decodes it back to the same real bigint.
        expect(decodeWire(row.doc)).toStrictEqual(record);
    });

    it("round-trips a `v.bytes()` column instead of flattening it to `{}`", async () => {
        expect.assertions(2);

        const snapshot = await loadSnapshot();
        const record: Document = { _id: "u1", avatar: new Uint8Array([0, 1, 2, 253, 254, 255]).buffer };
        const { ctx } = contextOver({ users: [record] });

        await snapshot({ args: { tables: ["users"] }, ctx });

        const row = JSON.parse(storedLines()[0] as string) as { doc: Record<string, unknown> };

        // A bare `JSON.stringify` stored `{"avatar":{}}` here — healthy counts,
        // empty column at recovery.
        expect(row.doc).toStrictEqual(encodeWire(record));
        expect(decodeWire(row.doc)).toStrictEqual(record);
    });

    it("stays byte-identical to plain JSON for a pure-JSON document", async () => {
        expect.assertions(1);

        const snapshot = await loadSnapshot();
        const record: Document = { _creationTime: 1_735_689_600_000, _id: "m1", body: "hi", tags: ["a", "b"] };
        const { ctx } = contextOver({ messages: [record] });

        await snapshot({ args: { tables: ["messages"] }, ctx });

        expect(storedLines()[0]).toBe(JSON.stringify({ doc: record, table: "messages" }));
    });

    it("says out loud that it only covers the shard it ran on", async () => {
        expect.assertions(2);

        const snapshot = await loadSnapshot();
        const { ctx, warnings } = contextOver({ messages: [] });

        await snapshot({ args: { tables: ["messages"] }, ctx });

        // The counts cannot tell a partial snapshot from a single-shard
        // deployment, so the run has to.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.message).toContain("shardBy");
    });

    it("no longer advertises a `--to` flag `lunora backup restore` does not have", () => {
        expect.assertions(3);

        // `lunora backup`'s options are dir/bucket/prefix/verify/tables/at/
        // bookmark/restore/restart/shard/prod/yes/url/token — `--at` belongs to
        // `pitr`, and there is no `--to` anywhere. The item documented recovery
        // as `restore … --to <ISO>` CDC replay in three places.
        const manifest = readFileSync(join(registryRoot, "backup", "registry.json"), "utf8");

        expect(readFileSync(join(registryRoot, "backup", "README.md"), "utf8")).not.toContain("`--to <ISO>`");
        expect(manifest).not.toContain("--to <ISO>");
        expect(readFileSync(join(registryRoot, "index.json"), "utf8")).not.toContain("`--to` CDC replay");
    });
});
