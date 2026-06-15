import { isDevEnvironment } from "./settings";

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
 */
type SecurityFindingKind = "admin-token-weak" | "dev-args-unredacted" | "ws-gate-open";

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

/** error first, then warning, then info — so the worst findings sort to the top. */
const LEVEL_ORDER: Record<SecurityFindingLevel, number> = { error: 0, info: 2, warning: 1 };

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
const buildSecurityAudit = (rawEnv: unknown): SecurityAuditResult => {
    const env = (rawEnv ?? {}) as Record<string, unknown>;
    const findings: SecurityFinding[] = [];

    const adminToken = env["LUNORA_ADMIN_TOKEN"];

    if (typeof adminToken === "string" && adminToken.length > 0 && adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
        findings.push({ detail: { length: adminToken.length, min: MIN_ADMIN_TOKEN_LENGTH }, kind: "admin-token-weak", level: "warning" });
    }

    const wsBearer = env["LUNORA_WS_BEARER"];
    const dev = isDevEnvironment(env);

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

    return { findings: findings.toSorted((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) };
};

export { buildSecurityAudit, MIN_ADMIN_TOKEN_LENGTH };
export type { SecurityAuditResult, SecurityFinding, SecurityFindingKind, SecurityFindingLevel };
