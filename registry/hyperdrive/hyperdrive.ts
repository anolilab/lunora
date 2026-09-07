/**
 * Hyperdrive (Postgres/MySQL) — added by `lunora registry add hyperdrive`.
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
 *   const rows = await sql.query("select id, name from users where org = $1", [orgId]);
 *
 * `fromPostgresJs` / `fromNodePg` / `fromMysql2` all return a `SqlClient`, whose
 * ONLY method is `query(text, params)` — it is not a tagged template. Values go
 * in `params` behind positional placeholders (`$1`/`$2` for Postgres, `?` for
 * MySQL); the package never rewrites or escapes `text`.
 *
 * **There is deliberately no `runQuery(sql)` here.** A public — or even an
 * authenticated — endpoint that executes a caller-supplied statement against
 * your production database is a remote SQL console: `DROP TABLE`, a full-table
 * `SELECT`, `pg_read_file()`. Authentication does not contain it, because the
 * statement itself is the payload and any handler that forwards a client string
 * into it reopens the hole. Write purpose-specific, parameterised statements
 * instead — {@link queryUsers} is the shape to copy. Identifiers (table/column
 * names) cannot be parameterised at all: allowlist them against a fixed set.
 *
 * **This is an `internalAction`, not public RPC, on purpose** — same reasoning as
 * the `mail` item. Lunora `action`s are public RPC, so exposing a database read
 * directly makes it callable by any anonymous client: `queryUsers` as a public
 * action is an email → identity oracle that confirms whether an address has an
 * account and hands back its id and name. Call it from your own
 * `mutation`/`action` handlers (`ctx.runAction(internal.hyperdrive.queryUsers, …)`)
 * AFTER you have authenticated the caller and decided what they may read. If you
 * genuinely need a client-callable read, write a *purpose-specific* `action` that
 * takes only safe business inputs, checks `ctx.auth`/RBAC, scopes the statement
 * to the caller server-side, and rate-limits it (`@lunora/ratelimit`).
 *
 * Action-only (non-deterministic external I/O).
 */
import { env } from "cloudflare:workers";
import postgres from "postgres";

import type { HyperdriveLike, SqlClient } from "@lunora/hyperdrive";
import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
import { internalAction, v } from "#lunora/_generated/server.js";

/**
 * Build the driver-agnostic `SqlClient` for this request. Swap `fromPostgresJs`
 * for `fromNodePg` / `fromMysql2` (and the matching driver import) to change
 * drivers — the `SqlClient` surface is identical.
 *
 * `cloudflare:workers`' `env` values are typed `unknown`, so the binding is
 * narrowed here and fails with a clear message when it is missing rather than
 * throwing somewhere inside the driver.
 */
const connect = (): SqlClient => {
    const binding = env["HYPERDRIVE"] as HyperdriveLike | undefined;

    if (!binding) {
        throw new Error("@lunora/hyperdrive registry item: missing `HYPERDRIVE` binding — add it to wrangler.jsonc (see the README).");
    }

    const { connectionString } = createHyperdrive(binding);

    return fromPostgresJs(postgres(connectionString));
};

/**
 * Look a user up by email in the external database. Server-only (see the file
 * header): call it from an authenticated handler that has already decided the
 * caller may see this row.
 *
 * Note the shape to copy: fixed SQL text, every value bound positionally.
 */
export const queryUsers = internalAction.input({ email: v.string().max(320) }).action(async ({ args: { email } }) => {
    const rows = await connect().query<{ email: string; id: string; name: string }>("select id, name, email from users where email = $1", [email]);

    return { users: rows };
});
