import { isEnvDisabled, isEnvEnabled } from "../../../shared/env-flag";

/**
 * Ordering/visual weight of a security finding — mirrors the studio's insight
 * severities so the Security Advisor and the Performance Advisor (Insights) share
 * one badge vocabulary. `error` sorts worst-first, then `warning`, then `info`.
 */
type SecurityFindingLevel = "error" | "info" | "warning";

/**
 * Which security heuristic fired. The detection stays free of presentation
 * strings — the studio maps each kind to a localized title, explanation, and
 * remediation hint — so the rule set is trivially unit-testable and the wire
 * payload is tiny.
 *
 * `admin-token-weak`: `LUNORA_ADMIN_TOKEN` is set but short enough to be brute-forceable. (An *unset* token disables admin introspection entirely, so this audit — itself admin-gated — only ever runs with a token present.)
 *
 * `ws-gate-open`: admin HTTP RPCs require the bearer, but `LUNORA_WS_BEARER` is unset so the WebSocket upgrade gate defaults open — live admin subscriptions (Logs, Metrics, …) are reachable without a credential.
 *
 * `dev-args-unredacted`: the worker reports a development environment, so the durable request log captures raw, un-redacted args and identity (PII). A production deploy mislabeled as dev would persist sensitive payloads.
 *
 * `auth-secret-weak`: `AUTH_SECRET` / `BETTER_AUTH_SECRET` is set but shorter than 32 chars — too little entropy to sign session tokens safely. Pairs with `admin-token-weak`.
 *
 * `cors-wildcard-credentials`: `LUNORA_ALLOWED_ORIGINS` includes a `*` wildcard while `LUNORA_CORS_ALLOW_CREDENTIALS` is on — browsers reject the combination and it defeats the allowlist, so credentialed cross-origin requests are effectively unguarded.
 *
 * `security-headers-disabled`: the deployment set `LUNORA_SECURITY_HEADERS` off, so HSTS / CSP / nosniff / frame-options are not applied — a real exposure on a production worker.
 *
 * `csrf-disabled`: the deployment set `LUNORA_SECURITY_CSRF` off, so the cross-origin state-change guard is down — cookie-authenticated mutations are forgeable on a production worker.
 *
 * `cookies-insecure`: `BETTER_AUTH_URL` is a plaintext `http://` origin on a non-dev worker, so session cookies cannot carry the `Secure` attribute and ride in cleartext.
 */
type SecurityFindingKind =
    | "admin-token-weak"
    | "auth-secret-weak"
    | "cookies-insecure"
    | "cors-wildcard-credentials"
    | "csrf-disabled"
    | "dev-args-unredacted"
    | "security-headers-disabled"
    | "ws-gate-open";

/**
 * One detected security issue. `detail` carries kind-specific context the studio
 * may interpolate into the localized copy (e.g. the offending token length);
 * absent when the kind needs none.
 */
interface SecurityFinding {
    detail?: Record<string, unknown>;
    kind: SecurityFindingKind;
    level: SecurityFindingLevel;
}

/** Payload of a `__lunora_admin__:getSecurityAudit` call: every detected finding, worst-first. */
interface SecurityAuditResult {
    findings: SecurityFinding[];
}

/**
 * Minimum `LUNORA_ADMIN_TOKEN` length considered safe against brute force. A
 * short token gates the studio's destructive admin ops (writeRow, clearTable,
 * pitrRestore, …), so a guessable one is a real exposure. 24 chars ≈ 128 bits
 * for a random base64-ish token.
 */
const MIN_ADMIN_TOKEN_LENGTH = 24;

/**
 * Minimum `AUTH_SECRET` / `BETTER_AUTH_SECRET` length. better-auth signs session
 * tokens with this secret; 32 chars (≈ `openssl rand -hex 32` → 32 bytes hex, or
 * 192 bits of base64) is the floor below which the signing key is brute-forceable.
 */
const MIN_AUTH_SECRET_LENGTH = 32;

/** error first, then warning, then info — so the worst findings sort to the top. */
const LEVEL_ORDER: Record<SecurityFindingLevel, number> = { error: 0, info: 2, warning: 1 };

/** Read a string env var, trimmed and lowercased, or `undefined` when absent/non-string. */
const readFlag = (value: unknown): string | undefined => (typeof value === "string" ? value.trim().toLowerCase() : undefined);

/**
 * Auth sessions are signed with `AUTH_SECRET` / `BETTER_AUTH_SECRET`; a short one
 * (set but under the floor) is brute-forceable. An *unset* secret is
 * `@lunora/auth`'s own startup concern, not a length finding here.
 */
