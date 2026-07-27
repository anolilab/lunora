/**
 * Driver loading for `lunora introspect`.
 *
 * `pg` and `mysql2` are NOT dependencies of the CLI — they're heavy, and the vast
 * majority of Lunora projects never introspect anything. They're loaded on demand
 * and a missing one produces an install instruction rather than a stack trace.
 * This mirrors how `@lunora/hyperdrive` treats the same two drivers (optional
 * peer dependencies).
 */
import { createRequire } from "node:module";

import { LunoraError } from "@lunora/errors";
import { join } from "@visulima/path";

import type { SqlDialect } from "./model";
import type { SqlExecutor } from "./read-database";

/** An open read-only connection to the source database. */
interface Connection {
    readonly close: () => Promise<void>;
    readonly execute: SqlExecutor;
    /** Postgres schema name, or MySQL database name — whichever scopes `information_schema`. */
    readonly schema: string;
}

/** Minimal structural view of `pg`'s `Client`, so the CLI needs no `@types/pg`. */
interface PgClientLike {
    connect: () => Promise<void>;
    end: () => Promise<void>;
    query: (sql: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** Minimal structural view of a `mysql2/promise` connection. */
interface MysqlConnectionLike {
    end: () => Promise<void>;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
}

/** Leading slash of a URL pathname, stripped to recover the bare database name. */
const LEADING_SLASH = /^\//;

/**
 * Load an optional driver by name, resolved from the USER'S project rather than
 * the CLI's own `node_modules` — `pg` / `mysql2` are things they install, and the
 * CLI is frequently run through a global binary that could never see them.
 *
 * `createRequire` rather than `import(specifier)`: a dynamic import with a
 * variable specifier can't be statically analyzed, so the bundler rejects it at
 * build time. This is the same escape hatch `@lunora/config` and `@lunora/codegen`
 * use to reach into a host project at runtime. A missing driver becomes an
 * install instruction instead of a module-resolution stack trace.
 */
const loadDriver = (specifier: string, install: string, cwd: string): Record<string, unknown> => {
    try {
        // `noop.cjs` is never read — it only anchors resolution at the project root.
        const projectRequire = createRequire(join(cwd, "noop.cjs"));

        return projectRequire(specifier) as Record<string, unknown>;
    } catch {
        throw new LunoraError(
            "INTERNAL",
            `\`lunora introspect\` needs the \`${install}\` driver to read this database, and it isn't installed.\n\nInstall it in your project:\n\n    pnpm add -D ${install}`,
        );
    }
};

/** Infer the dialect from a connection-string scheme. */
const dialectFromUrl = (url: string): SqlDialect => {
    const scheme = url.slice(0, Math.max(0, url.indexOf(":"))).toLowerCase();

    if (scheme === "postgres" || scheme === "postgresql") {
        return "postgres";
    }

    if (scheme === "mysql" || scheme === "mariadb") {
        return "mysql";
    }

    throw new LunoraError(
        "INTERNAL",
        `Unrecognised database URL scheme \`${scheme}\`. Expected a \`postgres://\`, \`postgresql://\`, \`mysql://\`, or \`mariadb://\` connection string.`,
    );
};

/** The database name embedded in a connection string's path, if any. */
const databaseFromUrl = (url: string): string | undefined => {
    try {
        const path = new URL(url).pathname.replace(LEADING_SLASH, "");

        return path === "" ? undefined : decodeURIComponent(path);
    } catch {
        return undefined;
    }
};

/** Open a read-only connection using whichever driver the dialect needs. */
const connect = async (url: string, dialect: SqlDialect, schemaOverride?: string, cwd: string = process.cwd()): Promise<Connection> => {
    if (dialect === "postgres") {
        const driver = loadDriver("pg", "pg", cwd);
        const ClientConstructor = driver.Client as new (config: { connectionString: string }) => PgClientLike;
        const client = new ClientConstructor({ connectionString: url });

        await client.connect();

        return {
            close: async () => {
                await client.end();
            },
            execute: async (sql, parameters) => {
                const result = await client.query(sql, [...parameters]);

                return result.rows;
            },
            schema: schemaOverride ?? "public",
        };
    }

    const driver = loadDriver("mysql2/promise", "mysql2", cwd);
    const createConnection = driver.createConnection as (config: string) => Promise<MysqlConnectionLike>;
    const connection = await createConnection(url);
    const database = schemaOverride ?? databaseFromUrl(url);

    if (database === undefined) {
        throw new LunoraError("INTERNAL", "A MySQL connection string must name a database (`mysql://host/<database>`), or pass `--schema`.");
    }

    return {
        close: async () => { await connection.end(); },
        execute: async (sql, parameters) => {
            const [rows] = await connection.execute(sql, [...parameters]);

            return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
        },
        schema: database,
    };
};

export type { Connection };
export { connect, databaseFromUrl, dialectFromUrl, loadDriver };
