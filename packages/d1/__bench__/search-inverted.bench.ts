import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import type { SqlDialect } from "@lunora/sql-store";
import { backfillSqlSearchIndexes, createSqlCtxDb } from "@lunora/sql-store";
import { beforeAll, bench, describe } from "vitest";

import { createD1Exec } from "../__tests__/_helpers/node-sqlite-d1";
import type { D1Exec } from "../src/d1-ctx-db";
import sqliteDialect from "../src/sqlite-dialect";

/**
 * Where full-text search spends its time on the `.global()` backend.
 *
 * The portable inverted companion answers a query as one indexed read, but the
 * shape of that read matters: the engine aggregates **every** `(token, id)` row
 * matching any query term before the join, the filters and the LIMIT run. So
 * the cost tracks how common the terms are, not how many rows come back — a
 * property the 1024-document limit does *not* bound, and the reason these
 * benches separate a rare term from a common one.
 *
 * Runs against `node:sqlite`. Absolute numbers mean nothing for D1 or
 * Hyperdrive (no network); the *ratios* between these cases are the signal.
 *
 * One ratio is a harness artifact and should not be read as a shipped cost: the
 * corpus-size comparison scales roughly linearly here, because a query's final
 * term matches as `LIKE 'token%'` and SQLite only turns that into an indexed
 * range scan under `case_sensitive_like=ON` (verified with EXPLAIN QUERY PLAN —
 * it reports `SCAN` otherwise). No SQLite engine actually serves this layout in
 * production: D1 and the DO ship FTS5 and take the shadow-table path, and this
 * dialect double exists only to exercise the portable one. The engines that do
 * serve it index the prefix — Postgres through the `text_pattern_ops` class the
 * companion's btree declares, MySQL through its ordinary prefix-range btree.
 */

const CLOCK = 1_700_000_000_000;

/** The portable `(token, id, occurrences)` layout Postgres and MySQL use. */
const invertedDialect: SqlDialect = { ...sqliteDialect, supportsFts5: false };
const VOCABULARY = 2000;

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const searchSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
            shape: { body: col("string"), channel: col("string"), title: col("string") },
            shardMode: { kind: "global" },
        },
    },
};

/**
 * A corpus where term frequency is deliberately skewed: every document carries
 * `common`, one in ten carries `frequent`, and each has a unique `rare&lt;n>` —
 * so one query can touch the whole index and another exactly one row.
 *
 * The rare token is **zero-padded to a fixed width** on purpose. A query's final
 * term always prefix-matches (that is the as-you-type behaviour), so an
 * unpadded `rare424` would match one document in a 1k corpus and eleven in a 10k
 * one — and the corpus-size comparison below would be measuring match count,
 * not corpus size. Padded, no rare token is a prefix of another, so the same
 * query matches exactly one document at every corpus size.
 */
const rareToken = (index: number): string => `rare${String(index).padStart(6, "0")}`;

const bodyFor = (index: number): string => {
    const filler = Array.from({ length: 12 }, (_, offset) => `word${String((index * 7 + offset * 13) % VOCABULARY)}`).join(" ");

    return `common ${index % 10 === 0 ? "frequent " : ""}${rareToken(index)} ${filler}`;
};

