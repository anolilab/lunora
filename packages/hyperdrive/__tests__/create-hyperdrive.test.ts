import mysql from "mysql2/promise";
import { Client, Pool } from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperdriveLike, Mysql2Like, NodePgLike, PostgresJsLike } from "../src";
import { createHyperdrive, fromMysql2, fromNodePg, fromPostgresJs } from "../src";
import type { MysqlHarness } from "./_helpers/mysql-mem";
import { tryCreateMysqlHarness } from "./_helpers/mysql-mem";
import type { PgliteWireHarness } from "./_helpers/pglite-wire";
import createPgliteWireHarness from "./_helpers/pglite-wire";

const fakeBinding = (): HyperdriveLike => {
    return {
        connectionString: "postgres://app:secret@hyperdrive.local:5432/appdb", // gitleaks:allow -- test fixture connection string, not a real secret
        database: "appdb",
        host: "hyperdrive.local",
        password: "secret",
        port: 5432,
        user: "app",
    };
};

describe("createHyperdrive", () => {
    it("passes the binding connection string through verbatim", () => {
        expect.assertions(1);

        const { connectionString } = createHyperdrive(fakeBinding());

        expect(connectionString).toBe("postgres://app:secret@hyperdrive.local:5432/appdb"); // gitleaks:allow -- test fixture connection string, not a real secret
    });

    it("lifts the discrete connection parts into config", () => {
        expect.assertions(1);

        const { config } = createHyperdrive(fakeBinding());

        expect(config).toStrictEqual({
            database: "appdb",
            host: "hyperdrive.local",
            password: "secret",
            port: 5432,
            user: "app",
        });
    });
});

describe("fromNodePg", () => {
    it("delegates to the driver's query and returns its rows", async () => {
        expect.assertions(3);

        const rows = [{ id: "1" }, { id: "2" }];
        const query = vi.fn<NodePgLike["query"]>().mockResolvedValue({ rows });
        const driver: NodePgLike = { query };

        const sql = fromNodePg(driver);
        const result = await sql.query<{ id: string }>("select id from t where org = $1", ["acme"]);

        expect(result).toBe(rows);
        expect(query).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith("select id from t where org = $1", ["acme"]);
    });

    it("defaults params to an empty array", async () => {
        expect.assertions(1);

        const query = vi.fn<NodePgLike["query"]>().mockResolvedValue({ rows: [] });

        await fromNodePg({ query }).query("select 1");

        expect(query).toHaveBeenCalledWith("select 1", []);
    });
});

describe("fromPostgresJs", () => {
    it("delegates to the driver's unsafe escape hatch and returns the rows", async () => {
        expect.assertions(2);

        const rows = [{ id: "x" }];
        const unsafe = vi.fn<PostgresJsLike["unsafe"]>().mockResolvedValue(rows);
        const driver: PostgresJsLike = { unsafe };

        const sql = fromPostgresJs(driver);
        const result = await sql.query("select id from t");

        expect(result).toBe(rows);
        expect(unsafe).toHaveBeenCalledWith("select id from t", []);
    });

    it("forwards explicit params positionally", async () => {
        expect.assertions(1);

        const unsafe = vi.fn<PostgresJsLike["unsafe"]>().mockResolvedValue([]);

        await fromPostgresJs({ unsafe }).query("select id from t where org = $1", ["acme"]);

        expect(unsafe).toHaveBeenCalledWith("select id from t where org = $1", ["acme"]);
    });
});

