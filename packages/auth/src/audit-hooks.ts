/**
 * Bridge better-auth's request lifecycle into the {@link appendAuthAuditEntry}
 * trail.
 *
 * better-auth runs every endpoint through an optional `hooks.after` middleware.
 * We install one that classifies the endpoint `path` into an {@link AuthAuditEvent},
 * resolves the actor / client IP / User-Agent / outcome from the request +
 * resulting session, and appends a redacted row via the {@link SqlExecutor} the
 * app hands us at construction. The hook is wrapped so an audit failure can never
 * break an auth request.
 */

import { createAuthMiddleware } from "better-auth/api";

import type { AppendAuthAuditEntry, AppendAuthAuditOptions, AuthAuditEvent, AuthAuditOutcome } from "./audit";
import { appendAuthAuditEntry } from "./audit";
import type { SqlExecutor } from "./sql-store";

/** Configuration for {@link authAuditHook}. */
interface AuthAuditHookConfig extends AppendAuthAuditOptions {
    /**
     * Where to persist the trail — the same {@link SqlExecutor} seam better-auth's
     * store rides (`d1Executor(env.DB)`), so events land in the auth D1 database.
     */
    executor: SqlExecutor;

    /**
     * Optional export tap (pairs with SIEM forwarding): called with each redacted
     * entry right after it is persisted, so a deployment can fan events out to an
     * external sink. Rejections/throws are swallowed so forwarding can't break an
     * auth request.
     */
    onRecord?: (entry: AppendAuthAuditEntry) => Promise<void> | void;
}

/** Structural view of the fields we read off better-auth's after-hook context — kept loose to avoid coupling to internal types. */
interface AuditHookContext {
    context?: {
        newSession?: { session?: { userId?: string }; user?: { email?: string; id?: string } } | null;
        returned?: unknown;
        session?: { session?: { userId?: string }; user?: { email?: string; id?: string } } | null;
    };
    headers?: Headers;
    path?: string;
    request?: Request;
}

/**
 * Map a better-auth endpoint path to the security event it represents, or
 * `undefined` for endpoints not worth auditing (session reads, config, …). Match
 * is by suffix so a caller `basePath` prefix (`/api/auth`) never affects it.
 */
const eventForPath = (path: string): AuthAuditEvent | undefined => {
    const normalized = path.toLowerCase();
    const ends = (suffix: string): boolean => normalized === suffix || normalized.endsWith(suffix);

    if (ends("/sign-up/email") || ends("/sign-up")) {
        return "sign-up";
    }

    if (normalized.includes("/sign-in/")) {
        return "sign-in";
    }

    if (ends("/sign-out")) {
        return "sign-out";
    }

    if (ends("/change-password") || ends("/set-password")) {
        return "password-change";
    }

    if (ends("/reset-password") || ends("/request-password-reset") || ends("/forget-password")) {
        return "password-reset";
    }

    if (ends("/verify-email")) {
        return "email-verification";
    }

    if (normalized.includes("/two-factor/enable") || normalized.includes("/totp/enable")) {
        return "mfa-enable";
    }

    if (normalized.includes("/two-factor/disable") || normalized.includes("/totp/disable")) {
        return "mfa-disable";
    }

    if (ends("/refresh-token") || ends("/token")) {
        return "token-refresh";
    }

    if (ends("/revoke-session") || ends("/revoke-sessions") || ends("/revoke-other-sessions")) {
        return "session-revoke";
    }

    if (ends("/link-social")) {
        return "account-link";
    }

    if (ends("/unlink-account")) {
        return "account-unlink";
    }

    return undefined;
};

/** Pull the first present header off whichever of `headers` / `request.headers` exists. */
const header = (context: AuditHookContext, name: string): string | undefined => {
    const value = context.headers?.get(name) ?? context.request?.headers.get(name);

    return value ?? undefined;
};

/** Resolve the client IP from the usual proxy headers (Cloudflare first). */
const resolveIp = (context: AuditHookContext): string | undefined => {
    const forwarded = header(context, "x-forwarded-for");

    return header(context, "cf-connecting-ip") ?? (forwarded === undefined ? undefined : forwarded.split(",")[0]?.trim()) ?? header(context, "x-real-ip");
};

