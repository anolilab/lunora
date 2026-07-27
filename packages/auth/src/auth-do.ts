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
import type { LunoraAuth, LunoraAuthOptions } from "./create-auth";
import { createAuth, resolveAuthOptions } from "./create-auth";
import authDoSchemaStatements from "./do-schema";
import type { DoStorageLike } from "./do-store";
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

/** Header carrying the shared secret that authenticates the calling worker. */
const INTERNAL_SECRET_HEADER = "x-lunora-auth-do-secret";

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
            for (const statement of authDoSchemaStatements(resolveAuthOptions(options))) {
                // The cursor is lazy in workerd — iterating is what runs the statement.
                [...this.#storage.sql.exec(statement)];
            }

            this.#schemaApplied = true;
        }

        this.#auth = createAuth({ ...options, database: lunoraDoAdapter(this.#storage) });

        return this.#auth;
    }

    /** Whether the caller presented the configured internal secret. */
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
     * Answers `{ userId }`, or `{}` for an anonymous request; never the session
     * record itself. The worker only needs the subject, and a narrow reply keeps
     * session material inside the object.
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

        return Response.json(userId === undefined ? {} : { userId });
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

        const auth = this.#ensureReady();
        const response = await handleAuthRequest(auth, request, this.#options.basePath);

        return response ?? Response.json({ error: "not an auth route" }, { status: 404 });
    }
}

export type { AuthDoOptions, AuthDoState };
export { INTERNAL_SECRET_HEADER, LunoraAuthDO, RESOLVE_SESSION_PATH };
