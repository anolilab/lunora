/**
 * The control-plane D1, opened as the `.global()` ctx-db, for code that runs
 * outside a Lunora function: the scheduled sweeps (`src/server.ts`) and the
 * per-box session Durable Object (`src/boxes/session-do.ts`). Both run in a
 * trusted system context with the `DB` binding in hand, so they read and write
 * the tables directly — the same posture as every sweep.
 */
import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@lunora/d1";
import { createD1CtxDb } from "@lunora/d1";

import schema from "../lunora/schema";
import type { ControlPlaneDatabase } from "./store";

/** A {@link ControlPlaneDatabase} that can also read one row by id and patch it conditionally — what the real ctx-db offers. */
export type ControlPlaneStore = ControlPlaneDatabase & {
    get: (table: string, id: string) => Promise<unknown>;
    /** Patch the row only while it matches `where`, decided in one statement: a compare-and-set against a concurrent writer. */
    patchIf: (table: string, id: string, args: { patch: Record<string, unknown>; where: Record<string, unknown> }) => Promise<{ applied: boolean }>;
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
export const controlPlaneDatabase = (database: D1DatabaseLike): ControlPlaneStore => {
    const store = createD1CtxDb({ exec: buildExec(database), schema: schema as unknown as D1CtxDbOptions["schema"] });
    // Optional on the shared writer type (not every ctx-db offers it); the SQL store always does.
    const { patchIf } = store;

    if (patchIf === undefined) {
        throw new Error("the D1 ctx-db offers no patchIf");
    }

    return Object.assign(store, { patchIf });
};
