import { constantTimeEqual } from "./constant-time-equal";

/**
 * Gate for an internal Durable Object's RPC surface: when `expected` is a
 * non-empty string the request must carry it, constant-time compared, in
 * `header`. An unset or empty `expected` admits every request — the secret is
 * opt-in so a deployment that has not provisioned one keeps working. Bundler-
 * inlined like `constant-time-equal.ts`; keep it zero-dependency.
 */
export const hasInternalSecret = (request: Request, header: string, expected: unknown): boolean => {
    if (typeof expected !== "string" || expected.length === 0) {
        return true;
    }

    const supplied = request.headers.get(header);

    return supplied !== null && supplied.length > 0 && constantTimeEqual(expected, supplied);
};

/** Header and env var guarding `ShardRegistryDO` (`@lunora/do`); the worker-side clients send the same secret. */
export const SHARD_REGISTRY_SECRET_HEADER = "x-lunora-shard-registry-do-secret";
export const SHARD_REGISTRY_SECRET_ENV = "SHARD_REGISTRY_DO_SECRET";

/** Header and env var guarding `EventLogDO` (`@lunora/replica`). */
export const EVENT_LOG_SECRET_HEADER = "x-lunora-event-log-do-secret";
export const EVENT_LOG_SECRET_ENV = "EVENT_LOG_DO_SECRET";
