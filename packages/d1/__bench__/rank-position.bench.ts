import type { DatabaseWriterLike, RankIndexDefinitionLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { beforeAll, bench, describe } from "vitest";

import { createD1Exec } from "../__tests__/_helpers/node-sqlite-d1";
import { createD1CtxDb as createD1ContextDatabase, runD1RankMigrations } from "../src/d1-ctx-db";

/**
 * D1 column-dialect twin of `@lunora/do/rank-position`. `rank()` over a
 * declared `rankIndex` is one SQLite index seek on the companion table.
 * Without an index the only way to answer is to walk the partition and
 * indexOf the candidate row — O(partition size). The win shape is the
 * same as the JSON-blob path; we bench D1 explicitly so global tables
 * keep the regression signal.
 */

const ROWS_PER_CHANNEL = 1000;
const CHANNEL_COUNT = 10;
const CLOCK = 1_700_000_000_000;

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const byChannel: RankIndexDefinitionLike = {
    name: "byChannel",
    on: "messages",
    partitionBy: ["channelId"],
    sortBy: [{ direction: "asc", field: "seq" }],
};

const indexedSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [],
            rankIndexes: [byChannel],
            shape: { channelId: col("string"), seq: col("number") },
        },
    },
};

const scanSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [],
            shape: { channelId: col("string"), seq: col("number") },
        },
    },
};

const createWriter = async (schema: SchemaLike): Promise<DatabaseWriterLike> => {
    const harness = createD1Exec();

    harness.ddl(
        `CREATE TABLE "messages" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "channelId" TEXT,
            "seq" INTEGER
        )`,
    );

    if (schema.tables["messages"]?.rankIndexes) {
        await runD1RankMigrations(harness.exec, schema);
    }

    return createD1ContextDatabase({ clock: () => CLOCK, exec: harness.exec, schema });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
        for (let index = 0; index < ROWS_PER_CHANNEL; index += 1) {
            // allowExplicitId so the row lands under its `m-c{channel}-{index}`
            // id — the default insert path mints a fresh id and ignores `_id`,
            // which leaves the scan/`rank()` unable to find TARGET_ID.
            // eslint-disable-next-line no-await-in-loop -- sequential seed: rows insert one at a time to keep deterministic _creationTime ordering
            await writer.insert(
                "messages",
                {
                    _id: `m-c${String(channel)}-${String(index).padStart(5, "0")}`,
                    channelId: `c${String(channel)}`,
                    seq: index,
                },
                { allowExplicitId: true },
            );
        }
    }
};

const TARGET_CHANNEL = `c${String(Math.floor(CHANNEL_COUNT / 2))}`;
const TARGET_INDEX = Math.floor(ROWS_PER_CHANNEL / 2);
const TARGET_ID = `m-${TARGET_CHANNEL}-${String(TARGET_INDEX).padStart(5, "0")}`;

let indexedWriter: DatabaseWriterLike;
let scanWriter: DatabaseWriterLike;

// Build + seed the writers in beforeAll (not at module top level, whose await
// state CodSpeed's runner doesn't pick up). The seed itself must use
// `allowExplicitId` (see `seed`) or the rows land under generated ids and the
// scan/`rank()` can't find TARGET_ID ("row not found in emulated scan").
beforeAll(async () => {
    indexedWriter = await createWriter(indexedSchema);
    await seed(indexedWriter);
    scanWriter = await createWriter(scanSchema);
    await seed(scanWriter);
});

describe("d1 rank() — indexed vs emulated scan", () => {
    bench("indexed: rank() via companion table seek", async () => {
        await indexedWriter.rank("messages", "byChannel", { row: TARGET_ID });
    });

    bench("emulated: findMany(channel) + JS index-of", async () => {
        const scan = scanWriter;

        let cursor: null | string = null;
        let position: null | number = null;
        let total = 0;
        let cursorAccumulator = 0;

        while (true) {
            // eslint-disable-next-line no-await-in-loop -- cursor walk: each page depends on the prior page's continueCursor, so it must be sequential
            const page = await scan.findMany("messages", {
                cursor,
                limit: 200,
                orderBy: [{ seq: "asc" }],
                where: { channelId: TARGET_CHANNEL },
            });

            total += page.page.length;

            if (position === null) {
                const found = page.page.findIndex((document) => document["_id"] === TARGET_ID);

                if (found !== -1) {
                    position = cursorAccumulator + found + 1;
                }
            }

            if (page.isDone) {
                break;
            }

            cursor = page.continueCursor;
            cursorAccumulator += page.page.length;
        }

        if (position === null || total === 0) {
            throw new Error("bench invariant: row not found in emulated scan");
        }
    });
});
