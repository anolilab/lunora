/**
 * Deploy pacing per target (MULTIPLATFORM.md Phase 1 deviation, closed): every
 * converge runs on the {@link ConvergeScheduler} of the budget it spends, which
 * is where its target places it (`TARGETS[target].placedOn`):
 *
 * - `cell` (`cloudflare-wfp`) spends the cell's own Cloudflare account — ONE
 *   scheduler, key `platform`, over Cloudflare's 1,200-requests-per-5-minutes
 *   budget, six at a time: exactly the pacing every converge had before targets.
 * - `account` (`cloudflare-workers`) spends the CONNECTED account's budget, not
 *   ours — one scheduler per Cloudflare account (`account:{accountId}`, so two
 *   organizations that connected the same account share its limit, as
 *   Cloudflare counts it), with that account's own bucket.
 * - `box` (`celld-vps`) spends no API at all. A box's session refuses a job past
 *   its in-flight cap (`BOX_BUSY`), so converges are queued per box
 *   (`box:{id}`), {@link BOX_CONVERGE_CONCURRENCY} at a time, and are never
 *   held behind a Cloudflare budget.
 *
 * The key past the kind is the host's `paceKey` (`PLACEMENT_HOSTS`).
 *
 * One pacer lives per Worker isolate (the router builds it once), like the
 * single scheduler it replaces. Schedulers of other budgets are dropped again
 * once idle — nothing queued or running, the bucket refilled — so a long-lived
 * isolate does not keep one per box it ever deployed to.
 */
import type { PlacedOn, Placement } from "../targets/placement";
import { hostsOf, placedOnOf } from "../targets/placement";
import { ConvergeScheduler } from "./scheduler";
import { cloudflareAccountBudget } from "./token-bucket";

/** Converges one Cloudflare account runs at once — the platform cell's, and each connected account's. */
export const ACCOUNT_CONVERGE_CONCURRENCY = 6;

/**
 * Converges one box runs at once. Well under the session's in-flight cap
 * (`MAX_JOBS_IN_FLIGHT`, 16), so destroys, diagnoses and upgrades still find a
 * slot while a burst of deploys queues here instead of failing `BOX_BUSY`.
 */
export const BOX_CONVERGE_CONCURRENCY = 4;

/** Idle schedulers are swept once the pacer holds more than this many. */
const PRUNE_ABOVE = 64;

/** Which budget a converge spends: its key, and what paces it. */
export interface Pacing {
    /** The kind of budget — the placement's `placedOn`. */
    budget: PlacedOn;
    /** One scheduler per key: `platform`, `account:{cloudflare account id}` or `box:{box id}`. */
    key: string;
}

/** The budget a converge for `placement` spends (see the module comment). */
export const pacingOf = (placement: Placement): Pacing => {
    if (!("host" in placement)) {
        return { budget: "cell", key: "platform" };
    }

    const budget = placedOnOf(placement.target);

    return { budget, key: `${budget}:${hostsOf(placement.target).paceKey(placement.host)}` };
};

/** Picks the scheduler a converge runs on. */
export interface DeployPacer {
    /** The scheduler of the budget a converge for `placement` spends. */
    schedulerFor: (placement: Placement) => ConvergeScheduler;
}

/** The pacer. `now` / `sleep` are injectable so pacing is deterministic in tests. */
export const createDeployPacer = (options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): DeployPacer => {
    const now = options.now ?? Date.now;
    const schedulers = new Map<string, ConvergeScheduler>();

    const build = ({ budget }: Pacing): ConvergeScheduler =>
        budget === "box"
            ? new ConvergeScheduler({ maxConcurrent: BOX_CONVERGE_CONCURRENCY, now, ...(options.sleep ? { sleep: options.sleep } : {}) })
            : new ConvergeScheduler({
                  bucket: cloudflareAccountBudget(now),
                  maxConcurrent: ACCOUNT_CONVERGE_CONCURRENCY,
                  now,
                  ...(options.sleep ? { sleep: options.sleep } : {}),
              });

    const prune = (): void => {
        const at = now();

        for (const [key, scheduler] of schedulers) {
            // The platform's scheduler is the one budget every cell converge shares; it is never dropped.
            if (key !== "platform" && scheduler.idle(at)) {
                schedulers.delete(key);
            }
        }
    };

    return {
        schedulerFor: (placement) => {
            const pacing = pacingOf(placement);
            const existing = schedulers.get(pacing.key);

            if (existing !== undefined) {
                return existing;
            }

            if (schedulers.size >= PRUNE_ABOVE) {
                prune();
            }

            const scheduler = build(pacing);

            schedulers.set(pacing.key, scheduler);

            return scheduler;
        },
    };
};
