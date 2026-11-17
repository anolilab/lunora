import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { beforeAll, bench, describe } from "vitest";

import { createD1Exec } from "../__tests__/_helpers/node-sqlite-d1";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";

/**
 * The `.global()` store as a host drives it: a fresh writer per request, sharing one `provisionScope`
 * (the D1 binding). `count-indexed-vs-scan` reuses one writer for every iteration, so it measures the
 * steady state of a single request and cannot see per-request costs: the aggregate/rank companion
 * rebuild that ran on each writer's first touch, and the `SELECT 1` id probe ahead of a pinned write.
 */

const ROW_COUNT = 10_000;
const PROJECTS = 10;

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: { body: col("string") },
            shardMode: { kind: "global" },
        },
        todos: {
            aggregateIndexes: [{ by: ["projectId"], name: "byProject", on: "todos", op: "count" }],
            indexes: [],
            rankIndexes: [{ name: "byScore", on: "todos", partitionBy: ["projectId"], sortBy: [{ direction: "desc", field: "score" }] }],
            shape: { projectId: col("string"), score: col("number") },
            shardMode: { kind: "global" },
        },
    },
};

const harness = createD1Exec();
let clock = 1_700_000_000_000;

/** One request's writer, the way the generated worker builds it. */
const requestWriter = (): DatabaseWriterLike =>
    createD1ContextDatabase({
        clock: () => {
            clock += 1;

            return clock;
        },
        exec: harness.exec,
        provisionScope: harness,
        schema,
    });

let seeded: Promise<void> | undefined;

/**
 * Provision through the store, then seed with plain inserts: the seed is setup, and routing it through the
 * store would only time the rebuild. Then one count and one patch through the scope, so a build that
 * rebuilds once per scope is measured in its steady state, and one that rebuilds per writer still pays
 * for it in every iteration.
 *
 * Wired as a `beforeAll` (CodSpeed's runner honours it) and awaited from each bench body too: the plain
 * `vitest bench` runner here did not run the hook ahead of the bodies, which then read an empty database.
 */
const seed = async (): Promise<void> => {
    await requestWriter().count("notes");

    for (let index = 0; index < ROW_COUNT; index += 1) {
        harness.ddl(
            `INSERT INTO "todos" ("id", "_creationTime", "projectId", "score") VALUES ('t${String(index)}', ${String(index)}, 'p${String(index % PROJECTS)}', ${String(index % 997)})`,
        );
    }

    harness.ddl(`INSERT INTO "notes" ("id", "_creationTime", "body") VALUES ('n1', 1, 'a')`);

    await requestWriter().count("todos", { where: { projectId: "p5" } });
    await requestWriter().patch("todos", "t42", { score: 1 });
};

const ready = (): Promise<void> => {
    seeded ??= seed();

    return seeded;
};

describe("d1 — a fresh writer per request over 10k rows", () => {
    beforeAll(ready);

    bench("indexed count by projectId", async () => {
        await ready();
        await requestWriter().count("todos", { where: { projectId: "p5" } });
    });

    bench("patch a row of a table with aggregate + rank indexes", async () => {
        await ready();
        await requestWriter().patch("todos", "t42", { score: clock % 997 });
    });

    bench("pinned patch, table without companions", async () => {
        await ready();
        await requestWriter().patch("notes", "n1", { body: String(clock) });
    });
});
