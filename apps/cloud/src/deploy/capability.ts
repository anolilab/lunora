/**
 * The scoped-key capability check, as one pure predicate.
 *
 * An `ingest`-capability deploy key is telemetry-only: it authorizes the OTLP
 * ingest paths (via `authorizeTelemetryKey`) but must be rejected by every
 * deploy/admin path — so the ingest token the platform injects into every tenant
 * can never be used to ship code. Both the deploy entrypoint (`deploy_keys.verify`)
 * and the per-mutation gate (`authorizeDeployKey`) call this, so the two can never
 * disagree on what "may deploy" means.
 */

/** True when a key may authorize a deploy/admin action (i.e. it is NOT an ingest-only key). */
export const isDeployCapable = (row: { capability?: "deploy" | "ingest" }): boolean => row.capability !== "ingest";

/**
 * True when a key may authorize anything at all at `now`: not revoked, and not
 * past its `expiresAt` deadline (set only on platform-minted release keys). Every
 * path that resolves a key by hash calls this, so revocation and expiry can never
 * be honoured on one path and missed on another.
 */
export const isKeyLive = (row: { expiresAt?: number; revokedAt?: number }, now: number): boolean =>
    row.revokedAt == null && (row.expiresAt == null || row.expiresAt > now);
