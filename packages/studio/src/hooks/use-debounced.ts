import { useEffect, useState } from "react";

/**
 * Debounced mirror of `value`: returns the latest value only after it has been
 * stable for `delayMs`. Used so a per-keystroke search box drives at most one
 * server round-trip per pause, instead of one request per character.
 *
 * `resetKey` is an optional escape hatch from the trailing delay: when it
 * changes relative to the PREVIOUS call, the mirror snaps to `value`
 * immediately — no `delayMs` window at all. It exists for callers that key a
 * debounced input (a search box, a shard key) to a coarser identity (e.g. the
 * open table): on that identity's change the caller usually re-seeds `value`
 * itself in the same render, and without `resetKey` the debounced mirror would
 * still trail the OLD value behind its own timer for up to `delayMs`, ignoring
 * the reseed. The snap happens render-time (the "adjusting state when a prop
 * changes" pattern): calling the setters below makes React discard this render
 * and retry synchronously with the caught-up state, so the returned value is
 * already correct on the render that reads it — no extra commit, no trailing
 * window. Omit `resetKey` (the default) to keep the original always-debounced
 * behavior; every other caller in the codebase does this.
 */
const useDebounced = function <T>(value: T, delayMs = 300, resetKey?: unknown): T {
    const [debounced, setDebounced] = useState<T>(value);
    const [seededResetKey, setSeededResetKey] = useState<unknown>(resetKey);

    if (resetKey !== undefined && resetKey !== seededResetKey) {
        setSeededResetKey(resetKey);
        setDebounced(value);
    }

    useEffect(() => {
        const id = setTimeout(() => {
            setDebounced(value);
        }, delayMs);

        return () => {
            clearTimeout(id);
        };
    }, [value, delayMs]);

    return debounced;
};

export default useDebounced;
