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

import { cyrb53 } from "@lunora/values";
import { createAuthMiddleware } from "better-auth/api";

import { onCloudflareEdge } from "../../../shared/on-cloudflare-edge";
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

    /**
     * When true, `x-forwarded-for` is trusted as a client-IP fallback when
     * `cf-connecting-ip` is absent — only enable this behind a proxy you control,
     * or the recorded IP is attacker-chosen. Defaults to `false`: off Cloudflare,
     * with no trusted proxy configured, the audit record's `ip` is omitted rather
     * than populated from a spoofable header.
     */
    trustProxyHeaders?: boolean;
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
        newSession?: { session?: { impersonatedBy?: string; userId?: string }; user?: { email?: string; id?: string } } | null;
        returned?: unknown;
        session?: { session?: { impersonatedBy?: string; userId?: string }; user?: { email?: string; id?: string } } | null;
    };
    headers?: Headers;
    path?: string;
    request?: Request;
}

/**
 * Exact-suffix endpoint table, checked before the branches in {@link eventForPath}.
 * Suffixes are anchored to the whole segment path, never substrings like
 * `/admin/`, so an app `basePath` cannot change the result. Checking this table
 * first also keeps `/device/token` (a session issue) from falling into the
 * `ends("/token")` refresh branch, which is an order-sensitive trap the
 * substring branches cannot avoid.
 */
const SUFFIX_EVENTS: ReadonlyArray<readonly [suffix: string, event: AuthAuditEvent]> = [
    ["/admin/impersonate-user", "admin-impersonate-start"],
    ["/admin/stop-impersonating", "admin-impersonate-stop"],
    ["/admin/set-user-password", "admin-password-set"], // secret-scanner:allow -- endpoint path or event name, not a credential
    ["/admin/set-role", "admin-role-change"],
    ["/admin/revoke-user-session", "admin-session-revoke"],
    ["/admin/revoke-user-sessions", "admin-session-revoke"],
    ["/admin/ban-user", "admin-user-ban"],
    ["/admin/unban-user", "admin-user-unban"],
    ["/admin/create-user", "admin-user-create"],
    ["/admin/update-user", "admin-user-update"],
    ["/admin/remove-user", "admin-user-remove"],
    ["/api-key/create", "api-key-create"],
    ["/api-key/update", "api-key-update"],
    ["/api-key/delete", "api-key-delete"],
    ["/device/approve", "device-approve"],
    ["/device/deny", "device-deny"],
    ["/device/token", "sign-in"],
    // Before `/change-email`, which it ends with: the OTP flow changes the address itself, the plain request only sends a link.
    ["/email-otp/change-email", "email-change"],
    ["/email-otp/request-email-change", "email-change-request"],
    ["/change-email", "email-change-request"],
    ["/delete-user", "user-delete"],
    ["/delete-user/callback", "user-delete"],
    ["/delete-anonymous-user", "user-delete"],
    ["/forget-password/email-otp", "password-reset-request"], // secret-scanner:allow -- endpoint path or event name, not a credential
    ["/two-factor/generate-backup-codes", "mfa-backup-codes-regenerate"],
    ["/one-time-token/generate", "one-time-token-create"],
    ["/one-time-token/verify", "sign-in"],
    ["/one-tap/callback", "sign-in"],
    ["/passkey/verify-authentication", "sign-in"],
    ["/passkey/verify-registration", "passkey-add"],
    ["/passkey/delete-passkey", "passkey-remove"],
    ["/passkey/update-passkey", "passkey-rename"],
    // Verification signs the caller in unless it attaches a number (see `refineEvent`).
    ["/phone-number/verify", "sign-in"],
    ["/siwe/verify", "sign-in"],
    ["/sso/callback", "sign-in"],
    ["/multi-session/set-active", "session-switch"],
    ["/multi-session/revoke", "session-revoke"],
];