const seed = async (rows: number): Promise<{ exec: D1Exec; writer: DatabaseWriterLike }> => {
    const harness = createD1Exec();

    harness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT, "title" TEXT)`);

    const { exec } = harness;
    const writer = createSqlCtxDb({ clock: () => CLOCK, dialect: invertedDialect, exec, schema: searchSchema });

    for (let index = 0; index < rows; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic ids, and the write path is part of what we're measuring
        await writer.insert(
            "docs",
            { _id: `d${String(index).padStart(6, "0")}`, body: bodyFor(index), channel: `c${String(index % 4)}`, title: `t${String(index)}` },
            { allowExplicitId: true },
        );
    }

    return { exec, writer };
};

// Seeded at module scope, not inside a `describe`: Vitest's bench runner does
// not execute describe-scoped `beforeAll` hooks, so the benches would run
// against undefined fixtures and report nothing at all.
let corpus10k: DatabaseWriterLike;
let corpus1k: DatabaseWriterLike;
// One corpus per write bench, not one shared between them: the insert bench
// grows its table by one row per iteration, so a shared target would leave the
// patch benches measuring a table whose size depends on how many iterations the
// insert bench happened to run — and on the order they ran in.
let insertTarget: DatabaseWriterLike;
let patchIndexedTarget: DatabaseWriterLike;
let patchUnrelatedTarget: DatabaseWriterLike;
let counter = 0;

beforeAll(async () => {
    ({ writer: corpus10k } = await seed(10_000));
    ({ writer: corpus1k } = await seed(1000));
    ({ writer: insertTarget } = await seed(500));
    ({ writer: patchIndexedTarget } = await seed(500));
    ({ writer: patchUnrelatedTarget } = await seed(500));
});

describe("search — query cost vs term frequency (10k documents)", () => {
    bench("rare term (one matching document)", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", rareToken(4242)))
            .take(20);
    });

    bench("frequent term (one in ten documents)", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "frequent"))
            .take(20);
    });

    bench("common term (every document — the pathological case)", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "common"))
            .take(20);
    });

    bench("common term narrowed by a rare one (AND intersection)", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", `common ${rareToken(4242)}`))
            .take(20);
    });

    // A partial rare token, which is what the search box sends mid-word: it
    // prefix-matches the ten documents whose padded id extends it.
    bench("prefix term (as-you-type)", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "rare00424"))
            .take(20);
    });

    bench("common term with an .eq() filter", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "common").eq("channel", "c1"))
            .take(20);
    });
});

// The same term, matching exactly one document in both corpora — so the delta
// is the cost of the index being ten times larger and nothing else.
describe("search — query cost vs corpus size (rare term, one match either way)", () => {
    bench("1k documents", async () => {
        await corpus1k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", rareToken(424)))
            .take(20);
    });

    bench("10k documents", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", rareToken(424)))
            .take(20);
    });
});

describe("search — write cost", () => {
    bench("insert a document (indexes ~14 tokens)", async () => {
        counter += 1;

        await insertTarget.insert("docs", { body: bodyFor(counter), channel: "c0", title: "t" });
    });

    bench("patch the indexed field (re-indexes)", async () => {
        counter += 1;

        await patchIndexedTarget.patch("d000001", { body: bodyFor(counter) });
    });

    bench("patch an unrelated field (should not re-index)", async () => {
        counter += 1;

        await patchUnrelatedTarget.patch("d000002", { title: `t${String(counter)}` });
    });
});

// Seeded once, outside the measured body: the previous shape timed 2000 inserts
// plus the backfill and reported the sum as backfill throughput.
let backfillExec: D1Exec;

beforeAll(async () => {
    const harness = createD1Exec();

    harness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT, "title" TEXT)`);

    backfillExec = harness.exec;

    const plain = createSqlCtxDb({
        clock: () => CLOCK,
        dialect: invertedDialect,
        exec: backfillExec,
        schema: { tables: { docs: { ...searchSchema.tables["docs"]!, searchIndexes: [] } } },
    });

    for (let index = 0; index < 2000; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- seeding is setup, not the measured work
        await plain.insert("docs", { _id: `d${String(index).padStart(6, "0")}`, body: bodyFor(index), channel: "c0", title: "t" }, { allowExplicitId: true });
    }

    // Once, so the companion and state tables exist; the measured body resets
    // their contents rather than paying for the DDL each iteration.
    await backfillSqlSearchIndexes(backfillExec, searchSchema, invertedDialect);
});

describe("search — backfill throughput", () => {
    bench(
        "backfill 2k documents into an empty companion",
        async () => {
            // Each iteration re-runs the walk; the state row is reset so the
            // work is real rather than an immediate "already done" return. The
            // two resets are inside the measurement — they are two statements
            // against ~28k companion rows, small beside 2000 document indexings.
            await backfillExec.run(`DELETE FROM "__lunora_search_state"`, []);
            await backfillExec.run(`DELETE FROM "docs__fts_by_body"`, []);
            await backfillSqlSearchIndexes(backfillExec, searchSchema, invertedDialect);
        },
        { iterations: 3 },
    );
});
