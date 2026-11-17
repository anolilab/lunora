/**
 * One literal `allowUnauthenticatedShardAccess: true` in an app's source — the
 * input the `open_shard_access` lint consumes. Supplied by `lunora deploy`, which
 * scans the project before shipping; codegen and runtime callers don't supply it,
 * so the lint finds nothing there.
 */
export interface AdvisorOpenShardAccess {
    /** Source file relative to the project root. */
    file: string;
    /** 1-based line of the property. */
    line: number;
}
