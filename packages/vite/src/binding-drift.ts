import type { DiscoveryCache } from "@lunora/config";
import { LUNORA_TAG } from "@lunora/config";
import type { ReconcileProject } from "@lunora/config/cloudflare";
import { pendingBindingChanges } from "@lunora/config/cloudflare";

/**
 * How long the sources must stay unsaved before they are scanned for new
 * bindings. Longer than an editor's autosave delay (VS Code's `afterDelay` is
 * 1 s), so typing `defineQueue("orders")` is scanned once, at `"orders"`, rather
 * than once per prefix.
 */
const BINDING_DRIFT_SETTLE_MS = 2000;

/** Starts a timer for `run` (which never rejects) and answers its cancel. */
type Schedule = (run: () => Promise<void>, ms: number) => () => void;

interface BindingDriftNotifierOptions {
    /** Memo for the scan; cleared on every save, because a save moves the sources it memoises. */
    cache: DiscoveryCache;

    /** True while nothing should be said: a restart is provisioning, or the server is gone. */
    isSuppressed: () => boolean;

    /** Injection seam; defaults to the real scan. */
    pending?: typeof pendingBindingChanges;

    project: Omit<ReconcileProject, "cache">;

    /** Injection seam; defaults to `setTimeout`. */
    schedule?: Schedule;

    warn: (message: string) => void;
}

interface BindingDriftNotifier {
    /** Scan now and warn about anything new; what the settle timer runs. */
    check: () => Promise<void>;
    /** Cancel a scan the last save scheduled. */
    dispose: () => void;
    /** A save landed: restart the settle window. */
    noteSave: () => void;
}

const defaultSchedule: Schedule = (run, ms) => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- resolve-only by contract: `run` never rejects
    const timer = setTimeout(run, ms);

    return () => {
        clearTimeout(timer);
    };
};

/**
 * Tell the developer when a save makes the sources imply a binding the running
 * worker was not started with. Bindings are provisioned once per dev start (a
 * `wrangler.jsonc` write restarts the server and every open socket with it), so
 * without this a save that declares a queue or reads `ctx.kv` fails at request
 * time on an undefined binding.
 *
 * One line per change of the pending set, listing all of it, and only when the
 * set gained a label since it was last announced: a label that went away (a
 * half-typed queue name) is dropped from the next line rather than repeated.
 */
const createBindingDriftNotifier = (options: BindingDriftNotifierOptions): BindingDriftNotifier => {
    const pending = options.pending ?? pendingBindingChanges;
    const schedule = options.schedule ?? defaultSchedule;
    let announced = new Set<string>();
    let cancel: (() => void) | undefined;

    const check = async (): Promise<void> => {
        cancel = undefined;

        if (options.isSuppressed()) {
            return;
        }

        const changes = await pending({ ...options.project, cache: options.cache });

        // The scan takes long enough for a restart to start, or the server to close, under it.
        if (options.isSuppressed()) {
            return;
        }

        const news = changes.filter((label) => !announced.has(label));

        announced = new Set(changes);

        if (news.length === 0) {
            return;
        }

        options.warn(
            `${LUNORA_TAG} ${changes.join(", ")} — not in the running worker yet. Restart the dev server to write ${changes.length === 1 ? "it" : "them"} to the wrangler config.`,
        );
    };

    return {
        check,
        dispose: () => {
            cancel?.();
            cancel = undefined;
        },
        noteSave: () => {
            options.cache.clear();
            cancel?.();
            // `check` never rejects: `pendingBindingChanges` answers `[]` on any failure.
            cancel = schedule(check, BINDING_DRIFT_SETTLE_MS);
        },
    };
};

export type { BindingDriftNotifier, BindingDriftNotifierOptions };
export { BINDING_DRIFT_SETTLE_MS, createBindingDriftNotifier };
