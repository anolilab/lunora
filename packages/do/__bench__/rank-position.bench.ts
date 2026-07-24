import type { RankIndexDefinitionLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { makeWriter } from "./shared";

/**
 * `rank()` is "where does this row stand in its partition?" — a hot question
 * for leaderboards, feeds, and ordered cursors. With a declared
 * `rankIndex` the answer is one SQLite index seek on the companion table;
 * without one, the only way to answer is "fetch the partition's ordered
 * rows and count the ones strictly before the candidate" — O(partition size).
 *
 * - **indexed** — `writer.rank("messages", "byChannel", { row })` → seeks
 * the rank companion table; SQLite's index does the work.
 * - **emulated scan** — same answer via `findMany(orderBy seq asc, where
 * channelId)`, then JS-side index-of the candidate. Mirrors what an
 * app without a `rankIndex` has to do.
 *
 * Partition size: 1 000 rows in one channel, 10 channels total (10k rows
 * on disk). The bench picks a row at the median position so both paths do
 * equivalent work; the win is the algorithmic shape.
 */

const ROWS_PER_CHANNEL = 1000;
const CHANNEL_COUNT = 10;

const byChannel: RankIndexDefinitionLike = {
    name: "byChannel",
    on: "messages",
    partitionBy: ["channelId"],
    sortBy: [{ direction: "asc", field: "seq" }],
};

const indexedSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId"], name: "by_channel" }],
            rankIndexes: [byChannel],
            shape: { channelId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const scanSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId"], name: "by_channel" }],
            shape: { channelId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
        for (let index = 0; index < ROWS_PER_CHANNEL; index += 1) {
            // allowExplicitId so the row lands under its `m-c{channel}-{index}`
            // id — the default insert path mints a fresh id and ignores `_id`,
            // which leaves the scan/`rank()` unable to find TARGET_ID.
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
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

// Median position of the median channel.
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
    indexedWriter = makeWriter(indexedSchema);
    await seed(indexedWriter);
    scanWriter = makeWriter(scanSchema);
    await seed(scanWriter);
});

describe("rank() — indexed vs emulated scan", () => {
    bench("indexed: rank() via companion table seek", async () => {
        await indexedWriter.rank("messages", "byChannel", { row: TARGET_ID });
    });

    bench("emulated: findMany(channel) + JS index-of", async () => {
        // Walk the partition. ~1000 rows fetched & decoded; then findIndex.
        let cursor: null | string = null;
        let position: null | number = null;
        let total = 0;
        let cursorAccumulator = 0;

        while (true) {
            // eslint-disable-next-line no-await-in-loop -- sequential cursor walk over partition pages
            const page = await scanWriter.findMany("messages", {
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

        // Defeat dead-store elimination so the loop's work is observable.
        if (position === null || total === 0) {
            throw new Error("bench invariant: row not found in emulated scan");
        }
    });
});
