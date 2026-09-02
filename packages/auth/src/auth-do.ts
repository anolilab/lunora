/**
 * better-auth hosted inside a Durable Object, on the object's own SQLite.
 *
 * ## What this is for
 *
 * `@better-auth/scim` refuses to serve unless its adapter exposes native
 * transactions, and D1 has none — so directory provisioning on Cloudflare either
 * moves the auth tables to Postgres/MySQL via `@lunora/hyperdrive`, or moves them
 * into a Durable Object, whose `state.storage.transaction(closure)` is a real
 * transaction. This class is the second option, packaged.
 *
 * ## Why the whole instance lives in here
 *
 * DO storage is only reachable from inside the object. A worker cannot read it the
 * way it reads a D1 binding, so better-auth itself has to run in here and the
 * worker forwards `/api/auth/*` to a stub. That is the one structural difference
 * from the D1 mode, and it is what makes the internal session route necessary: the
 * worker's `resolveIdentity` cannot call `auth.api.getSession` locally any more, so
 * it asks the object.
 *
 * ## The trade
 *
 * The auth tables live inside **one** object. Writes serialise through it, and
 * backup/export follows the DO path rather than D1's. For the session read on the
 * hot path, enable better-auth's `session.cookieCache` so most requests are served
 * from the signed cookie instead of a round-trip in here — at the cost of a
 * staleness window on revocation, which is the trade to make deliberately.
 * @experimental
 */
import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { lunoraDoAdapter } from "./adapter";
import type { AuthAuditEntry, ReadAuthAuditOptions } from "./audit";
import { createAuthAuditReader, ensureAuthAuditTable } from "./audit";
import type { LunoraAuth, LunoraAuthOptions } from "./create-auth";
import { createAuth, resolveAuthOptions } from "./create-auth";
import { authDoColumnAdditions, authDoSchemaStatements } from "./do-schema";
import type { DoStorageLike } from "./do-store";
import { doExecutor } from "./do-store";
import { handleAuthRequest } from "./handler";

/**
 * The Durable Object state slice this class needs — structural so unit tests can
 * pass a double without depending on the workers runtime.
 */
interface AuthDoState {
    storage: DoStorageLike;
}

/** Path the worker calls to resolve a request's identity. Not part of `/api/auth/*`. */
const RESOLVE_SESSION_PATH = "/__lunora/auth/session";

/**
 * Path the worker calls to read the audit log. Also not part of `/api/auth/*`.
 *
 * The audit table lives in this object like every other auth table, so the worker
 * cannot query it directly — same constraint as the session route, same shared secret.
 */
const READ_AUDIT_PATH = "/__lunora/auth/audit";

/** Header carrying the shared secret that authenticates the calling worker. */
const INTERNAL_SECRET_HEADER = "x-lunora-auth-do-secret";

/**
 * Narrow an already-JSON-parsed request body into {@link ReadAuthAuditOptions},
 * or an error message for the first field that fails validation. Guards the
 * one boundary `readAuthAuditLog` itself does not (it trusts its caller):
 * before this, a non-numeric `limit` reached `Math.min`/`Math.max` as `NaN`
 * and was bound as the SQL `LIMIT` parameter, and a malformed body threw an
 * unhandled exception out of `#readAudit` (a 500) instead of a 400. Only the
 * four fields `readAuthAuditLog` reads are accepted; anything else — an
 * unknown key or an ill-typed value — is rejected rather than silently
 * ignored, since a caller sending garbage deserves a 400, not a request that
 * quietly did something other than what was asked.
 */
const parseReadAuditOptions = (parsed: unknown): { error: string } | { options: ReadAuthAuditOptions } => {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "body must be a JSON object" };
    }

    const options: ReadAuthAuditOptions = {};

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key === "limit" || key === "sinceSeq") {
            if (typeof value !== "number" || !Number.isFinite(value)) {
                return { error: `"${key}" must be a finite number` };
            }

            options[key] = value;
        } else if (key === "actorId" || key === "event") {
            if (typeof value !== "string") {
                return { error: `"${key}" must be a string` };
            }

            options[key] = value;
        } else {
            return { error: `unknown audit read option "${key}"` };
        }
    }

    return { options };
};

/**
 * Options for the auth DO, beyond the better-auth options themselves.
 * @experimental
 */
interface AuthDoOptions {
    /** Base path the auth routes are served under. Must match the worker's. */
    basePath?: string;

