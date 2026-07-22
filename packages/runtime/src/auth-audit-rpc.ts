import { LunoraError } from "./errors";

/**
 * Whether the recorded operation succeeded or failed (e.g. a rejected sign-in).
 * Mirrors `@lunora/auth`'s `AuthAuditOutcome`.
 */
type AuthAuditOutcome = "failure" | "success";

/**
 * One recorded auth/security event, structurally mirroring `@lunora/auth`'s
 * `AuthAuditEntry`. Duplicated here (like {@link import("./auth-admin-routes").AuthAdmin})
 * so the runtime stays free of a hard `@lunora/auth` dependency — the host wires
 * a structurally-compatible reader.
 */
interface AuthAuditEntry {
    /** The acting user's email, when known. Absent for anonymous/pre-auth events. */
    actorEmail?: string;
    /** The acting user's id, when known. */
    actorId?: string;
    /** JSON-decoded extra context, with secrets/PII redacted at write time; absent when none was recorded. */
    detail?: Record<string, unknown>;
    /** Auth event type, e.g. `sign-in` / `password-change`. */
    event: string;
    /** Client IP the event originated from, when resolvable. */
    ip?: string;
    /** Whether the operation succeeded or failed. */
    outcome: AuthAuditOutcome;
    /** Monotonic per-database cursor — strictly increasing, never reused. */
    seq: number;
    /** Wall-clock millis when the event was recorded. */
    ts: number;
    /** Client User-Agent, when present on the request. */
    userAgent?: string;
}

/**
 * Filter / paging options forwarded to the reader, structurally mirroring
 * `@lunora/auth`'s `ReadAuthAuditOptions`. `limit` is clamped by the reader
 * (`readAuthAuditLog` bounds it to `[1, 10000]`).
 */
interface ReadAuthAuditQuery {
    /** Return only events for this actor id. */
    actorId?: string;
    /** Return only events of this type. */
    event?: string;
    /** Max rows to return; clamped by the reader. */
    limit?: number;
    /** Return only events with `seq` strictly greater than this (forward paging). */
    sinceSeq?: number;
}

/**
 * The auth/security audit read plane backing the studio's "Security / audit"
 * page. Unlike the shard-forwarded `__lunora_admin__:*` ops, the auth audit trail
 * lives in the auth D1 database (via `@lunora/auth`'s `SqlExecutor`), so it is
 * served at the worker. The host wires this — typically via `@lunora/auth`'s
 * `createAuthAuditReader(d1Executor(env.DB))` — closing over that D1 binding; the
 * runtime stays free of a hard `@lunora/auth` dependency. Omit the option and the
 * RPC responds `AUTH_AUDIT_NOT_CONFIGURED`.
 *
 * The reader is a trusted server-side operator surface — the RPC gates it behind
 * the worker's admin-bearer check before this is ever called.
 */
interface AuthAuditReader {
    read: (options: ReadAuthAuditQuery) => Promise<AuthAuditEntry[]>;
}

/** Payload of a {@link GET_AUTH_AUDIT_LOG_OP} call: the recorded entries, newest first. */
interface AuthAuditLogResult {
    entries: AuthAuditEntry[];
}

/**
 * Reserved RPC path the studio's Security/audit panel invokes via `useAdminQuery`.
 * It shares the `__lunora_admin__:` prefix (and admin gating) of its shard-served
 * siblings, but — because the auth audit trail is D1-backed, not DO SQLite — it is
 * intercepted and served at the worker rather than forwarded to a shard.
 */
const GET_AUTH_AUDIT_LOG_OP = "__lunora_admin__:getAuthAuditLog";

/** Closure-scoped worker helpers the handler borrows (so this module stays out of the worker's god-closure). */
interface AuthAuditRpcDeps {
    /** Throw 403 (`ADMIN_FORBIDDEN`) unless the request carries a valid admin bearer. */
    assertAdmin: (request: Request) => void;
    /** The configured auth-audit reader (`authAuditReader`), or undefined. */
    getReader: () => AuthAuditReader | undefined;
}

/** The worker-served handler for {@link GET_AUTH_AUDIT_LOG_OP}. */
type AuthAuditRpcHandler = (request: Request, args: Record<string, unknown>) => Promise<Response>;

/** Read a non-empty string argument, else `undefined` (collapsing empty strings to "no filter"). */
const stringArgument = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Read a finite, non-negative numeric argument (`sinceSeq` / `limit`), else `undefined`. */
const numericArgument = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * Build the `__lunora_admin__:getAuthAuditLog` handler. Admin-gated FIRST (403
 * `ADMIN_FORBIDDEN` for a non-admin, so the store is default-closed), then
 * `AUTH_AUDIT_NOT_CONFIGURED` (400) when no reader is wired. Passes the
 * `actorId` / `event` / `sinceSeq` / `limit` filters through to the reader, which
 * clamps `limit`. A backend/DB failure is logged server-side and returned as a
 * generic, code-tagged error so schema/driver internals never leak — mirroring
 * the auth-admin routes' posture.
 */
const buildGetAuthAuditLog = (deps: AuthAuditRpcDeps): AuthAuditRpcHandler => {
    const handle = async (request: Request, args: Record<string, unknown>): Promise<Response> => {
        // Assert admin BEFORE the not-configured check so an unauthenticated
        // caller can't probe whether the reader is wired — every caller without a
        // bearer answers 403, exactly like the auth-admin routes.
        deps.assertAdmin(request);

        const reader = deps.getReader();

        if (reader === undefined) {
            throw new LunoraError("the auth/security audit endpoint requires an `authAuditReader` on the worker", {
                code: "AUTH_AUDIT_NOT_CONFIGURED",
                status: 400,
            });
        }

        const query: ReadAuthAuditQuery = {};
        const actorId = stringArgument(args["actorId"]);
        const event = stringArgument(args["event"]);
        const sinceSeq = numericArgument(args["sinceSeq"]);
        const limit = numericArgument(args["limit"]);

        if (actorId !== undefined) {
            query.actorId = actorId;
        }

        if (event !== undefined) {
            query.event = event;
        }

        if (sinceSeq !== undefined) {
            query.sinceSeq = sinceSeq;
        }

        if (limit !== undefined) {
            query.limit = limit;
        }

        let entries: AuthAuditEntry[];

        try {
            entries = await reader.read(query);
        } catch (error) {
            if (error instanceof LunoraError) {
                throw error;
            }

            // Do NOT surface the backend/DB error message to the client (even an
            // authenticated admin) — it can leak schema/driver internals. Log it
            // server-side and return a generic, code-tagged 500.
            // eslint-disable-next-line no-console -- server-side diagnostic for a swallowed backend error
            console.error("[lunora] auth audit read failed:", error);

            throw new LunoraError("auth audit read failed", { code: "AUTH_AUDIT_READ_FAILED", status: 500 });
        }

        const result: AuthAuditLogResult = { entries };

        return Response.json(result, { headers: { "content-type": "application/json" }, status: 200 });
    };

    return handle;
};

export { buildGetAuthAuditLog, GET_AUTH_AUDIT_LOG_OP };
export type { AuthAuditEntry, AuthAuditLogResult, AuthAuditOutcome, AuthAuditReader, ReadAuthAuditQuery };
