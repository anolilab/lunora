/**
 * Dispatch-namespace tail worker (GAPS.md B2 — the missing producer). Attached
 * as a `tail_consumer` of the tenant scripts in the `lunora-production` dispatch
 * namespace, it receives every tenant worker's console output, decodes the
 * `ctx.log` events (`{ source: "lunora", type: "log" }`) via `parse.ts`, groups
 * them per script, and forwards the batches to the control plane's platform
 * ingest (`POST /v1/logs/tail`) over a shared secret. The control plane resolves
 * each `scriptName` → org (`logs.orgForScript`) and stores the lines.
 *
 * Holds a single platform secret (`LUNORA_TAIL_SECRET`), not per-org deploy keys
 * — the whole point of routing through `/v1/logs/tail` rather than the deploy-key
 * `logs.ingest`. Best-effort and fail-open: a missing binding is a no-op, and a
 * refused POST is retried once when transient, then logged here rather than
 * thrown, so tail delivery never back-pressures the tenant workers.
 *
 * Deploy: this is its own worker (`tail.wrangler.jsonc`); the `cloudflare-wfp`
 * driver (its `logs` source) sets `tail_consumers` on each tenant script (or the namespace) to point at it. The
 * control-plane URL/secret ride the tail worker's `env`.
 */
import type { TailTraceItem } from "./parse";
import { groupTailEvents } from "./parse";

/** Minimal `ExecutionContext` projection — only `waitUntil`, so no `@cloudflare/workers-types` edge. */
interface TailContext {
    waitUntil: (promise: Promise<unknown>) => void;
}

/** The tail worker's bindings (all optional so an unconfigured deploy is an inert no-op). */
interface TailEnv {
    /** Base URL of the control-plane worker, e.g. `https://cloud.lunora.sh`. */
    LUNORA_CONTROL_PLANE_URL?: string;
    /** Shared secret the `/v1/logs/tail` route checks (`x-lunora-tail-secret`). */
    LUNORA_TAIL_SECRET?: string;
}

/** Strip trailing slashes without a regex (ReDoS-linter-safe; runs once per flush). */
const trimTrailingSlash = (base: string): string => {
    let url = base;

    while (url.endsWith("/")) {
        url = url.slice(0, -1);
    }

    return url;
};

/**
 * Forward one grouped tail batch to the control plane, or do nothing when tail
 * streaming isn't configured. Returns the in-flight send for `waitUntil`, or nothing when there was
 * nothing to send.
 *
 * Separated from the handler so the handler stays a few lines: the contract is a
 * promise-returning `tail`, but nothing here is awaited — delivery runs under
 * `waitUntil` so a flaky control plane never back-pressures a tailed tenant
 * worker.
 */
const forwardTailBatches = (events: TailTraceItem[], environment: TailEnv): Promise<void> | undefined => {
    const batches = groupTailEvents(events);

    if (batches.length === 0) {
        return undefined;
    }

    const base = environment.LUNORA_CONTROL_PLANE_URL;
    const secret = environment.LUNORA_TAIL_SECRET;

    // Unconfigured (local dev, a cell without log streaming) → inert no-op.
    if (base === undefined || base === "" || secret === undefined || secret === "") {
        return undefined;
    }

    const url = `${trimTrailingSlash(base)}/v1/logs/tail`;
    const init = { body: JSON.stringify({ batches }), headers: { "content-type": "application/json", "x-lunora-tail-secret": secret }, method: "POST" };
    // A network error, 429 or 5xx means the route stored nothing (it counts a failing batch
    // in `failed` and answers 200), so one more try cannot duplicate lines. A sync `fetch`
    // throw (a malformed URL) lands in the same catch.
    const send = async (): Promise<Error | Response> => {
        try {
            return await fetch(url, init);
        } catch (error) {
            return error instanceof Error ? error : new Error(String(error));
        }
    };
    const retryable = (outcome: Error | Response): boolean => outcome instanceof Error || outcome.status === 429 || outcome.status >= 500;

    // Never rejects, so nothing surfaces to (or back-pressures) the tailed tenant
    // workers. A tail invocation cannot be replayed, so a loss is only written to this
    // worker's own logs, where an operator can see the ingest is refusing.
    return (async () => {
        let outcome = await send();

        if (retryable(outcome)) {
            outcome = await send();
        }

        const lost = (reason: string): void => {
            // eslint-disable-next-line no-console -- the tail worker's own Workers Logs are the only place a lost flush can be seen
            console.error("[tail]", `log lines of ${String(batches.length)} batches not stored: ${reason}`);
        };

        if (outcome instanceof Error) {
            lost(outcome.message);

            return;
        }

        if (!outcome.ok) {
            lost(`HTTP ${String(outcome.status)}`);

            return;
        }

        const summary = (await outcome.json().catch(() => undefined)) as undefined | { failed?: unknown };

        if (typeof summary?.failed === "number" && summary.failed > 0) {
            // eslint-disable-next-line no-console -- as above
            console.error("[tail]", `${String(summary.failed)} of ${String(batches.length)} log batches were refused by the ingest`);
        }
    })();
};

export default {
    tail(events: TailTraceItem[], environment: TailEnv, context: TailContext): Promise<void> {
        const sent = forwardTailBatches(events, environment);

        if (sent !== undefined) {
            context.waitUntil(sent);
        }

        return Promise.resolve();
    },
};