// The substring and suffix branches `eventForPath` falls back to. Order matters inside:
// an earlier match wins, so reordering a branch changes the classification.
const branchEventForPath = (normalized: string): AuthAuditEvent | undefined => {
    const ends = (suffix: string): boolean => normalized === suffix || normalized.endsWith(suffix);

    if (ends("/sign-up/email") || ends("/sign-up")) {
        return "sign-up";
    }

    if (ends("/sign-in/social") || ends("/sign-in/magic-link") || ends("/sign-in/sso")) {
        return "sign-in-initiated";
    }

    if (
        normalized.includes("/sign-in/") ||
        normalized.includes("/callback/") ||
        normalized.includes("/saml2/sp/acs/") ||
        ends("/magic-link/verify") ||
        normalized.includes("/two-factor/verify-")
    ) {
        return "sign-in";
    }

    if (ends("/sign-out") || normalized.includes("/saml2/logout/") || normalized.includes("/saml2/sp/slo/")) {
        return "sign-out";
    }

    if (ends("/change-password") || ends("/set-password")) {
        return "password-change";
    }

    if (ends("/reset-password")) {
        return "password-reset";
    }

    if (ends("/request-password-reset") || ends("/forget-password")) {
        return "password-reset-request"; // secret-scanner:allow -- endpoint path or event name, not a credential
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

/**
 * Map a better-auth endpoint path to the security event it represents, or
 * `undefined` for endpoints not worth auditing (session reads, config, …). Match
 * is by suffix so a caller `basePath` prefix (`/api/auth`) never affects it.
 *
 * Sign-in is split by what the endpoint actually DOES (plan 280 §4):
 *
 * - `/sign-in/social`, `/sign-in/magic-link` and `@better-auth/sso`'s
 * `/sign-in/sso` only DISPATCH — the first mints a provider redirect URL, the
 * second sends an email, the third answers `{ url, redirect: true }` pointing
 * at the identity provider's authorization endpoint. Nobody is authenticated
 * yet, so these are `sign-in-initiated`, not `sign-in`. Without the `sso`
 * branch that path fell through to the `/sign-in/` substring below and every
 * SSO redirect mint was recorded as a completed, successful `sign-in` with no
 * actor — in exactly the flow where the "who authenticated" trail matters
 * most.
 * - `/callback/:id` (social + generic-oauth), `/magic-link/verify`,
 * `@better-auth/sso`'s `/sso/saml2/sp/acs/:providerId`, and every
 * `/two-factor/verify-*` (`verify-totp` / `verify-otp` / `verify-backup-code`
 * — all three complete a challenged sign-in the same way) are where a
 * session actually gets issued, so they join credential sign-ins
 * (`/sign-in/email`, `/sign-in/username`, `/sign-in/phone-number`, …) as
 * plain `sign-in`. They were NOT recorded at all before this change.
 *
 * The SAML assertion consumer service needs its own branch because it is the
 * one completion that carries no `/callback/` segment: `processSAMLResponse`
 * validates the assertion, resolves the user and calls `setSessionCookie`, all
 * under `/sso/saml2/sp/acs/:providerId`. Matching neither that substring nor
 * any other branch, it classified as `undefined` — the endpoint that issues
 * every SAML session left no audit row at all.
 *
 * SAML sign-OUT has the mirror-image problem, and two endpoints rather than
 * one. Neither ends in `/sign-out`, and both terminate the local session before
 * redirecting, so both are `sign-out` rather than an initiated event:
 *
 * - `/sso/saml2/logout/:providerId` — SP-initiated. Deletes the SAML session
 * keys, calls `deleteSession` on the current session token and
 * `deleteSessionCookie`, then redirects to the IdP's logout URL.
 * - `/sso/saml2/sp/slo/:providerId` — the SP's single-logout receiver, for the
 * IdP-initiated direction and for the response leg of an SP-initiated one.
 * Both `handleLogoutRequest` and `handleLogoutResponse` call `deleteSession`
 * and `deleteSessionCookie` the same way.
 *
 * Recording the SAML sign-in while leaving these silent is worse than either
 * gap alone: the trail would show a session opening and never closing, so a
 * reader cannot tell "still signed in" from "we stopped watching".
 *
 * There is no dedicated `/oauth2/callback/*` branch because the generic
 * `/callback/` check above already covers it, and covering it is CORRECT: an
 * OAuth callback is a completed sign-in whatever path prefix it arrives on. The
 * same substring also catches `@better-auth/sso`'s `/sso/callback/:providerId`,
 * which is where an SSO sign-in actually completes — `sso` is re-exported from
 * `@lunora/auth/plugins/enterprise`, so that path is live, not hypothetical.
 *
 * Checked against the installed `better-auth` and `@better-auth/*` dist for
 * 1.7.3: generic-oauth registers NO endpoints of its own (there is no
 * `/sign-in/oauth2`) — it registers providers used through the core
 * `/sign-in/social` and `/callback/:id`, and the one dist hit for a literal
 * `/oauth2/callback/` is inside `better-auth/plugins/oauth-popup`, which
 * `plugins.ts` does not re-export — so today the branch fires for the core
 * callback, and stays correct if the other becomes reachable.
 *
 * The plugin endpoints in {@link SUFFIX_EVENTS} are pinned against the installed
 * better-auth by `__tests__/audit-endpoint-coverage.test.ts`, which fails on any
 * endpoint it does not classify, so an upgrade cannot add one silently.
 *
 * The exact table {@link SUFFIX_EVENTS} is consulted first, then the substring branches.
 */
const eventForPath = (path: string): AuthAuditEvent | undefined => {
    const normalized = path.toLowerCase();
    const exactEvent = SUFFIX_EVENTS.find(([suffix]) => normalized === suffix || normalized.endsWith(suffix))?.[1];

    return exactEvent ?? branchEventForPath(normalized);
};

/** Pull the first present header off whichever of `headers` / `request.headers` exists. */
const header = (context: AuditHookContext, name: string): string | undefined => {
    const value = context.headers?.get(name) ?? context.request?.headers.get(name);

    return value ?? undefined;
};

/**
 * Resolve the client IP: `cf-connecting-ip` when present **and running on
 * Cloudflare**, where the edge sets it itself and a client cannot influence it.
 * Otherwise `undefined`, unless the caller has opted into `trustProxyHeaders`,
 * in which case the leftmost `x-forwarded-for` entry is used. No other proxy
 * header is consulted — none is more trustworthy than `x-forwarded-for`, and an
 * attacker-chosen IP in an audit row is worse than a missing one.
 *
 * The {@link onCloudflareEdge} gate is the same shared one `create-auth.ts`'s
 * `defaultIpAddressHeaders` applies, deliberately: off Cloudflare (the Node
 * host, a bare container) nothing overwrites `cf-connecting-ip`, so it is a
 * header like any other. Reading it there lets an attacker set the `ip` on every
 * sign-in / password-reset / mfa-disable row they generate — and this package's
 * two IP resolvers must not disagree about who a request came from.
 */
const resolveIp = (context: AuditHookContext, trustProxyHeaders: boolean | undefined): string | undefined => {
    if (onCloudflareEdge()) {
        const cfConnectingIp = header(context, "cf-connecting-ip");

        if (cfConnectingIp !== undefined) {
            return cfConnectingIp;
        }
    }

    if (trustProxyHeaders !== true) {
        return undefined;
    }

    return header(context, "x-forwarded-for")?.split(",")[0]?.trim();
};

const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Longest id copied into `detail`; a longer value is cut rather than dropped. */
const MAX_DETAIL_ID_LENGTH = 256;

/**
 * An id read from a request body or response and copied into `detail`. Capped, because a caller can send any length
 * and a failed request is still written.
 */
const detailId = (value: unknown): string | undefined => {
    const id = stringOf(value);

    // An `@` marks an email, or a URL that carries userinfo. Neither is an id, and an identifier is exempt from redaction,
    // so it is never copied.
    if (id === undefined || id.includes("@")) {
        return undefined;
    }

    if (id.length <= MAX_DETAIL_ID_LENGTH) {
        return id;
    }

    // Two long ids that share a prefix would otherwise read the same, so the cut keeps a hash of the whole value.
    return `${id.slice(0, MAX_DETAIL_ID_LENGTH - 15)}~${cyrb53(id).toString(16).padStart(14, "0")}`;
};

const fieldOf = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Resolve actor id/email from the freshly-created session (sign-in/up) or the existing session.
 * An impersonated session names the administrator in `impersonatedBy`, and that is the actor: its
 * `user` is the impersonated account. The administrator's email is not on the session, so none is recorded.
 */

/**
 * The session an event is performed by. A revoke or a switch is made by the request's session, since its response can
 * leave another account's session in `newSession`. Every other event reads the identity it produces, which is `newSession`.
 */
type SessionShape = NonNullable<NonNullable<AuditHookContext["context"]>["session"]>;

const actingSession = (context: AuditHookContext, event: AuthAuditEvent | undefined): SessionShape | null | undefined => {
    const requestSession = context.context?.session;
    const resultingSession = context.context?.newSession;

    return event === "session-revoke" || event === "session-switch" ? (requestSession ?? resultingSession) : (resultingSession ?? requestSession);
};

const resolveActor = (context: AuditHookContext, event: AuthAuditEvent | undefined): { actorEmail?: string; actorId?: string } => {
    const source = actingSession(context, event);
    const impersonator = stringOf(source?.session?.impersonatedBy);

    if (impersonator !== undefined) {
        return { actorId: impersonator };
    }

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
 * The account an impersonated session acts as, which the administrator named in `impersonatedBy` is acting for.
 * `undefined` for an ordinary session.
 */
const impersonatedUserId = (context: AuditHookContext, event: AuthAuditEvent | undefined): string | undefined => {
    const source = actingSession(context, event);

    if (stringOf(source?.session?.impersonatedBy) === undefined) {
        return undefined;
    }

    return stringOf(source?.user?.id);
};

/**
 * The subject of an `admin-*` action: the account the operator acted on, so the row says
 * who was impersonated, created or changed. Taken from `ctx.body.userId` when the endpoint
 * takes one. `create-user` has no such body field, so its subject is the account the response
 * returns; `stop-impersonating` has none either, so its subject is the impersonated session's
 * user. Only the id is copied: other body fields (`set-user-password` carries the new password)
 * and the rest of the response must never reach the trail.
 */
const resolveTargetUserId = (context: AuditHookContext, event: AuthAuditEvent): string | undefined => {
    if (!event.startsWith("admin-")) {
        // An impersonated session acts as the impersonated account, so that account is what the row is about.
        return impersonatedUserId(context, event);
    }

    const fromBody = detailId(context.body?.["userId"]);

    if (fromBody !== undefined) {
        return fromBody;
    }

    if (event === "admin-user-create") {
        return detailId(fieldOf(fieldOf(context.context?.returned, "user"), "id"));
    }

    if (event === "admin-impersonate-stop") {
        return detailId(fieldOf(fieldOf(context.context?.session, "user"), "id")) ?? detailId(fieldOf(fieldOf(context.context?.session, "session"), "userId"));
    }

    return undefined;
};

/** Device-flow errors that mean the user has not approved yet: the client polls again, and nothing failed. */
const DEVICE_POLL_PENDING: ReadonlySet<string> = new Set(["authorization_pending", "slow_down"]);

/**
 * Settle the endpoint's event from the request body and the response, where the path alone cannot tell.
 * Returns `undefined` for a device poll that is still waiting for approval.
 */
const refineEvent = (context: AuditHookContext, event: AuthAuditEvent): AuthAuditEvent | undefined => {
    const path = context.path?.toLowerCase() ?? "";
    const returned = context.context?.returned;
    const pendingDevicePoll = DEVICE_POLL_PENDING.has(stringOf(fieldOf(fieldOf(returned, "body"), "error")) ?? "");
    let refined: AuthAuditEvent | undefined = event;

    if (event === "sign-in" && path.endsWith("/phone-number/verify")) {
        // Without `updatePhoneNumber` the code signs the caller in, unless sessions are disabled: a verified number then comes
        // back with no token, and nobody is signed in. With `updatePhoneNumber` the number is attached to an existing account.
        // A failed request is recorded as a failed sign-in attempt, as before. A successful one signs in only with a token.
        const hasToken = stringOf(fieldOf(returned, "token")) !== undefined;
        const signsIn = context.body?.["updatePhoneNumber"] !== true && (hasToken || resolveOutcome(context) === "failure");
        refined = signsIn ? "sign-in" : "phone-verification";
    } else if (event === "user-delete" && path.endsWith("/delete-user") && stringOf(fieldOf(returned, "message")) === "Verification email sent") {
        refined = "user-delete-request";
    } else if (event === "sign-in" && path.endsWith("/device/token") && pendingDevicePoll) {
        refined = undefined;
    }

    return refined;
};

/**
 * The key a key-management row is about: the created key's id, or the `keyId` the caller named. The key
 * secret is never copied.
 */
const resolveKeyId = (context: AuditHookContext, event: AuthAuditEvent): string | undefined => {
    if (event === "api-key-create") {
        return detailId(fieldOf(context.context?.returned, "id"));
    }

    if (event === "api-key-update" || event === "api-key-delete") {
        return detailId(context.body?.["keyId"]);
    }

    return undefined;
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
const buildAuditEntry = (
    context: AuditHookContext,
    { now = Date.now(), trustProxyHeaders }: { now?: number; trustProxyHeaders?: boolean } = {},
): AppendAuthAuditEntry | undefined => {
    const endpointEvent = context.path === undefined ? undefined : eventForPath(context.path);
    const event = endpointEvent === undefined ? undefined : refineEvent(context, endpointEvent);

    if (event === undefined) {
        return undefined;
    }

    const ip = resolveIp(context, trustProxyHeaders);
    const userAgent = header(context, "user-agent");
    const targetEmail = resolveTargetEmail(context, event);
    const targetUserId = resolveTargetUserId(context, event);
    const keyId = resolveKeyId(context, event);

    return {
        ...resolveActor(context, event),
        event,
        outcome: resolveOutcome(context),
        ts: now,
        ...(ip === undefined ? {} : { ip }),
        ...(targetEmail === undefined ? {} : { targetEmail }),
        ...(userAgent === undefined ? {} : { userAgent }),
        detail: {
            path: context.path,
            ...(targetUserId === undefined ? {} : { targetUserId }),
            ...(keyId === undefined ? {} : { keyId }),
        },
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
 * | `/device/token`                                    | `token-refresh`     | `sign-in`             |
 * | `/request-password-reset`, `/forget-password`, `…/forget-password/email-otp`, `…/request-password-reset` | `password-reset` | `password-reset-request` |
 * | Any event in a session that is impersonating another user | actor is the impersonated user, with `actorEmail` | actor is the administrator (`impersonatedBy`), with no `actorEmail`; the impersonated user is `detail.targetUserId` |
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
            const entry = buildAuditEntry(context, { trustProxyHeaders: config.trustProxyHeaders });

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
              const returned = await existing(context);

              await (audit as unknown as (context: unknown) => Promise<unknown>)(context);

              // The audit hook records a side effect and must never replace a
              // response the caller's own hook produced.
              return returned;
          }
        : audit;

    return { ...options, hooks: { ...options.hooks, after } };
};

export { authAuditHook, buildAuditEntry, eventForPath, withAuthAudit };
export type { AuthAuditHookConfig };
