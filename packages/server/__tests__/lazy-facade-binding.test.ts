/**
 * rls()/mask() re-bind table facades over the wrapped writer on first access,
 * not for every schema table on every guarded call.
 */
import { describe, expect, it } from "vitest";

import type { FacadeWriterLike } from "../src/facade";
import { bindTableFacade } from "../src/facade";
import type { Middleware } from "../src/index";
import { definePolicy, initLunora, mask, rls } from "../src/index";

const lunora = initLunora.dataModel<Record<string, never>>().create();
const TABLES = Array.from({ length: 60 }, (_, index) => `table${String(index)}`);

interface Call {
    args: unknown;
    table: string;
}

const makeCtx = (): { calls: Call[]; ctx: Record<string, unknown> } => {
    const calls: Call[] = [];
    const writer = {
        findMany: async (table: string, args?: unknown) => {
            calls.push({ args, table });

            return { continueCursor: null, isDone: true, page: [] };
        },
    } as unknown as Record<string, unknown>;

    for (const table of TABLES) {
        writer[table] = bindTableFacade(writer as unknown as FacadeWriterLike, table);
    }

    return { calls, ctx: { auth: { userId: "u1" }, db: writer } };
};

const guards: [string, Middleware<any, any>][] = [
    [
        "rls",
        (rls as any)([
            definePolicy({
                on: "read",
                table: "table0",
                when: () => {
                    return { ownerId: "u1" };
                },
            }),
        ]),
    ],
    ["mask", (mask as any)({ table0: { secret: "redact" } })],
];

describe.each(guards)("%s lazy facade binding", (name, middleware) => {
    const capture = async (): Promise<{ calls: Call[]; db: Record<string, any> }> => {
        const { calls, ctx } = makeCtx();
        let db: Record<string, any> = {};

        await lunora.query
            .use(middleware)
            .query(async ({ ctx: inner }) => {
                db = inner.db;

                return null;
            })
            .handler(ctx, {});

        return { calls, db };
    };

    it("defers binding: untouched tables stay getters, a read swaps in a stable value", async () => {
        expect.assertions(4);

        const { db } = await capture();

        expect(typeof Object.getOwnPropertyDescriptor(db, "table5")?.get).toBe("function");

        const first = db["table5"];

        expect(Object.getOwnPropertyDescriptor(db, "table5")).toHaveProperty("value");
        expect(db["table5"]).toBe(first);
        expect(typeof Object.getOwnPropertyDescriptor(db, "table6")?.get).toBe("function");
    });

    it("keeps every table key enumerable and a spread binds them all", async () => {
        expect.assertions(3);

        const { db } = await capture();

        expect(TABLES.every((table) => Object.keys(db).includes(table))).toBe(true);

        const copy = { ...db };

        expect(typeof copy["table59"].findMany).toBe("function");
        expect(Object.getOwnPropertyDescriptor(db, "table59")).toHaveProperty("value");
    });

    it("routes a lazily bound facade through the guard", async () => {
        expect.assertions(1);

        const { calls, db } = await capture();

        await db["table0"].findMany({});

        // rls injects baseWhere; mask rewrites the call too. Either way the guard saw it.
        expect(name === "rls" ? JSON.stringify(calls[0]?.args) : calls[0]?.table).toContain(name === "rls" ? "u1" : "table0");
    });
});