describe("fromMysql2", () => {
    it("returns the first element of the [rows, fields] tuple", async () => {
        expect.assertions(2);

        const rows = [{ id: 7 }];
        const execute = vi.fn<Mysql2Like["execute"]>().mockResolvedValue([rows, []]);
        const connection: Mysql2Like = { execute };

        const sql = fromMysql2(connection);
        const result = await sql.query<{ id: number }>("select id from t where org = ?", ["acme"]);

        expect(result).toBe(rows);
        expect(execute).toHaveBeenCalledWith("select id from t where org = ?", ["acme"]);
    });

    it("defaults params to an empty array", async () => {
        expect.assertions(1);

        const execute = vi.fn<Mysql2Like["execute"]>().mockResolvedValue([[], []]);

        await fromMysql2({ execute }).query("select 1");

        expect(execute).toHaveBeenCalledWith("select 1", []);
    });

    it("yields [] for a non-SELECT ResultSetHeader (DML)", async () => {
        expect.assertions(1);

        // mysql2 returns a ResultSetHeader object (not an array) for DML such as
        // INSERT/UPDATE/DELETE — the adapter must normalise it to [] to honour
        // the empty-array-for-non-SELECT contract.
        const header = { affectedRows: 1, fieldCount: 0, insertId: 42, warningStatus: 0 };
        const execute = vi.fn<Mysql2Like["execute"]>().mockResolvedValue([header, undefined]);

        const result = await fromMysql2({ execute }).query("insert into t (id) values (?)", [42]);

        expect(result).toStrictEqual([]);
    });
});

