/**
 * Who a discovered call site runs on behalf of — the attribution every
 * per-call-site feeder row carries. Structurally identical to codegen's
 * `CallSiteScope`, so the feeder passes its rows straight through.
 *
 * `export`: inside an exported declaration; `name` is the exported name.
 *
 * `helper`: inside a top-level, non-exported helper of the same file; `callers`
 * are the exports reaching it (sorted), empty for an orphan helper.
 *
 * `module`: at module scope.
 */
export type AdvisorCallSiteScope = { callers: ReadonlyArray<string>; kind: "helper"; name: string } | { kind: "export"; name: string } | { kind: "module" };
