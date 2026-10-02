import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import type { DatabaseTally } from "../src/database-telemetry";
import { createDatabaseTally, formatTally, instrumentSqlClient, sqlOperationName } from "../src/database-telemetry";

/**
 * Automatic `ctx.sql` (Hyperdrive) instrumentation — the `ctx.db` tiering, cap
 * and settle reused for an external Postgres/MySQL client. What is specific to
 * this surface and worth pinning: its own `sql.*` tally, the real
 * `db.system.name`, the leading-keyword-only operation, and that neither the
 * statement text, its parameters, nor (in production) the driver's error
 * message ever reach a span.
 */

const deps = (mode: "off" | "spans" | "summary", tally: DatabaseTally, record: (span: SpanEvent) => void, captureRaw?: boolean) => {
    return {
        anchor: { rootSpanId: "b7ad6b7169203331", traceId: "0af7651916cd43dd8448eb211c80319c" },
        ...(captureRaw === undefined ? {} : { captureRaw }),
        functionPath: "orders:sync",
        mode,
        record,
        shardKey: "tenant-1",
        tally,
        userId: () => "u-1",
    };
};

/** A `SqlClient` stand-in as the hyperdrive adapters build it. */
const fakeClient = (dbSystem?: "mysql" | "postgresql") => {
    return {
        ...(dbSystem === undefined ? {} : { dbSystem }),
        query: vi.fn<(text: string, params?: ReadonlyArray<unknown>) => Promise<unknown[]>>(async () => [{ id: 1 }, { id: 2 }]),
    };
};

const collect = (): { record: (span: SpanEvent) => void; spans: SpanEvent[] } => {
    const spans: SpanEvent[] = [];

    return {
        record: (span) => {
            spans.push(span);
        },
        spans,
    };
};

describe(sqlOperationName, () => {
    it.each([
        ["select * from orders where id = $1", "SELECT"],
        ["  INSERT INTO orders (id) VALUES ($1)", "INSERT"],
        ["\n\tupdate orders set total = 1", "UPDATE"],
        ["DELETE FROM orders", "DELETE"],
        ["-- fetch the slice\nSELECT 1", "SELECT"],
        ["/* drizzle */ select 1", "SELECT"],
        ["/* a */ -- b\n /* c */ (SELECT 1) UNION (SELECT 2)", "SELECT"],
        ["with recent as (select 1) select * from recent", "WITH"],
        ["begin", "BEGIN"],
        ["", "OTHER"],
        ["   ", "OTHER"],
        ["-- unterminated comment", "OTHER"],
        ["/* unterminated", "OTHER"],
        ["frobnicate the table", "OTHER"],
        ["SELECTED", "OTHER"],
        ["'; DROP TABLE users; --", "OTHER"],
    ])("reads %j as %s", (text, expected) => {
        expect.assertions(1);

        expect(sqlOperationName(text)).toBe(expected);
    });

    it("reports a non-string statement as OTHER", () => {
        expect.assertions(1);

        expect(sqlOperationName(42)).toBe("OTHER");
    });
});

