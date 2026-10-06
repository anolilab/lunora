import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    advanceImportManifest,
    assertImportSessionId,
    dropImportManifest,
    dropImportSession,
    IMPORT_MANIFEST_TTL_MS,
    IMPORT_STAGE_TTL_MS,
    markShardImportCommitted,
    readImportManifest,
    readShardImportSession,
    stagedImportIds,
    stagedImportPage,
    stageImportRows,
    sweepImportStaging,
    touchImportManifest,
} from "../src/import-staging";
import createSqliteExec from "./_helpers/node-sqlite";

let harness: ReturnType<typeof createSqliteExec>;

const NOW = 1_700_000_000_000;
const GEN = "gen-1";

/** A manifest with one finished batch, ready for a commit's prepare. */
const openSession = (session: string, tables: string[] = ["notes"]) => {
    touchImportManifest(harness.sql, session, { begin: true, shards: ["c1"], tables }, NOW);

    return touchImportManifest(harness.sql, session, { begin: false, tables }, NOW).manifest;
};

const exec = (query: string, ...parameters: unknown[]): void => {
    harness.sql.exec(query, ...parameters);
};

describe("import staging", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("keeps schema rows and section records apart, in arrival order, with their bytes intact", () => {
        expect.assertions(3);

        stageImportRows(
            harness.sql,
            "s1",
            GEN,
            [
                { doc: { _id: "a", blob: new Uint8Array([1, 2]).buffer }, line: 1, table: "notes" },
                { doc: { key: "k", namespace: "CACHE", value: "dg==" }, line: 2, table: "$kv" },
                { doc: { _id: "b" }, line: 3, table: "notes" },
            ],
            NOW,
        );

        const rows = stagedImportPage(harness.sql, "s1", { afterSeq: 0, limit: 10 });

        expect(rows.rows.map((row) => [row.table, row.line])).toStrictEqual([
            ["notes", 1],
            ["notes", 3],
        ]);
        expect(new Uint8Array(rows.rows[0]!.doc["blob"] as ArrayBuffer)).toStrictEqual(new Uint8Array([1, 2]));
        expect(stagedImportPage(harness.sql, "s1", { afterSeq: 0, limit: 10, sections: ["$kv"] }).rows).toMatchObject([{ table: "$kv" }]);
    });

    it("drops the schema rows at commit and answers the recorded result after it", () => {
        expect.assertions(4);

        stageImportRows(harness.sql, "s1", GEN, [{ doc: { _id: "a" }, line: 1, table: "notes" }], NOW);

        expect([...stagedImportIds(harness.sql, "s1")]).toStrictEqual(["a"]);

        markShardImportCommitted(harness.sql, "s1", GEN, { inserted: { notes: 1 } }, NOW);

        expect(stagedImportPage(harness.sql, "s1", { afterSeq: 0, limit: 10 }).rows).toStrictEqual([]);
        expect(readShardImportSession(harness.sql, "s1")).toStrictEqual({ generation: GEN, result: { inserted: { notes: 1 } }, state: "committed" });
        expect(() => stageImportRows(harness.sql, "s1", GEN, [], NOW)).toThrow(/already committed/u);
    });

    it("refuses rows of another generation, and an abort of another generation leaves them", () => {
        expect.assertions(3);

        stageImportRows(harness.sql, "s1", GEN, [{ doc: { _id: "a" }, line: 1, table: "notes" }], NOW);

        expect(() => stageImportRows(harness.sql, "s1", "gen-2", [], NOW)).toThrow(/earlier session of the same id/u);
        expect(dropImportSession(harness.sql, "s1", "gen-2")).toBe(false);
        expect([...stagedImportIds(harness.sql, "s1")]).toStrictEqual(["a"]);
    });

    it("sweeps an expired session but keeps a manifest whose commit began, and the root's staging goes with its manifest", () => {
        expect.assertions(5);

        const old = openSession("old");

        stageImportRows(harness.sql, "old", old.generation, [{ doc: { key: "k" }, line: 1, table: "$kv" }], NOW);

        const busy = openSession("busy");

        advanceImportManifest(harness.sql, "busy", { batches: busy.batches, state: "committing" }, NOW);

        const expired = sweepImportStaging(harness.sql, NOW + IMPORT_MANIFEST_TTL_MS + 1);

        expect(expired.map((manifest) => manifest.session)).toStrictEqual(["old"]);
        expect(readShardImportSession(harness.sql, "old")).toBeUndefined();
        expect(readImportManifest(harness.sql, "old", NOW)).toBeUndefined();
        expect(readImportManifest(harness.sql, "busy", NOW + IMPORT_MANIFEST_TTL_MS + 1)?.state).toBe("committing");
        // Shards keep their rows longer than the manifest's idle TTL.
        expect(IMPORT_STAGE_TTL_MS).toBeGreaterThan(IMPORT_MANIFEST_TTL_MS);
    });

    it("never sweeps a session or a manifest whose state it cannot read", () => {
        expect.assertions(3);

        stageImportRows(harness.sql, "odd", GEN, [{ doc: { _id: "a" }, line: 1, table: "notes" }], NOW);
        exec(`UPDATE "__lunora_import_session__" SET state = 'mystery', expires_at = 0 WHERE session = 'odd'`);
        openSession("garbled");
        exec(`UPDATE "__lunora_import_manifest__" SET manifest = 'not json', expires_at = 0 WHERE session = 'garbled'`);

        expect(sweepImportStaging(harness.sql, NOW + IMPORT_STAGE_TTL_MS + 1)).toStrictEqual([]);
        expect(() => readShardImportSession(harness.sql, "odd")).toThrow(/unreadable state/u);
        expect(() => readImportManifest(harness.sql, "garbled", NOW)).toThrow(/cannot be read/u);
    });

    it("reads an open manifest past its expiry as gone", () => {
        expect.assertions(1);

        openSession("lapsed");

        expect(readImportManifest(harness.sql, "lapsed", NOW + IMPORT_MANIFEST_TTL_MS + 1)).toBeUndefined();
    });

    it("accumulates a manifest across batches, and refuses other tables, a stray close, or a session being committed", () => {
        expect.assertions(5);

        touchImportManifest(harness.sql, "s1", { begin: true, received: 2, sections: ["kv"], shards: ["c1"], tables: ["a", "b"] }, NOW);

        const { manifest } = touchImportManifest(harness.sql, "s1", { begin: false, rejected: 1, shards: ["c2", "c1"], tables: ["b", "a"] }, NOW);

        expect(manifest).toMatchObject({ batches: 1, pending: 0, received: 2, rejected: 1, sections: ["kv"], shards: ["c1", "c2"], state: "open" });
        expect(() => touchImportManifest(harness.sql, "s1", { begin: true, tables: ["a"] }, NOW)).toThrow(/other tables/u);
        expect(() => touchImportManifest(harness.sql, "s1", { begin: false, tables: ["a", "b"] }, NOW)).toThrow(/no staging request in flight/u);

        exec(`UPDATE "__lunora_import_manifest__" SET state = 'committing', manifest = json_set(manifest, '$.state', 'committing') WHERE session = 's1'`);

        expect(() => touchImportManifest(harness.sql, "s1", { begin: true, tables: ["a", "b"] }, NOW)).toThrow(/committing/u);
        expect(() => touchImportManifest(harness.sql, "nobody", { begin: false, tables: ["a"] }, NOW)).toThrow(/does not exist/u);
    });

    it("lets a commit begin only from a clean session that took no batch since its prepare", () => {
        expect.assertions(4);

        const clean = openSession("clean");

        expect(() => advanceImportManifest(harness.sql, "clean", { batches: clean.batches - 1, state: "committing" }, NOW)).toThrow(/another batch/u);

        touchImportManifest(harness.sql, "clean", { begin: true, tables: ["notes"] }, NOW);

        expect(() => advanceImportManifest(harness.sql, "clean", { batches: clean.batches + 1, state: "committing" }, NOW)).toThrow(/never finished/u);

        touchImportManifest(harness.sql, "clean", { begin: false, rejected: 1, tables: ["notes"] }, NOW);

        expect(() => advanceImportManifest(harness.sql, "clean", { batches: clean.batches + 1, state: "committing" }, NOW)).toThrow(/refused rows/u);
        expect(() => advanceImportManifest(harness.sql, "clean", { state: "committed" }, NOW)).toThrow(/is open/u);
    });

    it("makes commit and abort exclude each other", () => {
        expect.assertions(4);

        const first = openSession("raced");

        advanceImportManifest(harness.sql, "raced", { state: "aborting" }, NOW);

        expect(() => advanceImportManifest(harness.sql, "raced", { batches: first.batches, state: "committing" }, NOW)).toThrow(/aborting/u);

        const second = openSession("other");

        advanceImportManifest(harness.sql, "other", { batches: second.batches, state: "committing" }, NOW);

        expect(() => advanceImportManifest(harness.sql, "other", { state: "aborting" }, NOW)).toThrow(/send the commit again/u);
        expect(() => {
            dropImportManifest(harness.sql, "other", NOW);
        }).toThrow(/not aborting/u);

        dropImportManifest(harness.sql, "raced", NOW);

        expect(readImportManifest(harness.sql, "raced", NOW)).toBeUndefined();
    });

    it("refuses a session id that could escape a storage prefix", () => {
        expect.assertions(2);

        expect(() => assertImportSessionId("../x")).toThrow(/session id/u);
        expect(assertImportSessionId("restore-1_a")).toBe("restore-1_a");
    });
});
