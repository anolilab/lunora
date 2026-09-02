import { LUNORA_TAG } from "./log";

/** How long a burst of saves is coalesced into one regeneration. */
const DEBOUNCE_MS = 100;

/**
 * How long after a `postcodegen` run the watcher ignores schema-directory
 * changes.
 *
 * `runCodegen` only writes `_generated/`, which the watcher already skips, so
 * regeneration could never retrigger itself. A `postcodegen` script is arbitrary
 * project code run at the project root, though, and anything it touches under
 * the schema directory looks exactly like a developer's save — regenerate, run
 * the hook, repeat, for as long as the dev server is up. The CLI's own watch loop
 * carries the same guard for the same reason.
 */
const HOOK_SETTLE_MS = 300;

/**
 * How many times in a row a settle-window recheck may rerun codegen before it
 * gives up and says why.
 *
 * The recheck reruns when the schema sources changed across a hook run, which
 * converges for any idempotent `postcodegen` (a formatter reaches a fixed point
 * on its second pass). A hook that rewrites a schema-directory file to DIFFERENT
 * bytes every run — a timestamp, a generated id — never would, so cap it rather
 * than hand the dev loop back the spin the settle window exists to prevent.
 */
const MAX_SETTLE_RERUNS = 2;

interface RegenerateSchedulerOptions {
    /**
     * Re-read the content hash of the schema sources, compared against the one
     * the last run reported consuming. Late-bound (not a value) because the generated
     * directory it excludes is only known after codegen has emitted.
     */
    fingerprint: () => string;

    logger: { info: (message: string) => void; warn: (message: string) => void };

    /**
     * Run one regeneration for `changedFile`, calling `onHookSettled` with the
     * fingerprint of the sources it consumed if — and only if — a `postcodegen`
     * actually ran. Must never reject.
     */
    regenerate: (changedFile: string, onHookSettled: (consumedSources: string) => void) => void;
}

/**
 * The dev watcher's two timers and the budget that bounds them.
 *
 * Pulled out of `configureServer` because the three pieces of state are only
 * meaningful together: the debounce that coalesces a burst of saves, the recheck
 * that compensates for the events the hook's settle window drops, and the rerun
 * counter that stops a non-idempotent hook from spinning the pair forever. They
 * are also the only state in that hook with a lifetime — hence `dispose`.
 */
const createRegenerateScheduler = (
    options: RegenerateSchedulerOptions,
): {
    cancelPending: () => void;
    dispose: () => void;
    onSave: (changedFile: string) => void;
} => {
    // Per-server-generation. Scoped to one scheduler (not the plugin factory) so
    // a `server.restart()` — which configures the NEW server before closing the
    // OLD one — can't have the old server's teardown cancel a codegen run the new
    // server just armed.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // Armed after a `postcodegen` run to re-examine the schema sources once its
    // settle window has passed. Its own timer, NOT `debounceTimer`: the drop path
    // clears that one, which would cancel exactly the recheck meant to recover
    // the dropped save.
    let settleRecheckTimer: ReturnType<typeof setTimeout> | undefined;

    // Consecutive recheck-driven reruns, reset by any real save. See
    // MAX_SETTLE_RERUNS.
    let settleReruns = 0;

    const cancelPending = (): void => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
        }
    };

    /**
     * Re-examine the sources once a hook's settle window closes — the compensation
     * for the events the watcher discarded for the hook's whole (possibly
     * multi-second) duration. A developer's save in that window changed them; the
     * hook's own writes did not (or rewrote the same bytes), so this reruns for the
     * first and stays silent for the second. Without it the save was dropped with
     * no log and no rerun, leaving `_generated/` behind `schema.ts` until the
     * developer happened to save again.
     */
    const armSettleRecheck = (consumedSources: string, rerun: () => void): void => {
        if (settleRecheckTimer) {
            clearTimeout(settleRecheckTimer);
        }

        settleRecheckTimer = setTimeout(() => {
            settleRecheckTimer = undefined;

            if (options.fingerprint() === consumedSources) {
                return;
            }

            settleReruns += 1;

            if (settleReruns > MAX_SETTLE_RERUNS) {
                options.logger.warn(
                    `${LUNORA_TAG} \`postcodegen\` keeps rewriting the schema sources — stopping after ${String(MAX_SETTLE_RERUNS)} reruns. Make the hook idempotent or move it off the schema directory.`,
                );

                return;
            }

            options.logger.info(`${LUNORA_TAG} schema changed while \`postcodegen\` was running — regenerating`);

            rerun();
        }, HOOK_SETTLE_MS);
    };

    /** One regeneration, with the recheck it may arm wired back into this scheduler. */
    const fire = (changedFile: string): void => {
        options.regenerate(changedFile, (consumedSources) => {
            armSettleRecheck(consumedSources, () => {
                fire(changedFile);
            });
        });
    };

    return {
        /**
         * Drop a debounce an earlier event already scheduled — the settle window's
         * drop path, where the hook's own first write would otherwise still land a
         * queued rerun. Leaves the recheck armed.
         */
        cancelPending,

        dispose: (): void => {
            cancelPending();

            if (settleRecheckTimer) {
                clearTimeout(settleRecheckTimer);
                settleRecheckTimer = undefined;
            }
        },

        /** A real developer save: coalesce the burst, and start the runaway-hook budget over. */
        onSave: (changedFile: string): void => {
            cancelPending();

            settleReruns = 0;

            debounceTimer = setTimeout(() => {
                debounceTimer = undefined;

                fire(changedFile);
            }, DEBOUNCE_MS);
        },
    };
};

export type { RegenerateSchedulerOptions };
export { createRegenerateScheduler, HOOK_SETTLE_MS, MAX_SETTLE_RERUNS };