const auditAuthSecret = (env: Record<string, unknown>): SecurityFinding[] => {
    const authSecret = env["AUTH_SECRET"] ?? env["BETTER_AUTH_SECRET"];
    // Measure after trimming so surrounding whitespace never inflates the length
    // — matches `@lunora/auth`'s own `isWeakSecret`, so audit and startup agree.
    const length = typeof authSecret === "string" ? authSecret.trim().length : 0;

    if (length > 0 && length < MIN_AUTH_SECRET_LENGTH) {
        return [{ detail: { length, min: MIN_AUTH_SECRET_LENGTH }, kind: "auth-secret-weak", level: "warning" }];
    }

    return [];
};

/**
 * A wildcard CORS origin paired with credentials: browsers reject it and it
 * defeats the allowlist. Set in code, the worker throws at construction; set via
 * these env vars, the worker honors the allowlist but silently drops credentials
 * to stay serving — so the operator's intent (credentialed cross-origin) is
 * quietly not met. This finding surfaces that mismatch on the live deployment.
 */
const auditCors = (env: Record<string, unknown>): SecurityFinding[] => {
    const allowedOrigins = readFlag(env["LUNORA_ALLOWED_ORIGINS"]);
    const corsCredentials = isEnvEnabled(env["LUNORA_CORS_ALLOW_CREDENTIALS"]);
    const hasWildcard = allowedOrigins?.split(",").some((entry) => entry.trim() === "*") ?? false;

    return hasWildcard && corsCredentials ? [{ kind: "cors-wildcard-credentials", level: "error" }] : [];
};

/**
 * The `LUNORA_SECURITY_*` opt-out vars relax the secure-by-default edge; in
 * production that drops real protections (and these mirror the same vars the
 * worker's `resolveSecurity` honors, so audit and runtime agree). A plaintext
 * `BETTER_AUTH_URL` likewise means session cookies cannot be `Secure`. On a dev
 * worker the relaxation is expected, so none of these are surfaced.
 */
const auditSecurityLayers = (env: Record<string, unknown>, dev: boolean): SecurityFinding[] => {
    if (dev) {
        return [];
    }

    const findings: SecurityFinding[] = [];

    if (isEnvDisabled(env["LUNORA_SECURITY_HEADERS"])) {
        findings.push({ kind: "security-headers-disabled", level: "warning" });
    }

    if (isEnvDisabled(env["LUNORA_SECURITY_CSRF"])) {
        findings.push({ kind: "csrf-disabled", level: "warning" });
    }

    if (readFlag(env["BETTER_AUTH_URL"])?.startsWith("http://") === true) {
        findings.push({ kind: "cookies-insecure", level: "warning" });
    }

    return findings;
};

/**
 * Audit the Worker `env` for deployment-level security misconfigurations the
 * Durable Object can observe directly. Pure and side-effect-free — same `env`,
 * same findings — so the rules unit-test without a live shard.
 *
 * This is the server half of the studio's **Security Advisor**: CF's dashboard
 * is infra-level and can't reason about lunora's admin/WS gates or its
 * request-log redaction policy, so these are signals only lunora can surface.
 * The audit is served behind the same admin gate as every other introspection
 * RPC, so it only runs once a `LUNORA_ADMIN_TOKEN` is configured — which is why
 * a *missing* token is never itself a finding here (introspection is simply off).
 */
const buildSecurityAudit = (rawEnv: unknown, options: { dev: boolean }): SecurityAuditResult => {
    const env = (rawEnv ?? {}) as Record<string, unknown>;
    const findings: SecurityFinding[] = [];

    const adminToken = env["LUNORA_ADMIN_TOKEN"];

    if (typeof adminToken === "string" && adminToken.length > 0 && adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
        findings.push({ detail: { length: adminToken.length, min: MIN_ADMIN_TOKEN_LENGTH }, kind: "admin-token-weak", level: "warning" });
    }

    const wsBearer = env["LUNORA_WS_BEARER"];
    const { dev } = options;

    if (typeof wsBearer !== "string" || wsBearer === "") {
        // Open live-subscription gate: a real exposure in production, expected
        // (and only informational) on a local dev worker.
        findings.push({ kind: "ws-gate-open", level: dev ? "info" : "error" });
    }

    if (dev) {
        // The request log keeps raw args/identity in dev (PLAN3 §3.3). Surfacing
        // it flags a production deploy that's been mislabeled dev.
        findings.push({ kind: "dev-args-unredacted", level: "warning" });
    }

    findings.push(...auditAuthSecret(env), ...auditCors(env), ...auditSecurityLayers(env, dev));

    return { findings: findings.toSorted((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) };
};

export { buildSecurityAudit, MIN_ADMIN_TOKEN_LENGTH, MIN_AUTH_SECRET_LENGTH };
export type { SecurityAuditResult, SecurityFinding, SecurityFindingKind, SecurityFindingLevel };
