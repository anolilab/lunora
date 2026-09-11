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
