/**
 * One `ctx.notify` / `ctx.push` send discovered lexically inside a `query(...)`
 * or `mutation(...)` handler body — the input the `notify_send_outside_action`
 * lint consumes. Produced by the codegen feeder, which walks each exported
 * function's handler with ts-morph and records the `@lunora/notify` send surface
 * (`ctx.notify.send`, `ctx.notify.chat/inApp/webhook`, `ctx.push.send`,
 * `ctx.push.broadcast`).
 *
 * A notification send is external I/O (a `fetch` to a push service / FCM): it is
 * non-deterministic like `fetch`, so it breaks the determinism the coordinator
 * relies on when re-running a query on subscription re-evaluation or a mutation on
 * OCC retry (a retried mutation would re-send). It therefore belongs **only** in
 * `action(...)` handlers. Calls inside `action(...)` are intentionally **not**
 * recorded — actions are the escape hatch. Runtime callers don't supply this, so
 * the lint finds nothing there.
 */
export interface AdvisorNotifyCall {
    /** The send surface accessed, e.g. `ctx.push.broadcast` / `ctx.notify.send`. */
    callee: string;
    /** The exported function performing the send (e.g. `sendWelcome`). */
    exportName: string;
    /** Source file the send appears in (relative to the lunora dir, no extension). */
    file: string;
    /** Which procedure kind the send lives in — only `query`/`mutation` are flagged; actions are exempt. */
    kind: "mutation" | "query";
    /** 1-based line of the send, or `0` when unknown. */
    line: number;
}

/**
 * Whether an app uses `ctx.push` and which push channels `defineNotify(...)`
 * configures — the input the `notify_missing_push_config` lint consumes. Produced
 * by the codegen feeder from the resolved `lunora/notify.ts` definition and the
 * discovered `ctx.push` usage; absent for runtime callers.
 */
export interface AdvisorNotifyConfig {
    /** Whether `defineNotify` wired the FCM channel. */
    hasFcm: boolean;
    /** Whether `defineNotify` wired the Web Push channel. */
    hasWebPush: boolean;
    /** Whether any handler sends a push (`ctx.push.send` / `ctx.push.broadcast`). */
    usesPush: boolean;
}
