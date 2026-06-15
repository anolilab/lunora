import { describe, expect, it, vi } from "vitest";

import type { HyperdriveLike, Mysql2Like, NodePgLike, PostgresJsLike } from "../src";
import { createHyperdrive, fromMysql2, fromNodePg, fromPostgresJs } from "../src";

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
});

// Real-binding integration (workerd + a live Hyperdrive proxy) can't run in the
// sandbox — localhost loopback to workerd is blocked. Gate it on CI so it stays
// out of the local fast path. See MEMORY.md "workerd can't run in sandbox".
describe.skipIf(!process.env.CI)("real Hyperdrive binding (CI-only)", () => {
    it.todo("connects through env.HYPERDRIVE and round-trips a SELECT");
});
