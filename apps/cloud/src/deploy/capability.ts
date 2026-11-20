import type { DeployKind } from "../provision-contract";

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
export const isDeployCapable = (row: { capability?: "deploy" | "ingest" | null }): boolean => row.capability !== "ingest";

/**
 * True when a key may authorize anything at all at `now`: not revoked, and not
 * past its `expiresAt` deadline (set only on platform-minted release keys). Every
 * path that resolves a key by hash calls this, so revocation and expiry can never
 * be honoured on one path and missed on another.
 */
export const isKeyLive = (row: { expiresAt?: null | number; revokedAt?: null | number }, now: number): boolean =>
    row.revokedAt == null && (row.expiresAt == null || row.expiresAt > now);

/**
 * Deploy kinds ordered by privilege, least to most.
 *
 * `production` is the only one that can move a project's stable URL, so it sits
 * at the top; a key scoped to a lower rung may act at or below its own.
 */
const DEPLOY_RANK: Record<DeployKind, number> = { dev: 0, preview: 1, production: 2 };

/** Whether a deployment of kind `requested` is within the ceiling of a key typed `allowed`. */
export const deployKindWithin = (requested: DeployKind, allowed: DeployKind): boolean => DEPLOY_RANK[requested] <= DEPLOY_RANK[allowed];
