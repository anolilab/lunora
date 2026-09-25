import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import type { SqlDialect, SqlExec } from "@lunora/sql-store";
import { backfillSqlSearchIndexes, runSqlGlobalTableMigrations, runSqlSearchMigrations } from "@lunora/sql-store";
import { expect } from "vitest";

import type { HyperdriveEngine } from "../../src/global";
import { createHyperdriveGlobalCtxDb } from "../../src/global";

/**
 * A search companion under writers from separate isolates, against a real
 * engine: the portable inverted layout, or with `native` the engine's own
 * full-text index (Postgres only) — the Postgres and MySQL twin of `@lunora/sql-store`'s
 * workerd + D1 concurrency suite.
 *
 * Each case drives the interleaving deterministically: one exec is held at a
 * chosen companion statement while another writer runs to completion, then
 * released. Every assertion counts companion rows, because a document indexed
 * twice is still "indexed".
 *
 * Both engines here run one connection, so the held statement has not reached
 * the server: this pins the order statements land in, not what the engines'
 * row locks do with two of them in flight at once.
 *
 * Handed back as `[name, run]` pairs for each suite's own `it.each`, so every
 * case runs inside that suite's describe and its setup hooks.
 */
interface RaceTarget {
    dialect: SqlDialect;
    engine: HyperdriveEngine;
    exec: () => SqlExec;
    /** Every index on the companion as `name → unique`. */
    indexes: (companion: string) => Promise<Map<string, boolean>>;
    /** Raw statement against the engine, for building the previous layout and counting rows. */
    query: (sql: string, parameters?: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    /** Drop every table a case creates. */
    reset: () => Promise<void>;
}

type Gate = (text: string, parameters: ReadonlyArray<unknown>) => Promise<void>;

const COMPANION = "notes__fts_by_body";
const ROWS = 30;

const column = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schemaFor = (index?: Record<string, unknown>): SchemaLike =>
    ({
        tables: {
            notes: {
                indexes: [],
                searchIndexes: index ? [index] : [],
                shape: { body: column("string"), title: column("string") },
                shardMode: { kind: "global" },
            },
        },
    }) as never;

const pad = (n: number): string => `r${String(n).padStart(4, "0")}`;

/** `exec`, awaiting `gate` before each statement it is handed. */
const gated = (exec: SqlExec, gate: Gate): SqlExec => {
    return {
        all: async (text, parameters) => {
            await gate(text, parameters);

            return exec.all(text, parameters);
        },
        batch:
            exec.batch === undefined
                ? undefined
                : async (statements) => {
                      for (const statement of statements) {
                          // eslint-disable-next-line no-await-in-loop -- each statement is offered to the gate in order
                          await gate(statement.sql, statement.params);
                      }

                      await exec.batch?.(statements);
                  },
        run: async (text, parameters) => {
            await gate(text, parameters);

            return exec.run(text, parameters);
        },
    };
};

/** A gate holding the first statement `matches` accepts until `release()`, reporting it through `reached`. */
const holdAt = (matches: (text: string, parameters: ReadonlyArray<unknown>) => boolean): { gate: Gate; reached: Promise<void>; release: () => void } => {
    let release!: () => void;
    let reach!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
        reach = resolve;
    });
    let held = false;

    return {
        gate: async (text, parameters) => {
            if (!held && matches(text, parameters)) {
                held = true;
                reach();
                await released;
            }
        },
        reached,
        release,
    };
};

/** Statements that touch the companion for `target`. */
const touchesCompanion = (target: string) => (text: string, parameters: ReadonlyArray<unknown>) => text.includes(COMPANION) && parameters.includes(target);

