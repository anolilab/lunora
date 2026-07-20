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
 * `logs.ingest`. Best-effort and fail-open: a missing binding or a rejected POST
 * is swallowed so tail delivery never back-pressures the tenant workers.
 *
 * Deploy: this is its own worker (`tail.wrangler.jsonc`); the provisioner sets
 * `tail_consumers` on each tenant script (or the namespace) to point at it. The
 * control-plane URL/secret ride the tail worker's `env`.
 */
import { groupTailEvents } from "./parse";
import type { TailTraceItem } from "./parse";

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

export default {
    async tail(events: TailTraceItem[], environment: TailEnv, context: TailContext): Promise<void> {
        const batches = groupTailEvents(events);

        if (batches.length === 0) {
            return;
        }

        const base = environment.LUNORA_CONTROL_PLANE_URL;
        const secret = environment.LUNORA_TAIL_SECRET;

        // Unconfigured (local dev, a cell without log streaming) → inert no-op.
        if (base === undefined || base === "" || secret === undefined || secret === "") {
            return;
        }

        try {
            // `.catch` swallows any rejection so a flaky control plane never
            // surfaces to (or back-pressures) the tailed tenant workers.
            const sent = fetch(`${trimTrailingSlash(base)}/v1/logs/tail`, {
                body: JSON.stringify({ batches }),
                headers: { "content-type": "application/json", "x-lunora-tail-secret": secret },
                method: "POST",
            }).catch(() => {
                // Delivery error — intentionally ignored.
            });

            context.waitUntil(sent);
        } catch {
            // `fetch` throwing synchronously (e.g. a malformed URL) must not break tail delivery.
        }
    },
};
