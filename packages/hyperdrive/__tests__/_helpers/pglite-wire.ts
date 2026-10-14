import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import type { HyperdriveLike } from "../../src/types";

/**
 * Boots [`@electric-sql/pglite`](https://pglite.dev) — a real, embedded
 * Postgres engine — behind [`@electric-sql/pglite-socket`](https://pglite.dev/docs/pglite-socket),
 * which serves the genuine Postgres **wire protocol** on a loopback TCP port.
 *
 * That lets the real `pg` (node-postgres) and `postgres` (postgres.js) drivers
 * dial the `connectionString` exactly the way they would dial a Cloudflare
 * Hyperdrive proxy, so the `createHyperdrive` → driver → `fromNodePg` /
 * `fromPostgresJs` round-trip is exercised over an actual socket against an
 * actual engine — no mocks anywhere on the path.
 *
 * The surfaced {@link HyperdriveLike} mirrors how workerd presents
 * `env.HYPERDRIVE` to user code (a `connectionString` plus the discrete
 * connection parts); only the host behind it differs (a local wire server
 * instead of Hyperdrive's edge proxy). PGlite authenticates as "trust", so the
 * carried credentials are accepted verbatim.
 */
interface PgliteWireHarness {
    /** An `env.HYPERDRIVE`-shaped binding double pointing at the local wire server. */
    binding: HyperdriveLike;
    /** Stop the socket server and close the embedded database. */
    close: () => Promise<void>;
    /** Raw in-process escape hatch for seeding + assertions on the physical rows. */
    query: (sql: string, parameters?: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
}

const createPgliteWireHarness = async (): Promise<PgliteWireHarness> => {
    const database = new PGlite();

    await database.waitReady;

    // port 0 → the OS picks a free ephemeral port; read it back from the server.
    const server = new PGLiteSocketServer({ db: database, host: "127.0.0.1", maxConnections: 4, port: 0 });

    await server.start();

    const [host = "127.0.0.1", portString = "5432"] = server.getServerConn().split(":");
    const port = Number(portString);

    return {
        binding: {
            connectionString: `postgres://postgres:postgres@${host}:${portString}/postgres`, // gitleaks:allow -- ephemeral local test server, not a real secret
            database: "postgres",
            host,
            password: "postgres", // gitleaks:allow -- PGlite is auth-less ("trust"); any credentials are accepted
            port,
            user: "postgres",
        },
        close: async () => {
            await server.stop();
            await database.close();
        },
        query: async (sql, parameters = []) => {
            const result = await database.query(sql, parameters as unknown[]);

            return result.rows as Record<string, unknown>[];
        },
    };
};

export type { PgliteWireHarness };
export default createPgliteWireHarness;