describe(instrumentSqlClient, () => {
    it("returns the client untouched when off", () => {
        expect.assertions(1);

        const client = fakeClient("postgresql");

        expect(
            instrumentSqlClient(
                client,
                deps("off", createDatabaseTally(), () => undefined),
            ),
        ).toBe(client);
    });

    it("folds sql.* counters in summary mode and emits no spans", async () => {
        expect.assertions(5);

        const client = fakeClient("postgresql");
        const tally = createDatabaseTally();
        const { record, spans } = collect();
        const instrumented = instrumentSqlClient(client, deps("summary", tally, record));

        await instrumented.query("select id from orders where org = $1", ["acme"]);
        await instrumented.query("select 1");
        await instrumented.query("insert into orders (id) values ($1)", ["o-1"]);

        const fields = formatTally(tally, "sql");

        expect(fields["sql.calls"]).toBe(3);
        expect(fields["sql.op.SELECT"]).toBe(2);
        expect(fields["sql.op.INSERT"]).toBe(1);
        // Its own namespace — never folded into ctx.db's counters.
        expect(Object.keys(fields).some((key) => key.startsWith("db."))).toBe(false);
        expect(spans).toHaveLength(0);
    });

    it("passes the statement and params through and returns the driver's rows", async () => {
        expect.assertions(2);

        const client = fakeClient("postgresql");
        const instrumented = instrumentSqlClient(
            client,
            deps("spans", createDatabaseTally(), () => undefined),
        );

        await expect(instrumented.query("select id from orders where org = $1", ["acme"])).resolves.toStrictEqual([{ id: 1 }, { id: 2 }]);

        expect(client.query).toHaveBeenCalledWith("select id from orders where org = $1", ["acme"]);
    });

    it("emits a CLIENT span with OTel db.* attributes and no statement text or params", async () => {
        expect.assertions(5);

        const client = fakeClient("postgresql");
        const { record, spans } = collect();
        const instrumented = instrumentSqlClient(client, deps("spans", createDatabaseTally(), record));

        await instrumented.query("select email from users where email = $1", ["secret@example.com"]);

        expect(spans).toHaveLength(1);
        expect(spans[0]?.kind).toBe("client");
        expect(spans[0]?.name).toBe("sql.SELECT");
        expect(spans[0]?.attributes).toStrictEqual({
            "db.operation.name": "SELECT",
            "db.response.returned_rows": 2,
            "db.system.name": "postgresql",
        });
        // Neither the statement nor a bound value lands anywhere on the span.
        expect(JSON.stringify(spans[0])).not.toMatch(/users|secret@example\.com|\$1/u);
    });

    it.each([
        ["postgresql" as const, "postgresql"],
        ["mysql" as const, "mysql"],
        [undefined, "other_sql"],
    ])("reports db.system.name for an adapter stamped %s as %s", async (dbSystem, expected) => {
        expect.assertions(1);

        const { record, spans } = collect();
        const instrumented = instrumentSqlClient(fakeClient(dbSystem), deps("spans", createDatabaseTally(), record));

        await instrumented.query("select 1");

        expect(spans[0]?.attributes?.["db.system.name"]).toBe(expected);
    });

    it("omits returned_rows when the driver resolves to something that is not a row array", async () => {
        expect.assertions(1);

        const client = {
            query: async (_text: string): Promise<unknown> => {
                return { affectedRows: 1 };
            },
        };
        const { record, spans } = collect();

        await instrumentSqlClient(client, deps("spans", createDatabaseTally(), record)).query("update t set a = 1");

        expect(spans[0]?.attributes).not.toHaveProperty("db.response.returned_rows");
    });

    it("caps spans per ctx and reports sql.spans_truncated, while every call still counts", async () => {
        expect.assertions(3);

        const tally = createDatabaseTally();
        const { record, spans } = collect();
        const instrumented = instrumentSqlClient(fakeClient("mysql"), deps("spans", tally, record));

        for (let index = 0; index < 120; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose: the cap is about cumulative count, not concurrency
            await instrumented.query("select 1");
        }

        expect(spans).toHaveLength(100);
        expect(formatTally(tally, "sql")["sql.calls"]).toBe(120);
        expect(formatTally(tally, "sql")["sql.spans_truncated"]).toBe(true);
    });

    it("records the error TYPE, never the driver's message, and re-throws untouched", async () => {
        expect.assertions(5);

        const client = fakeClient("postgresql");

        class PostgresError extends Error {}

        client.query.mockRejectedValueOnce(new PostgresError('duplicate key value violates unique constraint "users_email_key": Key (email)=(a@b.co)'));

        const tally = createDatabaseTally();
        const { record, spans } = collect();
        const instrumented = instrumentSqlClient(client, deps("spans", tally, record));

        await expect(instrumented.query("insert into users (email) values ($1)", ["a@b.co"])).rejects.toBeInstanceOf(PostgresError);

        expect(spans[0]?.ok).toBe(false);
        expect(spans[0]?.error).toStrictEqual({ message: "PostgresError", type: "PostgresError" });
        expect(formatTally(tally, "sql")["sql.errors"]).toBe(1);
        expect(formatTally(tally, "sql")["sql.calls"]).toBe(1);
    });

    it("uses the LunoraError code as error.type", async () => {
        expect.assertions(2);

        const client = fakeClient("postgresql");

        client.query.mockRejectedValueOnce(new LunoraError("FORBIDDEN", "row 42 is gone"));

        const { record, spans } = collect();

        await expect(instrumentSqlClient(client, deps("spans", createDatabaseTally(), record)).query("select 1")).rejects.toThrow("row 42 is gone");

        expect(spans[0]?.error?.type).toBe("FORBIDDEN");
    });

    it("keeps the driver's message when captureRaw is true (the dev escape hatch)", async () => {
        expect.assertions(2);

        const client = fakeClient("postgresql");

        client.query.mockRejectedValueOnce(new Error('relation "orderz" does not exist'));

        const { record, spans } = collect();

        await expect(instrumentSqlClient(client, deps("spans", createDatabaseTally(), record, true)).query("select * from orderz")).rejects.toThrow(
            "does not exist",
        );

        expect(spans[0]?.error?.message).toBe('relation "orderz" does not exist');
    });

    it("keeps a stable query identity and passes other members through", () => {
        expect.assertions(2);

        const client = { ...fakeClient("postgresql"), label: "primary" };
        const instrumented = instrumentSqlClient(
            client,
            deps("spans", createDatabaseTally(), () => undefined),
        );

        expect(instrumented.query).toBe(instrumented.query);
        expect(instrumented.label).toBe("primary");
    });

    it("never fails a succeeded query when the span sink throws", async () => {
        expect.assertions(1);

        const instrumented = instrumentSqlClient(
            fakeClient("postgresql"),
            deps("spans", createDatabaseTally(), () => {
                throw new Error("sink down");
            }),
        );

        await expect(instrumented.query("select 1")).resolves.toHaveLength(2);
    });
});
