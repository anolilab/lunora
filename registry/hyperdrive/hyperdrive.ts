/**
 * Hyperdrive (Postgres/MySQL) — added by `lunora add hyperdrive`.
 *
 * Query an external Postgres or MySQL database from Lunora actions using
 * Cloudflare Hyperdrive. The HYPERDRIVE binding is added to wrangler.jsonc
 * by this item; provision the Hyperdrive database in the Cloudflare dashboard.
 *
 * Usage:
 *   import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
 *   import postgres from "postgres";
 *
 *   const { connectionString } = createHyperdrive(env.HYPERDRIVE);
 *   const sql = fromPostgresJs(postgres(connectionString));
 *   const rows = await sql`select id, name from users where org = ${orgId}`;
 *
 * Action-only (non-deterministic external I/O).
 */
import { env } from "cloudflare:workers";
import postgres from "postgres";

import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
import { action, v } from "#lunora/_generated/server.js";

/**
 * Query a users table by email. Demonstrates the `fromPostgresJs` adapter.
 * Swap to `fromNodePg` / `fromMysql2` for your driver of choice.
 */
export const queryUsers = action
    .input({ email: v.string().meta({ schema: { maxLength: 320 } }) })
    .action(async ({ args: { email } }) => {
        const { connectionString } = createHyperdrive(env.HYPERDRIVE);
        const sql = fromPostgresJs(postgres(connectionString));
        const rows = await sql`select id, name, email from users where email = ${email}`;

        return { users: rows as Array<{ email: string; id: string; name: string }> };
    });

/**
 * Run a raw SQL query.
 */
export const runQuery = action
    .input({ query: v.string().meta({ schema: { maxLength: 8192 } }), params: v.optional(v.array(v.any())) })
    .action(async ({ args: { query, params } }) => {
        const { connectionString } = createHyperdrive(env.HYPERDRIVE);
        const sql = fromPostgresJs(postgres(connectionString));
        const rows = await sql.unsafe(query, params as unknown[]);

        return { rows: rows as Array<Record<string, unknown>> };
    });
