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

/**
 * Structural view of the fields we read off better-auth's after-hook context —
 * kept loose to avoid coupling to internal types.
 *
 * `body` is the parsed request body better-auth's middleware context exposes
 * as `ctx.body` — pinned present and populated (e.g. `.email`) in the after-hook
 * by `__tests__/audit-hooks.behaviour.test.ts` (plan 280 S0).
 */
interface AuditHookContext {
    body?: Record<string, unknown>;
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
 *
 * Sign-in is split by what the endpoint actually DOES (plan 280 §4):
 *
 * - `/sign-in/social`, `/sign-in/magic-link` only DISPATCH — the first mints a
 * provider redirect URL, the second sends an email. Nobody is authenticated
 * yet, so these are `sign-in-initiated`, not `sign-in`.
 * - `/callback/:id` (social + generic-oauth), `/magic-link/verify`, and every
 * `/two-factor/verify-*` (`verify-totp` / `verify-otp` / `verify-backup-code`
 * — all three complete a challenged sign-in the same way) are where a
 * session actually gets issued, so they join credential sign-ins
 * (`/sign-in/email`, `/sign-in/username`, `/sign-in/phone-number`, …) as
 * plain `sign-in`. They were NOT recorded at all before this change.
 *
 * `/oauth2/callback/*` is deliberately NOT matched here: it does not exist as
 * an endpoint in the pinned `1.7.0-rc.2` (checked against the installed
 * `better-auth` and `@better-auth/*` dist — generic-oauth reuses the core
 * `/callback/:id` endpoint, it does not register its own path). `@better-auth/sso`
 * does expose its own `/sso/callback/:providerId`, but `@lunora/auth`'s
 * `plugins.ts` does not currently re-export `sso` — recorded as a gap for a
 * follow-up (plan 280 §9 Q1), not matched here since it is unreachable through
 * this package today.
 */
const eventForPath = (path: string): AuthAuditEvent | undefined => {
    const normalized = path.toLowerCase();
    const ends = (suffix: string): boolean => normalized === suffix || normalized.endsWith(suffix);

    if (ends("/sign-up/email") || ends("/sign-up")) {
        return "sign-up";
    }

    if (ends("/sign-in/social") || ends("/sign-in/magic-link")) {
        return "sign-in-initiated";
    }

    if (normalized.includes("/sign-in/") || normalized.includes("/callback/") || ends("/magic-link/verify") || normalized.includes("/two-factor/verify-")) {
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
 * RFC 5321's address-length ceiling — caps how much attacker-controlled request
 * body text can land in the forensic `targetEmail` column (§8 risk: a hostile
 * body's `email`/`username` is bound as a plain SQL parameter, never
 * interpreted, but is still worth bounding).
 */
const MAX_TARGET_EMAIL_LENGTH = 320;

/**
 * The attempted identifier for a sign-in-family event (`sign-in` or
 * `sign-in-initiated`) — `ctx.body.email`, falling back to `ctx.body.username`
 * (credential sign-in also accepts a username in some configurations). `undefined`
 * for every other event, and for a non-string/empty value. Deliberately a
 * TOP-LEVEL entry field (see {@link AppendAuthAuditEntry.targetEmail}), never a
 * `detail` key: `AUDIT_REDACT_RULES` (`./audit.ts`) scrubs email-shaped values
 * inside `detail` regardless of key name, which would erase exactly this datum.
 */
const resolveTargetEmail = (context: AuditHookContext, event: AuthAuditEvent): string | undefined => {
    if (event !== "sign-in" && event !== "sign-in-initiated") {
        return undefined;
    }

    const candidate = context.body?.["email"] ?? context.body?.["username"];

    if (typeof candidate !== "string" || candidate.length === 0) {
        return undefined;
    }

    return candidate.length > MAX_TARGET_EMAIL_LENGTH ? candidate.slice(0, MAX_TARGET_EMAIL_LENGTH) : candidate;
};

/**
 * Build the entry a given after-hook context should record, or `undefined` when
 * the path is not an audited security event. Exported for direct unit testing of
 * the classification/extraction without spinning up better-auth.
 *
 * Does NOT attempt to distinguish a 2FA-challenged credential sign-in from a
 * fully successful one (a `sign-in-challenged` event, as an earlier design for
 * this change proposed) — pinned in `__tests__/audit-hooks.behaviour.test.ts`
 * (plan 280 S0): better-auth runs the APP's own `hooks.after` BEFORE the
 * `twoFactor` plugin's own after-hook that rewrites the response to
 * `{ twoFactorRedirect: true }` and nulls `ctx.context.newSession`. By the time
 * THIS hook runs, `context.returned`/`context.newSession` still reflect the
 * pre-interception, fully-successful sign-in — there is nothing here to detect
 * the challenge from. Distinguishing it would need a different seam (e.g. a
 * plugin-ordered-after-`twoFactor` hook, or reading `twoFactor`'s own
 * database state) and is left to a follow-up.
 */
const buildAuditEntry = (context: AuditHookContext, now: number = Date.now()): AppendAuthAuditEntry | undefined => {
    const event = context.path === undefined ? undefined : eventForPath(context.path);

    if (event === undefined) {
        return undefined;
    }

    const ip = resolveIp(context);
    const userAgent = header(context, "user-agent");
    const targetEmail = resolveTargetEmail(context, event);

    return {
        ...resolveActor(context),
        event,
        outcome: resolveOutcome(context),
        ts: now,
        ...(ip === undefined ? {} : { ip }),
        ...(targetEmail === undefined ? {} : { targetEmail }),
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
 *
 * ## Behaviour change (plan 280) — `onRecord`/SIEM consumers keyed on `event` strings, read this
 *
 * | Endpoint                                          | Before              | After                 |
 * | -------------------------------------------------- | ------------------- | --------------------- |
 * | `/sign-in/email` (and other credential sign-ins)  | `sign-in`           | `sign-in` (unchanged) |
 * | `/sign-in/social`                                  | `sign-in`           | `sign-in-initiated`   |
 * | `/sign-in/magic-link`                              | `sign-in`           | `sign-in-initiated`   |
 * | `/callback/:id` (social + generic-oauth)          | _(not recorded)_    | `sign-in`             |
 * | `/magic-link/verify`                               | _(not recorded)_    | `sign-in`             |
 * | `/two-factor/verify-totp` / `-otp` / `-backup-code`| _(not recorded)_    | `sign-in`             |
 *
 * A caller matching on `event === "sign-in"` now sees FEWER events for
 * `/sign-in/social` and `/sign-in/magic-link` (they never actually authenticated
 * anyone) and MORE events for the four previously-unrecorded completion
 * endpoints — the net effect is a more truthful count, not a strictly larger or
 * smaller one. `sign-in-initiated` is a new event name (open `AuthAuditEvent`
 * union, so no wire/type break, but SIEM rules enumerating event names should
 * add it). A failed sign-in now also carries `targetEmail` (the attempted
 * address/username) when the request body supplied one — see
 * {@link AppendAuthAuditEntry.targetEmail} — so credential-stuffing attempts can
 * be grouped by target even though they never produce an `actorEmail`.
 *
 * NOT changed: `/sign-in/email` under an active 2FA challenge still records
 * plain `sign-in` / `success` (not a distinct `sign-in-challenged` event) — see
 * {@link buildAuditEntry}'s docblock for why that distinction turned out not to
 * be buildable from this hook.
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

        // CRITICAL: return `undefined`, NEVER a bare object. better-auth's after-hook
        // runner (`dispatch.mjs`'s `runAfterHooks`) treats ANY non-undefined value a
        // hook resolves to as the endpoint's NEW response and overwrites
        // `context.context.returned` with it — so a hook that ends `return {};` (this
        // function's shape until this fix) silently REPLACES every hooked endpoint's
        // real response body with `{}` on the wire: sign-up, sign-in, everything.
        // `undefined` does not throw (the opposite of what the old comment here
        // claimed) and is the true no-op — pinned empirically in
        // `__tests__/audit-hooks.behaviour.test.ts`'s "hooks.after return value"
        // suite (plan 280 S0), which reproduces the `{}` clobber and proves
        // `undefined` leaves the response byte-for-byte equivalent to no hook at all.
        return undefined;
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