/** The statement that inserts `target`'s entry rows — after any purge in front of it. */
const insertsEntry = (target: string) => (text: string, parameters: ReadonlyArray<unknown>) =>
    /\bINSERT INTO [`"]notes__fts_by_body[`"]/u.test(text) && parameters.includes(target);

type RaceCase = [name: string, run: () => Promise<void>];

const searchRaceCases = (target: RaceTarget, options: { native?: boolean } = {}): RaceCase[] => {
    const cases: RaceCase[] = [];
    const native = options.native === true;
    const INDEX = { field: "body", filterFields: [], name: "by_body", ...(native ? { strategy: "native" } : {}) };
    /** Companion rows one two-token document holds: one per token, or its one vector row. */
    const perDocument = native ? 1 : 2;
    let tick = 1_700_000_000_000;

    const writer = (exec: SqlExec, index?: Record<string, unknown>): DatabaseWriterLike =>
        createHyperdriveGlobalCtxDb({
            clock: () => {
                tick += 1000;

                return tick;
            },
            engine: target.engine,
            exec,
            schema: schemaFor(index),
        });

    /** `ROWS` rows written while the table has no search index, so none of them is indexed. */
    const seed = async (body: (n: number) => string): Promise<void> => {
        await target.reset();
        await runSqlGlobalTableMigrations(target.exec(), schemaFor(), target.dialect);

        const plain = writer(target.exec());

        for (let n = 0; n < ROWS; n += 1) {
            // eslint-disable-next-line no-await-in-loop -- rows are seeded in order
            await plain.insert("notes", { _id: pad(n), body: body(n), title: "t" }, { allowExplicitId: true });
        }
    };

    const companionRows = async (id?: string): Promise<number> => {
        const placeholder = target.engine === "postgres" ? "$1" : "?";
        const rows = await (id === undefined
            ? target.query(`SELECT COUNT(*) AS n FROM ${COMPANION}`)
            : target.query(`SELECT COUNT(*) AS n FROM ${COMPANION} WHERE __id__ = ${placeholder}`, [id]));

        return Number(rows[0]?.["n"]);
    };

    const search = async (term: string): Promise<unknown[]> => {
        const hits = await writer(target.exec(), INDEX)
            .query("notes")
            .withSearchIndex(INDEX.name, (q) => q.search("body", term))
            .collect();

        return hits.map((hit) => hit["_id"]);
    };

    cases.push([
        "indexes a row once when two cold-start backfills interleave between purge and insert",
        async () => {
            expect.assertions(3);

            const row = pad(10);

            await seed((n) => (n === 10 ? "apple common" : `other${String(n)} common`));

            // Isolate A: its cold-start page, held after its purge of the row.
            const hold = holdAt(insertsEntry(row));
            const isolateA = runSqlSearchMigrations(gated(target.exec(), hold.gate), schemaFor(INDEX), target.dialect);

            await hold.reached;
            // Isolate B: a whole cold-start page while A is mid-row.
            await runSqlSearchMigrations(target.exec(), schemaFor(INDEX), target.dialect);
            hold.release();
            await isolateA;

            await expect(companionRows(row)).resolves.toBe(perDocument);
            await expect(companionRows()).resolves.toBe(perDocument * ROWS);
            await expect(search("apple")).resolves.toStrictEqual([row]);
        },
    ]);

    /** Two writers past their cold starts; A's statements pass through `gate`, then `wrap`. */
    const livePair = async (gate: Gate, wrap: (exec: SqlExec) => SqlExec = (exec) => exec): Promise<[DatabaseWriterLike, DatabaseWriterLike]> => {
        await seed((n) => `word${String(n)} common`);
        await backfillSqlSearchIndexes(target.exec(), schemaFor(INDEX), target.dialect);

        const isolateA = writer(wrap(gated(target.exec(), gate)), INDEX);
        const isolateB = writer(target.exec(), INDEX);

        // Each past its own cold start.
        await isolateA.count("notes");
        await isolateB.count("notes");

        return [isolateA, isolateB];
    };

    cases.push(
        [
            "keeps the newer text when the older live write reaches the companion last",
            async () => {
                expect.assertions(3);

                const row = pad(20);
                const hold = holdAt(touchesCompanion(row));
                const [isolateA, isolateB] = await livePair(hold.gate);
                const older = isolateA.patch(row, { body: "olderword common" });

                await hold.reached;
                await isolateB.patch(row, { body: "newerword common" });
                hold.release();
                await older;

                await expect(search("newerword")).resolves.toStrictEqual([row]);
                await expect(search("olderword")).resolves.toStrictEqual([]);
                await expect(companionRows(row)).resolves.toBe(perDocument);
            },
        ],
        [
            "never exposes the older text, even before the older live write re-checks the row",
            async () => {
                expect.assertions(1);

                // Held twice: at its companion write while B writes the row, then just
                // before it re-reads the row. By then its own entry write has run, so
                // an unguarded one would be sitting in the companion right now.
                const row = pad(20);
                const atWrite = holdAt(touchesCompanion(row));
                const atRecheck = holdAt((text) => /^SELECT \* FROM [`"]notes[`"] WHERE [`"]id[`"] >=/u.test(text));
                let written = false;
                const [isolateA, isolateB] = await livePair(async (text, parameters) => {
                    await atWrite.gate(text, parameters);

                    if (written) {
                        await atRecheck.gate(text, parameters);
                    }
                });
                const older = isolateA.patch(row, { body: "olderword common" });

                await atWrite.reached;
                await isolateB.patch(row, { body: "newerword common" });
                written = true;
                atWrite.release();
                await atRecheck.reached;

                const exposed = await search("olderword");

                atRecheck.release();
                await older;

                expect(exposed).toStrictEqual([]);
            },
        ],
        [
            "indexes the older live write's text when the newer write left the indexed text alone",
            async () => {
                expect.assertions(2);

                const row = pad(20);
                const hold = holdAt(touchesCompanion(row));
                const [isolateA, isolateB] = await livePair(hold.gate);
                const writing = isolateA.patch(row, { body: "onlyword common" });

                await hold.reached;
                await isolateB.patch(row, { title: "renamed" });
                hold.release();
                await writing;

                await expect(search("onlyword")).resolves.toStrictEqual([row]);
                await expect(companionRows(row)).resolves.toBe(perDocument);
            },
        ],
        [
            "keeps a re-inserted document's entry when the delete's purge lands last",
            async () => {
                expect.assertions(2);

                const row = pad(20);
                const hold = holdAt(touchesCompanion(row));
                const [isolateA, isolateB] = await livePair(hold.gate);
                const deleting = isolateA.delete(row);

                await hold.reached;
                await isolateB.insert("notes", { _id: row, body: "rebornword common", title: "t" }, { allowExplicitId: true });
                hold.release();
                await deleting;

                await expect(search("rebornword")).resolves.toStrictEqual([row]);
                await expect(companionRows(row)).resolves.toBe(perDocument);
            },
        ],
        [
            "never drops a re-inserted document's entry, even before the delete re-checks the row",
            async () => {
                expect.assertions(1);

                // Held at its purge while B re-inserts the row, then just before it
                // re-reads the row. By then its purge has run, so only the purge's
                // own guard can have kept B's entry.
                const row = pad(20);
                const atPurge = holdAt(touchesCompanion(row));
                const atRecheck = holdAt((text) => /^SELECT \* FROM [`"]notes[`"] WHERE [`"]notes[`"]\.[`"]id[`"] IN/u.test(text));
                let purged = false;
                const [isolateA, isolateB] = await livePair(async (text, parameters) => {
                    await atPurge.gate(text, parameters);

                    if (purged) {
                        await atRecheck.gate(text, parameters);
                    }
                });
                const deleting = isolateA.delete(row);

                await atPurge.reached;
                await isolateB.insert("notes", { _id: row, body: "rebornword common", title: "t" }, { allowExplicitId: true });
                purged = true;
                atPurge.release();
                await atRecheck.reached;

                const kept = await search("rebornword");

                atRecheck.release();
                await deleting;

                expect(kept).toStrictEqual([row]);
            },
        ],
        [
            "re-indexes a re-inserted document when the delete's purge read the row as absent",
            async () => {
                expect.assertions(2);

                // A Postgres DELETE reads its guard at the statement's snapshot, so a
                // re-insert that commits while the purge runs still reads as absent.
                // One connection cannot interleave inside a statement, so A's purge
                // runs here without its guard, as that snapshot would decide it.
                const row = pad(20);
                let isolateB: DatabaseWriterLike | undefined;
                let purged = false;
                const staleSnapshot = (exec: SqlExec): SqlExec => {
                    return {
                        ...exec,
                        run: async (text, parameters) => {
                            if (purged || !/^DELETE FROM [`"]notes__fts_by_body[`"]/u.test(text) || !parameters.includes(row)) {
                                return exec.run(text, parameters);
                            }

                            purged = true;
                            await isolateB?.insert("notes", { _id: row, body: "rebornword common", title: "t" }, { allowExplicitId: true });

                            return exec.run(text.slice(0, text.indexOf(" AND NOT EXISTS")), parameters.slice(0, 1));
                        },
                    };
                };
                const [isolateA, other] = await livePair(async () => {}, staleSnapshot);

                isolateB = other;
                await isolateA.delete(row);

                await expect(search("rebornword")).resolves.toStrictEqual([row]);
                await expect(companionRows(row)).resolves.toBe(perDocument);
            },
        ],
    );

    if (native) {
        // The rest pin the inverted layout's token rows and its unique-key migration.
        return cases;
    }

    cases.push([
        "replaces a document's rows when its old and new text share tokens",
        async () => {
            expect.assertions(2);

            await seed((n) => `word${String(n)} common`);
            await backfillSqlSearchIndexes(target.exec(), schemaFor(INDEX), target.dialect);
            await writer(target.exec(), INDEX).patch(pad(3), { body: "common common fresh" });

            // `common` is both purged and re-inserted by the one write.
            const rows = await target.query(`SELECT __token__ AS t, __n__ AS n FROM ${COMPANION} WHERE __id__ = '${pad(3)}' ORDER BY __token__`);

            expect(rows.map((row) => `${String(row["t"])}:${String(row["n"])}`)).toStrictEqual(["common:2", "fresh:1"]);
            await expect(search("word3")).resolves.toStrictEqual([]);
        },
    ]);

    /**
     * The layout the previous build left: no unique key, the plain `(token, id)`
     * index, a finished backfill, and `extra` rows added on top.
     */
    const legacyCompanion = async (rows: number, body: (n: number) => string, extra: [token: string, id: string, n: number][]): Promise<void> => {
        await target.reset();
        await runSqlGlobalTableMigrations(target.exec(), schemaFor(), target.dialect);

        const plain = writer(target.exec());
        const legacy = writer(target.exec(), INDEX);

        for (let n = 0; n < rows; n += 1) {
            // eslint-disable-next-line no-await-in-loop -- rows are seeded in order
            await plain.insert("notes", { _id: pad(n), body: body(n), title: "t" }, { allowExplicitId: true });
        }

        // Index everything, then take the key off and put the plain index back.
        await backfillSqlSearchIndexes(target.exec(), schemaFor(INDEX), target.dialect);
        await legacy.count("notes");

        if (target.engine === "mysql") {
            await target.query(`DROP INDEX ${COMPANION}__unique ON ${COMPANION}`);
            await target.query(`CREATE INDEX ${COMPANION}__btree ON ${COMPANION} (__token__(191), __id__(191))`);
        } else {
            await target.query(`DROP INDEX ${COMPANION}__unique`);
            await target.query(`CREATE INDEX ${COMPANION}__btree ON ${COMPANION} (__token__ text_pattern_ops, __id__ text_pattern_ops)`);
        }

        await target.query(`DELETE FROM __lunora_search_state WHERE companion = '${COMPANION}#unique'`);

        for (const [token, id, n] of extra) {
            // eslint-disable-next-line no-await-in-loop -- inserted in order
            await target.query(`INSERT INTO ${COMPANION} (__token__, __id__, __n__) VALUES ('${token}', '${id}', ${String(n)})`);
        }
    };

    /** `exec`, recording every statement it is handed into `into`. */
    const recording = (into: string[]): SqlExec =>
        gated(target.exec(), async (text) => {
            into.push(text);
        });

    /** Statements that read the companion's rows in bulk: a grouping scan, or a walk over its documents. */
    const scansCompanion = (statements: ReadonlyArray<string>): string[] =>
        statements.filter((text) => text.includes(COMPANION) && /\bGROUP BY\b|\bSELECT DISTINCT\b/u.test(text));

    const hasKey = async (): Promise<boolean | undefined> => {
        const held = await target.indexes(COMPANION);

        return held.get(`${COMPANION}__unique`);
    };

    cases.push(
        [
            "leaves a keyless companion alone on a cold start: no scan, no index build",
            async () => {
                expect.assertions(3);

                await legacyCompanion(ROWS, (n) => `word${String(n)} common`, []);

                const statements: string[] = [];

                await runSqlSearchMigrations(recording(statements), schemaFor(INDEX), target.dialect);

                // The build belongs to `backfillSqlSearchIndexes`; a request pays one catalog probe.
                expect(scansCompanion(statements)).toStrictEqual([]);
                expect(statements.filter((text) => /CREATE UNIQUE INDEX/u.test(text))).toStrictEqual([]);
                await expect(hasKey()).resolves.toBeUndefined();
            },
        ],
        [
            "adds the key to a clean companion in one statement, without scanning it for duplicates",
            async () => {
                expect.assertions(4);

                await legacyCompanion(ROWS, (n) => `word${String(n)} common`, []);

                const statements: string[] = [];
                const result = await backfillSqlSearchIndexes(recording(statements), schemaFor(INDEX), target.dialect);

                expect(scansCompanion(statements)).toStrictEqual([]);
                expect(statements.filter((text) => /CREATE UNIQUE INDEX/u.test(text))).toHaveLength(1);
                expect(result.uniqueKeyMissing).toStrictEqual([]);
                await expect(target.indexes(COMPANION)).resolves.toStrictEqual(
                    new Map([
                        [`${COMPANION}__by_id`, false],
                        [`${COMPANION}__unique`, true],
                    ]),
                );
            },
        ],
        [
            "adds the key to a companion holding duplicates, repairing each from its source row",
            async () => {
                expect.assertions(6);

                // pad(4) doubled outright; pad(5) holds a stale token from a racing
                // write as well as a duplicate of a current one.
                await legacyCompanion(ROWS, (n) => `word${String(n)} common`, [
                    ["word4", pad(4), 1],
                    ["common", pad(4), 1],
                    ["staleword", pad(5), 1],
                    ["common", pad(5), 1],
                ]);

                const result = await backfillSqlSearchIndexes(target.exec(), schemaFor(INDEX), target.dialect);

                expect(result.uniqueKeyMissing).toStrictEqual([]);
                await expect(hasKey()).resolves.toBe(true);
                await expect(companionRows(pad(4))).resolves.toBe(2);
                await expect(companionRows(pad(5))).resolves.toBe(2);
                await expect(companionRows()).resolves.toBe(2 * ROWS);
                await expect(search("staleword")).resolves.toStrictEqual([]);
            },
        ],
        [
            "still adds the key when a duplicate appears while it builds",
            async () => {
                expect.assertions(3);

                await legacyCompanion(ROWS, (n) => `word${String(n)} common`, []);

                // A writer on the previous build doubles a row just before the build,
                // so the first attempt fails on it.
                const hold = holdAt((text) => /CREATE UNIQUE INDEX/u.test(text));
                const building = backfillSqlSearchIndexes(gated(target.exec(), hold.gate), schemaFor(INDEX), target.dialect);

                await hold.reached;
                await target.query(`INSERT INTO ${COMPANION} (__token__, __id__, __n__) VALUES ('common', '${pad(1)}', 1)`);
                hold.release();

                const result = await building;

                expect(result.uniqueKeyMissing).toStrictEqual([]);
                await expect(companionRows(pad(1))).resolves.toBe(2);
                await expect(hasKey()).resolves.toBe(true);
            },
        ],
        [
            "never leaves a document with no rows when every later statement of each attempt loses to a field-only write",
            async () => {
                expect.assertions(3);

                // A field-only write lands before every companion statement but the
                // first of each attempt. Its writer skips the companion (the text is
                // unchanged), so only this write's re-check can index the row — and
                // it loses every round. What the first statements left must still
                // hold the document.
                const row = pad(20);
                let other: DatabaseWriterLike | undefined;
                let inAttempt = 0;
                let bumps = 0;
                const [isolateA, isolateB] = await livePair(async (text, parameters) => {
                    if (/^SELECT \* FROM [`"]notes[`"] WHERE [`"]id[`"] >=/u.test(text)) {
                        inAttempt = 0;

                        return;
                    }

                    if (other !== undefined && text.includes(COMPANION) && parameters.includes(row)) {
                        inAttempt += 1;

                        if (inAttempt > 1) {
                            bumps += 1;
                            await other.patch(row, { title: `t${String(bumps)}` });
                        }
                    }
                });

                other = isolateB;
                await isolateA.patch(row, { body: "freshword common" });

                await expect(companionRows(row)).resolves.toBeGreaterThan(0);
                await expect(search("common")).resolves.toContain(row);
                // Postgres writes in one statement, so there is nothing to lose between.
                expect(bumps).toBe(target.engine === "mysql" ? 10 : 0);
            },
        ],
    );

    if (target.engine === "postgres") {
        cases.push([
            "drops an index a failed concurrent build left invalid, and builds the key again",
            async () => {
                expect.assertions(2);

                await legacyCompanion(ROWS, (n) => `word${String(n)} common`, []);
                await backfillSqlSearchIndexes(target.exec(), schemaFor(INDEX), target.dialect);
                // What a `CREATE INDEX CONCURRENTLY` that failed part way leaves behind.
                await target.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${COMPANION}__unique'::regclass`);

                const result = await backfillSqlSearchIndexes(target.exec(), schemaFor(INDEX), target.dialect);
                const valid = await target.query(`SELECT indisvalid FROM pg_index WHERE indexrelid = '${COMPANION}__unique'::regclass`);

                expect(result.uniqueKeyMissing).toStrictEqual([]);
                expect(valid.map((entry) => entry["indisvalid"])).toStrictEqual([true]);
            },
        ]);
    }

    if (target.engine === "mysql") {
        cases.push([
            "reports the key missing when two ids share its 512-character id prefix",
            async () => {
                expect.assertions(2);

                const prefix = "x".repeat(512);

                await legacyCompanion(ROWS, (n) => `word${String(n)} common`, [
                    ["common", `${prefix}a`, 1],
                    ["common", `${prefix}b`, 1],
                ]);

                const result = await backfillSqlSearchIndexes(target.exec(), schemaFor(INDEX), target.dialect);

                expect(result.uniqueKeyMissing).toStrictEqual([COMPANION]);
                await expect(hasKey()).resolves.toBeUndefined();
            },
        ]);
    }

    return cases;
};

export default searchRaceCases;
