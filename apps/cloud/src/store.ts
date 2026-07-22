/**
 * The minimal structural view of the control-plane store the scheduled sweeps
 * and their port-builders read/write — the `.global()` D1 ctx-db, narrowed to
 * the three methods they use. A neutral home (not under `deploy/`), since
 * billing, telemetry, uptime, and deploy all depend on it.
 */
export interface ControlPlaneDb {
    findMany: (
        table: string,
        // `limit`/`orderBy` are pass-throughs the underlying ctx-db already honors
        // (the alert sweep bounds its recent-observation read with them); the
        // teardown/usage sweeps pass only `where`.
        args?: { limit?: number; orderBy?: Record<string, "asc" | "desc">[]; where?: Record<string, unknown> },
    ) => Promise<{ page: unknown[] }>;
    insert: (table: string, document: Record<string, unknown>) => Promise<unknown>;
    patch: (id: string, patch: Record<string, unknown>, table?: string) => Promise<unknown>;
}
