/**
 * One `rateLimit`/`dbRateLimit` middleware call (`@lunora/ratelimit`) whose
 * `key` selector is derived from the handler's `args` with no server-side
 * scoping — the `ratelimit_key_spoofable_or_global` lint input.
 */
export interface AdvisorRatelimitKeySelector {
    callee: string;
    exportName: string;
    file: string;
    limitName: string;
    line: number;
}