/** Resolve actor id/email from the freshly-created session (sign-in/up) or the existing session. */
const resolveActor = (context: AuditHookContext): { actorEmail?: string; actorId?: string } => {
    const source = context.context?.newSession ?? context.context?.session;
    const actorId = source?.user?.id ?? source?.session?.userId;
    const actorEmail = source?.user?.email;

    return {
        ...(actorId === undefined ? {} : { actorId }),
        ...(actorEmail === undefined ? {} : { actorEmail }),
    };
};

/**
 * An APIError-shaped return (thrown endpoints that dispatch captures into
 * `returned`) means the operation failed. Everything else is treated as success.
 */
const resolveOutcome = (context: AuditHookContext): AuthAuditOutcome => {
    const returned = context.context?.returned;

    if (returned instanceof Error) {
        return "failure";
    }

    if (typeof returned === "object" && returned !== null && "status" in returned) {
        const status = Number((returned as { status?: unknown }).status);

        if (Number.isFinite(status) && status >= 400) {
            return "failure";
        }
    }

    return "success";
};

/**
 * Build the entry a given after-hook context should record, or `undefined` when
 * the path is not an audited security event. Exported for direct unit testing of
 * the classification/extraction without spinning up better-auth.
 */
const buildAuditEntry = (context: AuditHookContext, now: number = Date.now()): AppendAuthAuditEntry | undefined => {
    const event = context.path === undefined ? undefined : eventForPath(context.path);

    if (event === undefined) {
        return undefined;
    }

    const ip = resolveIp(context);
    const userAgent = header(context, "user-agent");

    return {
        ...resolveActor(context),
        event,
        outcome: resolveOutcome(context),
        ts: now,
        ...(ip === undefined ? {} : { ip }),
        ...(userAgent === undefined ? {} : { userAgent }),
        detail: { path: context.path },
    };
};

/**
 * Create the better-auth `hooks.after` middleware that records the auth/security
 * audit trail. Assign it to `hooks.after` (or compose via {@link withAuthAudit}).
 *
 * ```ts
 * const auth = createAuth({
 *     secret: env.AUTH_SECRET,
 *     database: lunoraD1Adapter(env.DB),
 *     hooks: { after: authAuditHook({ executor: d1Executor(env.DB), retention: 100_000 }) },
 * });
 * ```
 */
const authAuditHook = (config: AuthAuditHookConfig): ReturnType<typeof createAuthMiddleware> =>
    createAuthMiddleware(async (context) => {
        try {
            const entry = buildAuditEntry(context);

            if (entry !== undefined) {
                const persisted = await appendAuthAuditEntry(config.executor, entry, {
                    redactDetail: config.redactDetail,
                    retention: config.retention,
                });

                if (config.onRecord !== undefined) {
                    await config.onRecord(persisted);
                }
            }
        } catch (error) {
            // An audit failure must never break an auth request. Log and move on.
            // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
            console.error("@lunora/auth: audit hook failed to record event", error);
        }

        // Must return an object: better-auth's after-hook runner reads `.headers`
        // / `.response` off the result, so returning `undefined` would throw.
        return {};
    });

/**
 * Merge the audit `hooks.after` middleware into a better-auth options object,
 * composing with any `hooks.after` the caller already set (theirs runs first,
 * then the audit record). Returns a new options object.
 */
const withAuthAudit = <Options extends { hooks?: { after?: unknown } }>(options: Options, config: AuthAuditHookConfig): Options => {
    const audit = authAuditHook(config);
    const existing = options.hooks?.after as ((context: unknown) => Promise<unknown>) | undefined;

    const after = existing
        ? async (context: unknown): Promise<unknown> => {
              await existing(context);

              return (audit as unknown as (context: unknown) => Promise<unknown>)(context);
          }
        : audit;

    return { ...options, hooks: { ...options.hooks, after } };
};

export { authAuditHook, buildAuditEntry, eventForPath, withAuthAudit };
export type { AuthAuditHookConfig };
