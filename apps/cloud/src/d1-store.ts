/**
 * The control-plane D1, opened as the `.global()` ctx-db, for code that runs
 * outside a Lunora function: the scheduled sweeps (`src/server.ts`) and the
 * per-box session Durable Object (`src/boxes/session-do.ts`). Both run in a
 * trusted system context with the `DB` binding in hand, so they read and write
 * the tables directly — the same posture as every sweep.
 */
import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@lunora/d1";
import { createD1CtxDb } from "@lunora/d1";

import schema from "../lunora/schema.js";
import type { ControlPlaneDatabase } from "./store";

/** A {@link ControlPlaneDatabase} that can also read one row by id — what the real ctx-db offers. */
export type ControlPlaneStore = ControlPlaneDatabase & {
    get: (id: string, table?: string) => Promise<unknown>;
};

/** Adapt the raw D1 binding to `@lunora/d1`'s `D1Exec`. */
export const buildExec = (database: D1DatabaseLike): D1Exec => {
    return {
        all: async (sql, parameters) => {
            const result = await database
                .prepare(sql)
                .bind(...parameters)
                .all<Record<string, unknown>>();

            return result.results;
        },
        run: async (sql, parameters) => {
            await database
                .prepare(sql)
                .bind(...parameters)
                .run();
        },
    };
};

/** The control-plane D1 as the structural store the sweeps and the box sessions use. */
export const controlPlaneDatabase = (database: D1DatabaseLike): ControlPlaneStore =>
    createD1CtxDb({ exec: buildExec(database), schema: schema as unknown as D1CtxDbOptions["schema"] });
