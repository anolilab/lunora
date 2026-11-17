import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { beforeAll, bench, describe } from "vitest";

import { createD1Exec } from "../__tests__/_helpers/node-sqlite-d1";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";

/**
 * The `.global()` shape poll's changed-tables read (`cdcChangedTables`) over a 50k-entry changelog,
 * asked once per tick per shard. The steady-state arm polls a 20-row delta; the cold arm polls from
 * the start of the log, the far end of what a lagging consumer can ask for.
 */

const LOG_ROWS = 50_000;
const TABLES = 20;
const DELTA = 20;

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schema: SchemaLike = {
    tables: Object.fromEntries(
        Array.from({ length: TABLES }, (_, index) => [`t${String(index)}`, { indexes: [], shape: { body: col("string") }, shardMode: { kind: "global" } }]),
    ),
};

const harness = createD1Exec();
const writer: DatabaseWriterLike = createD1ContextDatabase({ cdc: true, clock: () => 1, exec: harness.exec, provisionScope: harness, schema });

let seeded: Promise<void> | undefined;

/** Provision the log through the store, then fill it directly: the rows are setup. Awaited from the bodies too (see `per-request-writer`). */
const ready = (): Promise<void> => {
    seeded ??= (async (): Promise<void> => {
        await writer.count("t0");

        const document = JSON.stringify({ body: "x".repeat(200) });

        for (let index = 0; index < LOG_ROWS; index += 1) {
            harness.ddl(
                `INSERT INTO "__cdc_log" ("ts", "table", "id", "op", "doc") VALUES (${String(index)}, 't${String(index % TABLES)}', 'x${String(index)}', 'insert', '${document}')`,
            );
        }
    })();

    return seeded;
};

describe("d1 cdcChangedTables over a 50k-entry log", () => {
    beforeAll(ready);

    bench(`steady-state poll, ${String(DELTA)}-row delta`, async () => {
        await ready();
        await writer.cdcChangedTables?.(LOG_ROWS - DELTA);
    });

    bench("cold poll from the start of the log", async () => {
        await ready();
        await writer.cdcChangedTables?.(0);
    });
});