    /**
     * Shared secret authenticating the worker on {@link RESOLVE_SESSION_PATH}.
     *
     * The DO binding is reachable from any worker bound to the namespace, so the
     * binding alone is not an authorization boundary — same reasoning as
     * `SessionDO`'s `SESSION_DO_SECRET`. When this is unset the internal route is
     * refused outright rather than served unauthenticated: a missing secret is a
     * misconfiguration, and answering identity questions to anyone is the one
     * failure mode worth being loud about. `/api/auth/*` is unaffected — those
     * routes carry their own credentials.
     */
    internalSecret?: string;
}

/**
 * Base class for an app's auth Durable Object. Subclass it (or let codegen emit the
 * subclass) and register the subclass in `wrangler.jsonc`.
 *
 * ```ts
 * export class AuthDO extends LunoraAuthDO {
 *     public constructor(state: DurableObjectState, env: Env) {
 *         super(state, () => ({ secret: env.AUTH_SECRET, plugins: [scim({ … })] }), {
 *             internalSecret: env.AUTH_DO_SECRET,
 *         });
 *     }
 * }
 * ```
 * @experimental
 */
class LunoraAuthDO {
    readonly #options: AuthDoOptions;

    readonly #optionsFactory: () => LunoraAuthOptions;

    readonly #storage: DoStorageLike;

    #auth: LunoraAuth | undefined;

    #schemaApplied = false;

    /**
     * @param state The Durable Object state — its `storage` becomes better-auth's database.
     * @param optionsFactory Builds the better-auth options. Called once, lazily, on the first request.
     * @param options Auth-DO specific options (base path, internal secret).
     */
    public constructor(state: AuthDoState, optionsFactory: () => LunoraAuthOptions, options: AuthDoOptions = {}) {
        this.#storage = state.storage;
        this.#optionsFactory = optionsFactory;
        this.#options = options;
    }

    /**
     * Build the auth instance and materialise its schema, once.
     *
     * Both are lazy rather than constructor-time: a DO constructor runs on every
     * cold start, including for requests that never touch auth, and
     * `optionsFactory` may read `env` values that are only meaningful per request.
     */
    #ensureReady(): LunoraAuth {
        if (this.#auth !== undefined) {
            return this.#auth;
        }

        const options = this.#optionsFactory();