// Real-binding integration, CI-gated (real engines + wire servers are too slow
// for the local fast path).
//
// What this layer HONESTLY covers: an `env.HYPERDRIVE`-shaped binding
// (`HyperdriveLike` is exactly the structural surface workerd hands user code)
// consumed by `createHyperdrive`, whose `connectionString` / discrete `config`
// parts are dialled by the REAL `postgres` (postgres.js), `pg` (node-postgres)
// and `mysql2` drivers over real TCP sockets speaking the real Postgres/MySQL
// wire protocols to real engines (pglite / mysql-memory-server) — then rows and
// driver errors round-trip back through the fromPostgresJs / fromNodePg /
// fromMysql2 adapters. No mocks anywhere on the query path.
//
// What still only runs on real Cloudflare: workerd injecting the binding into
// `env`, and Hyperdrive's own edge proxy (pooling, caching, TLS to the origin
// DB). The binding here points at a local wire server instead of that proxy —
// the connection-string contract the package consumes is identical.
describe.skipIf(!process.env.CI)("real Hyperdrive binding (CI-only)", () => {
    const STARTUP_TIMEOUT = 180_000;
    const TEST_TIMEOUT = 30_000;

    describe("postgres — real drivers through env.HYPERDRIVE-shaped binding (pglite wire server)", () => {
        let harness: PgliteWireHarness;

        beforeAll(async () => {
            harness = await createPgliteWireHarness();

            // Seed through the in-process escape hatch; every driver below must
            // see these rows through the wire — proof they hit the same engine.
            await harness.query("CREATE TABLE todos (id text PRIMARY KEY, title text NOT NULL, seq int NOT NULL)");
            await harness.query("INSERT INTO todos (id, title, seq) VALUES ('t1', 'ship hyperdrive', 1), ('t2', 'write tests', 2)");
        }, STARTUP_TIMEOUT);

        afterAll(async () => {
            await harness?.close();
        });

        it(
            "postgres.js connects through the binding connectionString and round-trips a SELECT",
            async () => {
                expect.assertions(3);

                const { connectionString } = createHyperdrive(harness.binding);
                // max: 1 — the wire server multiplexes a single-connection engine.
                const driver = postgres(connectionString, { max: 1 });

                try {
                    // postgres.js's `unsafe` takes a narrower params type than the structural
                    // projection; the runtime shape is exactly PostgresJsLike.
                    const sql = fromPostgresJs(driver as unknown as PostgresJsLike);

                    await expect(sql.query("SELECT 1 + 1 AS sum")).resolves.toEqual([{ sum: 2 }]);
                    await expect(sql.query("SELECT title FROM todos WHERE id = $1", ["t1"])).resolves.toEqual([{ title: "ship hyperdrive" }]);
                    await expect(sql.query("SELECT id FROM missing_table")).rejects.toThrow(/relation "missing_table" does not exist/u);
                } finally {
                    await driver.end();
                }
            },
            TEST_TIMEOUT,
        );

        it(
            "node-postgres Client connects through the binding connectionString and round-trips a SELECT",
            async () => {
                expect.assertions(3);

                const { connectionString } = createHyperdrive(harness.binding);
                const client = new Client({ connectionString });

                await client.connect();

                try {
                    const sql = fromNodePg(client);

                    await expect(sql.query("SELECT 1 + 1 AS sum")).resolves.toEqual([{ sum: 2 }]);
                    await expect(sql.query("SELECT title FROM todos WHERE id = $1", ["t2"])).resolves.toEqual([{ title: "write tests" }]);
                    await expect(sql.query("SELECT id FROM missing_table")).rejects.toThrow(/relation "missing_table" does not exist/u);
                } finally {
                    await client.end();
                }
            },
            TEST_TIMEOUT,
        );

        it(
            "node-postgres Pool connects through the binding's discrete config parts and round-trips a SELECT",
            async () => {
                expect.assertions(3);

                // The other consumption form createHyperdrive surfaces: drivers
                // that prefer a config object over a DSN.
                const { config } = createHyperdrive(harness.binding);
                const pool = new Pool({ ...config, max: 1 });

                try {
                    const sql = fromNodePg(pool);

                    await expect(sql.query("SELECT 1 + 1 AS sum")).resolves.toEqual([{ sum: 2 }]);
                    await expect(sql.query("SELECT id FROM todos WHERE seq > $1 ORDER BY seq", [0])).resolves.toEqual([{ id: "t1" }, { id: "t2" }]);
                    await expect(sql.query("SELECT id FROM missing_table")).rejects.toThrow(/relation "missing_table" does not exist/u);
                } finally {
                    await pool.end();
                }
            },
            TEST_TIMEOUT,
        );
    });

    describe("mysql — real mysql2 driver through env.HYPERDRIVE-shaped binding (mysql-memory-server)", () => {
        let harness: MysqlHarness;
        let mysqlUnavailable: string | undefined;

        beforeAll(async () => {
            // mysql-memory-server downloads the MySQL binary on first use; in
            // sandboxes where that download is blocked (e.g. an egress proxy
            // answering 403) the leg skips with the reason instead of failing.
            const result = await tryCreateMysqlHarness();

            if (result.harness) {
                harness = result.harness;
            } else {
                mysqlUnavailable = result.unavailable;
            }
        }, STARTUP_TIMEOUT);

        beforeEach((context) => {
            if (mysqlUnavailable !== undefined) {
                context.skip(mysqlUnavailable);
            }
        });

        afterAll(async () => {
            await harness?.close();
        });

        it(
            "mysql2 connects through the binding's discrete config parts and round-trips a SELECT",
            async () => {
                expect.assertions(3);

                const binding: HyperdriveLike = {
                    connectionString: `mysql://${harness.connection.user}@${harness.connection.host}:${String(harness.connection.port)}/${harness.connection.database}`,
                    database: harness.connection.database,
                    host: harness.connection.host,
                    password: "",
                    port: harness.connection.port,
                    user: harness.connection.user,
                };
                const { config } = createHyperdrive(binding);
                const connection = await mysql.createConnection({
                    database: config.database,
                    host: config.host,
                    password: config.password,
                    port: config.port,
                    user: config.user,
                });

                try {
                    await connection.query("CREATE TABLE hyperdrive_roundtrip (id VARCHAR(16) PRIMARY KEY, title TEXT NOT NULL)");
                    await connection.query("INSERT INTO hyperdrive_roundtrip (id, title) VALUES ('m1', 'ship hyperdrive')");

                    // mysql2's overloaded `execute` doesn't structurally match the
                    // projection, but the runtime shape is exactly Mysql2Like.
                    const sql = fromMysql2(connection as unknown as Mysql2Like);

                    await expect(sql.query("SELECT 1 + 1 AS sum")).resolves.toEqual([{ sum: 2 }]);
                    await expect(sql.query("SELECT title FROM hyperdrive_roundtrip WHERE id = ?", ["m1"])).resolves.toEqual([{ title: "ship hyperdrive" }]);
                    await expect(sql.query("SELECT id FROM missing_table")).rejects.toThrow(/missing_table/u);
                } finally {
                    await connection.end();
                }
            },
            TEST_TIMEOUT,
        );
    });
});
