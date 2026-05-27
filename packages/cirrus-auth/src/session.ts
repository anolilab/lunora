import type { D1DatabaseLike } from "@cirrus/d1";
import type { AuthEnv, AuthSession, AuthUser, SessionNamespaceLike } from "./types.js";

/**
 * Idempotent DDL for the `auth_users` table. Sessions used to live in D1
 * too; they now live in {@link SessionDO} so the `auth_sessions` table —
 * and its tombstone DELETE traffic — is gone. Only user records remain in
 * D1.
 */
const SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        name TEXT,
        password_hash TEXT,
        provider TEXT NOT NULL,
        provider_account_id TEXT,
        created_at INTEGER NOT NULL
    )`,
];

const schemaApplied = new WeakSet<D1DatabaseLike>();

export const ensureSchema = async (db: D1DatabaseLike): Promise<void> => {
    if (schemaApplied.has(db)) {
        return;
    }

    for (const sql of SCHEMA_SQL) {
        await db.prepare(sql).run();
    }

    schemaApplied.add(db);
};

/** Generate a 256-bit url-safe random id (24 chars b64url). */
export const generateId = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/**
 * Generate a 256-bit base64url-encoded session token (~43 chars). Larger
 * than {@link generateId} because the token IS the cookie value and is
 * exposed to anyone who can intercept the cookie jar.
 */
export const generateSessionToken = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

interface UserRow {
    id: string;
    email: string | null;
    name: string | null;
    password_hash: string | null;
    provider: string;
    provider_account_id: string | null;
    created_at: number;
}

const rowToUser = (row: UserRow): AuthUser => ({
    id: row.id,
    email: row.email,
    name: row.name,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    createdAt: row.created_at,
});

export const findUserByEmail = async (db: D1DatabaseLike, email: string): Promise<(AuthUser & { passwordHash: string | null }) | null> => {
    const row = await db.prepare("SELECT * FROM auth_users WHERE email = ?").bind(email).first<UserRow>();

    if (!row) {
        return null;
    }

    return { ...rowToUser(row), passwordHash: row.password_hash };
};

export const findUserById = async (db: D1DatabaseLike, id: string): Promise<AuthUser | null> => {
    const row = await db.prepare("SELECT * FROM auth_users WHERE id = ?").bind(id).first<UserRow>();

    return row ? rowToUser(row) : null;
};

export const findUserByProvider = async (db: D1DatabaseLike, provider: string, providerAccountId: string): Promise<AuthUser | null> => {
    const row = await db.prepare("SELECT * FROM auth_users WHERE provider = ? AND provider_account_id = ?").bind(provider, providerAccountId).first<UserRow>();

    return row ? rowToUser(row) : null;
};

export const createUser = async (
    db: D1DatabaseLike,
    input: { email: string | null; name: string | null; passwordHash: string | null; provider: string; providerAccountId: string | null },
): Promise<AuthUser> => {
    const id = generateId();
    const now = Date.now();

    await db
        .prepare("INSERT INTO auth_users (id, email, name, password_hash, provider, provider_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, input.email, input.name, input.passwordHash, input.provider, input.providerAccountId, now)
        .run();

    return {
        id,
        email: input.email,
        name: input.name,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        createdAt: now,
    };
};

/**
 * Map a session token to the DO instance that owns it. We use the first 16
 * characters of the base64url token as the DO name so:
 *
 *   - same-prefix tokens co-locate (cache friendly, batchable);
 *   - the DO instance count is bounded by 2^96 in theory but ~1.7M in
 *     practice (16 chars of base64url = 96 bits, but real traffic clusters);
 *   - no per-session DO blow-up.
 *
 * Tokens shorter than 16 chars (only ever the empty string in practice) fall
 * back to a reserved `__short__` bucket — safer than throwing and easier to
 * test against.
 */
const sessionShardName = (token: string): string => {
    if (token.length < 16) {
        return "__short__";
    }

    return token.slice(0, 16);
};

const resolveSessionStub = (namespace: SessionNamespaceLike, token: string): { fetch: (request: Request) => Promise<Response> } => {
    const name = sessionShardName(token);

    if (typeof namespace.getByName === "function") {
        return namespace.getByName(name);
    }

    const id = namespace.idFromName(name);

    return namespace.get(id);
};

const requireSessionNamespace = (env: AuthEnv): SessionNamespaceLike => {
    if (!env.SESSION) {
        throw new Error("@cirrus/auth: `env.SESSION` (DurableObjectNamespace) is required");
    }

    return env.SESSION;
};

/**
 * Create a session record inside SessionDO and return the token + metadata.
 * The token is the cookie value; never persist it client-side under any
 * other name.
 */
export const createSession = async (env: AuthEnv, userId: string, ttlSeconds: number): Promise<{ token: string; session: AuthSession }> => {
    const namespace = requireSessionNamespace(env);
    const token = generateSessionToken();
    const stub = resolveSessionStub(namespace, token);

    const response = await stub.fetch(
        new Request("https://session.internal/create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, userId, ttlSeconds }),
        }),
    );

    if (!response.ok) {
        throw new Error(`SessionDO create failed with status ${response.status}`);
    }

    const body = (await response.json()) as { userId: string; createdAt: number; expiresAt: number };

    return {
        token,
        session: {
            id: token,
            userId: body.userId,
            expiresAt: body.expiresAt,
            createdAt: body.createdAt,
        },
    };
};

/**
 * Look up a session by token. Returns `null` if missing or expired —
 * SessionDO handles lazy expiry on its side, so we trust the 404 path.
 */
export const getSession = async (env: AuthEnv, token: string): Promise<AuthSession | null> => {
    if (!token) {
        return null;
    }

    const namespace = requireSessionNamespace(env);
    const stub = resolveSessionStub(namespace, token);
    const response = await stub.fetch(new Request(`https://session.internal/get?token=${encodeURIComponent(token)}`));

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`SessionDO get failed with status ${response.status}`);
    }

    const body = (await response.json()) as { userId: string; createdAt: number; expiresAt: number };

    return {
        id: token,
        userId: body.userId,
        expiresAt: body.expiresAt,
        createdAt: body.createdAt,
    };
};