        if (!this.#schemaApplied) {
            // better-auth's migrator is kysely-only and this storage is not a kysely
            // dialect, so the schema is derived from better-auth's own resolved
            // tables instead. Every statement is IF NOT EXISTS.
            //
            // Through `resolveAuthOptions`, for the same reason the D1 migration path
            // does: `createAuth` defaults rate limiting to `storage: "database"`, and
            // that table only appears in `getAuthTables` once the option is set. Deriving
            // from the raw options would omit it and the limiter's first read would fail
            // on a missing table.
            const resolved = resolveAuthOptions(options);

            for (const statement of authDoSchemaStatements(resolved)) {
                // The cursor is lazy in workerd — iterating is what runs the statement.
                [...this.#storage.sql.exec(statement)];
            }

            // `CREATE TABLE IF NOT EXISTS` covers a table that did not exist; it says
            // nothing about a table that exists with FEWER columns than the current
            // plugin set needs. Adding `admin()` to a deployed app is exactly that
            // case (`role` / `banned` / `banExpires` land on `user`), so the missing
            // columns are added rather than left to fail on the next write.
            for (const statement of authDoColumnAdditions(resolved, (table) => this.#columnNames(table))) {
                [...this.#storage.sql.exec(statement)];
            }

            this.#schemaApplied = true;
        }

        this.#auth = createAuth({ ...options, database: lunoraDoAdapter(this.#storage) });

        return this.#auth;
    }

    /**
     * The physical column names on a table, or none when the table does not exist.
     *
     * Uses `pragma_table_info` as a table-valued function, which SQLite-in-DO allows.
     * D1 refuses those through the Worker binding with `SQLITE_AUTH`, so this technique
     * is DO-only — worth remembering before reusing it on the D1 path.
     */
    #columnNames(table: string): string[] {
        const rows = [...this.#storage.sql.exec(`SELECT name FROM pragma_table_info(?)`, table)];

        return rows.map((row) => String(row["name"]));
    }

    /**
     * Read the audit log — the worker's `authAuditReader` in DO mode.
     *
     * `AuthAuditEntry` is entirely JSON-safe (`ts` and `seq` are numbers, there are no
     * `Date` values), so proxying it over HTTP is lossless rather than a lossy
     * serialisation the studio would have to compensate for.
     *
     * The body is parsed and validated defensively (plan 280 §5 S3): a
     * malformed body (not JSON at all) previously threw an unhandled exception
     * out of this method — a 500 — instead of the 400 a caller error deserves;
     * an ill-typed field (e.g. `limit` as a string) previously reached
     * `readAuthAuditLog` unchecked and could bind `NaN` as the SQL `LIMIT`.
     * Both are now rejected here, before the reader ever runs.
     */
    async #readAudit(request: Request): Promise<Response> {
        if (!this.#isTrustedCaller(request)) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        let parsedBody: unknown;

        try {
            parsedBody = await request.json();
        } catch {
            return Response.json({ error: "invalid body" }, { status: 400 });
        }

        // An empty body parses to `undefined`/`null` — treat that as "no options",
        // matching the reader's own default, rather than rejecting it.
        const parsed = parseReadAuditOptions(parsedBody ?? {});

        if ("error" in parsed) {
            return Response.json({ error: parsed.error }, { status: 400 });
        }

        const executor = doExecutor(this.#storage);

        // The audit table is not part of `authTables`, so the schema pass does not
        // create it. Ensuring it here (rather than on every cold start) keeps it off
        // the request path for apps that never read the log.
        await ensureAuthAuditTable(executor);

        const entries = await createAuthAuditReader(executor).read(parsed.options);

        return Response.json({ entries } satisfies { entries: AuthAuditEntry[] });
    }

    /**
     * Whether the caller presented the configured internal secret.
     */
    #isTrustedCaller(request: Request): boolean {
        const { internalSecret } = this.#options;

        if (internalSecret === undefined || internalSecret === "") {
            return false;
        }

        const presented = request.headers.get(INTERNAL_SECRET_HEADER);

        return presented !== null && constantTimeEqual(presented, internalSecret);
    }

    /**
     * Resolve the identity behind a request's headers — the worker's
     * `resolveIdentity` in DO mode.
     *
     * Answers `{ expiresAtMs, role, userId }`, or `{}` for an anonymous request;
     * never the session record itself. The worker only needs those three, and a
     * narrow reply keeps session material inside the object.
     *
     * `expiresAtMs` is the socket credential expiry the runtime forwards as
     * `x-lunora-identity-exp`: without it the DO's expiry check never fires and a
     * signed-out, banned or lapsed user keeps streaming their RLS-scoped rows over
     * an already-open WebSocket. `role` is what `readIdentityRoles` reads for RLS
     * role grants — the D1 wiring forwards it, so dropping it here would make
     * `.auth({ d1 })` -> `.auth({ namespace })` silently turn every grant off.
     */
    async #resolveSession(request: Request): Promise<Response> {
        if (!this.#isTrustedCaller(request)) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const auth = this.#ensureReady();
        // The worker forwards the original request's headers, so the session cookie
        // arrives here intact.
        const session = await auth.api.getSession({ headers: request.headers });
        const userId = session?.user.id;

        if (userId === undefined) {
            return Response.json({});
        }

        // better-auth hands back a `Date`; anything else means the adapter did not
        // hydrate it, and a missing expiry is safer to omit than to guess at.
        const expiresAt = session?.session.expiresAt;
        const role = (session?.user as { role?: unknown } | undefined)?.role;

        return Response.json({
            ...(expiresAt instanceof Date ? { expiresAtMs: expiresAt.getTime() } : {}),
            ...(typeof role === "string" && role.length > 0 ? { role } : {}),
            userId,
        });
    }

    /**
     * Serve an auth request. Routes under `basePath` go to better-auth; the internal
     * session route is handled here; anything else is a 404.
     */
    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === RESOLVE_SESSION_PATH) {
            return this.#resolveSession(request);
        }

        if (url.pathname === READ_AUDIT_PATH) {
            return this.#readAudit(request);
        }

        const auth = this.#ensureReady();
        const response = await handleAuthRequest(auth, request, this.#options.basePath);

        return response ?? Response.json({ error: "not an auth route" }, { status: 404 });
    }
}

export type { AuthDoOptions, AuthDoState };
export { INTERNAL_SECRET_HEADER, LunoraAuthDO, READ_AUDIT_PATH, RESOLVE_SESSION_PATH };
