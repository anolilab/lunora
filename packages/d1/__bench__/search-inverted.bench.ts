import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { beforeAll, bench, describe } from "vitest";

import createD1Exec from "../__tests__/_helpers/node-sqlite-d1";
import type { D1Exec } from "../src/d1-ctx-db";
import { backfillD1SearchIndexes, createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";

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
 */

const CLOCK = 1_700_000_000_000;
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

/** Force the portable inverted companion — the layout Postgres and MySQL use. */
const withoutFts5 = (inner: D1Exec): D1Exec => {
    return {
        all: (sql, parameters) => inner.all(sql, parameters),
        run: (sql, parameters) =>
            sql.includes("__lunora_fts_probe") && sql.includes("CREATE") ? Promise.reject(new Error("fts5 unavailable (forced)")) : inner.run(sql, parameters),
    };
};

/**
 * A corpus where term frequency is deliberately skewed: every document carries
 * `common`, one in ten carries `frequent`, and each has a unique `rare&lt;n>` —
 * so one query can touch the whole index and another exactly one row.
 */
const bodyFor = (index: number): string => {
    const filler = Array.from({ length: 12 }, (_, offset) => `word${String((index * 7 + offset * 13) % VOCABULARY)}`).join(" ");

    return `common ${index % 10 === 0 ? "frequent " : ""}rare${String(index)} ${filler}`;
};

const seed = async (rows: number): Promise<{ exec: D1Exec; writer: DatabaseWriterLike }> => {
    const harness = createD1Exec();

    harness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT, "title" TEXT)`);

    const exec = withoutFts5(harness.exec);
    const writer = createD1ContextDatabase({ clock: () => CLOCK, exec, schema: searchSchema });

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
let writeTarget: DatabaseWriterLike;
let counter = 0;

beforeAll(async () => {
    ({ writer: corpus10k } = await seed(10_000));
    ({ writer: corpus1k } = await seed(1000));
    ({ writer: writeTarget } = await seed(500));
});

describe("search — query cost vs term frequency (10k documents)", () => {
    bench("rare term (one matching document)", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "rare4242"))
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
            .withSearchIndex("by_body", (q) => q.search("body", "common rare4242"))
            .take(20);
    });

    bench("prefix term (as-you-type)", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "rare424"))
            .take(20);
    });

    bench("common term with an .eq() filter", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "common").eq("channel", "c1"))
            .take(20);
    });
});

describe("search — query cost vs corpus size (rare term)", () => {
    bench("1k documents", async () => {
        await corpus1k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "rare424"))
            .take(20);
    });

    bench("10k documents", async () => {
        await corpus10k
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "rare424"))
            .take(20);
    });
});

describe("search — write cost", () => {
    bench("insert a document (indexes ~14 tokens)", async () => {
        counter += 1;

        await writeTarget.insert("docs", { body: bodyFor(counter), channel: "c0", title: "t" });
    });

    bench("patch the indexed field (re-indexes)", async () => {
        counter += 1;

        await writeTarget.patch("d000001", { body: bodyFor(counter) });
    });

    bench("patch an unrelated field (should not re-index)", async () => {
        counter += 1;

        await writeTarget.patch("d000002", { title: `t${String(counter)}` });
    });
});

describe("search — backfill throughput", () => {
    bench(
        "backfill 2k documents into an empty companion",
        async () => {
            const harness = createD1Exec();

            harness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT, "title" TEXT)`);

            const exec = withoutFts5(harness.exec);
            const plain = createD1ContextDatabase({
                clock: () => CLOCK,
                exec,
                schema: { tables: { docs: { ...searchSchema.tables["docs"]!, searchIndexes: [] } } },
            });

            for (let index = 0; index < 2000; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- seeding is setup, not the measured work
                await plain.insert(
                    "docs",
                    { _id: `d${String(index).padStart(6, "0")}`, body: bodyFor(index), channel: "c0", title: "t" },
                    { allowExplicitId: true },
                );
            }

            await backfillD1SearchIndexes(exec, searchSchema);
        },
        { iterations: 3 },
    );
});