/** Revoke a session token. Idempotent — missing tokens succeed silently. */
export const revokeSession = async (env: AuthEnv, token: string): Promise<void> => {
    if (!token) {
        return;
    }

    const namespace = requireSessionNamespace(env);
    const stub = resolveSessionStub(namespace, token);
    const response = await stub.fetch(
        new Request(`https://session.internal/revoke?token=${encodeURIComponent(token)}`, {
            method: "DELETE",
        }),
    );

    if (!response.ok && response.status !== 404) {
        throw new Error(`SessionDO revoke failed with status ${response.status}`);
    }
};

/**
 * Look up a session token AND the user record it points at. Sessions live
 * in SessionDO, users live in D1 — this helper coordinates both.
 */
export const findSessionWithUser = async (env: AuthEnv, token: string): Promise<{ session: AuthSession; user: AuthUser } | null> => {
    const session = await getSession(env, token);

    if (!session) {
        return null;
    }

    const user = await findUserById(env.DB, session.userId);

    if (!user) {
        // Session points at a deleted user — revoke aggressively so it
        // can't be reused after the user record is rebuilt.
        await revokeSession(env, token);

        return null;
    }

    return { session, user };
};

export const readSessionCookie = (request: Request, cookieName: string): string | null => {
    const header = request.headers.get("cookie");

    if (!header) {
        return null;
    }

    for (const part of header.split(";")) {
        const [key, ...rest] = part.trim().split("=");

        if (key === cookieName) {
            return rest.join("=") || null;
        }
    }

    return null;
};

/**
 * Build the Set-Cookie header for an authenticated session.
 *
 * `sameSite` defaults to `"lax"` which is appropriate for same-origin SPAs
 * and most server-rendered apps. Cross-origin SPAs (e.g. a Vite dev server
 * hitting a Workers backend) need `"none"`, which forces `Secure` per the
 * cookie spec.
 */
export const buildSessionCookie = (
    cookieName: string,
    sessionId: string,
    ttlSeconds: number,
    { secure = true, sameSite = "lax" }: { secure?: boolean; sameSite?: "lax" | "none" | "strict" } = {},
): string => {
    const sameSiteValue = sameSite === "lax" ? "Lax" : sameSite === "strict" ? "Strict" : "None";
    const isSecure = secure || sameSite === "none";
    const attributes = [`${cookieName}=${sessionId}`, "Path=/", "HttpOnly", `SameSite=${sameSiteValue}`, `Max-Age=${ttlSeconds}`];

    if (isSecure) {
        attributes.push("Secure");
    }

    return attributes.join("; ");
};

export const buildClearCookie = (
    cookieName: string,
    { secure = true, sameSite = "lax" }: { secure?: boolean; sameSite?: "lax" | "none" | "strict" } = {},
): string => {
    const sameSiteValue = sameSite === "lax" ? "Lax" : sameSite === "strict" ? "Strict" : "None";
    const isSecure = secure || sameSite === "none";
    const attributes = [`${cookieName}=`, "Path=/", "HttpOnly", `SameSite=${sameSiteValue}`, "Max-Age=0"];

    if (isSecure) {
        attributes.push("Secure");
    }

    return attributes.join("; ");
};
