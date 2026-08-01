import { useEffect, useRef, useState } from "react";

interface UseShardKeyResult {
    /** The debounced shard key an admin read/subscription should key on. */
    queryShardKey: string;
    /** Update the raw input value (per keystroke). */
    setShardKey: (value: string) => void;
    /** The raw, un-debounced input value — bind this to the `ShardInput`. */
    shardKey: string;
}

/**
 * Shard-key input state for an admin panel: the raw (per-keystroke) `shardKey`
 * plus a `queryShardKey` debounced by `delayMs` (400ms by default) so a read
 * or live subscription settles once the operator stops typing instead of
 * re-firing on every keystroke. Consolidates the
 * `useState` + `useDebounced(shardKey.trim(), 400)` preamble that was
 * copy-pasted across every Studio panel with a shard-key input.
 *
 * Debounces with its own `setTimeout` effect (mirroring `useDebounced`'s
 * shape) rather than composing `useDebounced` itself, so it can reset that
 * timer atomically with the state below — composing the two hooks would let
 * `useDebounced`'s still-old internal value win a render over this hook's own
 * synchronous reset.
 *
 * `initial` is tracked across renders, not just read once on mount. When the
 * CALLER's `initial` changes — the operator switches table/tab and the panel
 * re-seeds from a new URL/selection — that is a discrete reset, not a
 * keystroke that should settle: `queryShardKey` snaps to the new value
 * immediately (synchronously, during render — no `useEffect` round trip, so
 * there is no flash of the stale value) rather than waiting out the debounce.
 * Without this, a switch kept `queryShardKey` pointed at the PREVIOUS shard
 * for up to `delayMs`, so a query/subscription keyed on it kept reading (and
 * the view kept showing) the previous shard's data until the debounce caught
 * up. Typing into the input via `setShardKey` still debounces normally.
 */
const useShardKey = (initial: string | undefined, delayMs = 400): UseShardKeyResult => {
    const seed = (initial ?? "").trim();

    const [shardKey, setShardKeyState] = useState<string>(seed);
    const [queryShardKey, setQueryShardKey] = useState<string>(seed);

    // The `initial` this hook is currently seeded from — compared against the
    // live `initial` argument below so a change is caught exactly once per
    // transition. Calling both setters here is React's sanctioned "adjust
    // state while rendering" pattern: it discards this in-progress render and
    // immediately restarts the component function with the new state, so
    // `shardKey`/`queryShardKey` are already settled by the time this render
    // commits — no extra frame, no flash of the stale shard.
    const seededFromRef = useRef(initial);

    if (seededFromRef.current !== initial) {
        seededFromRef.current = initial;
        setShardKeyState(seed);
        setQueryShardKey(seed);
    }

    const trimmed = shardKey.trim();

    // Settles `queryShardKey` onto `trimmed` after `delayMs` of no further
    // edits. The reset above changes `shardKey` in the same render restart, so
    // this effect's dependency already reflects the reset — it only ever
    // re-confirms the (already-set) reset value, never overwrites it with a
    // stale one.
    useEffect(() => {
        const id = setTimeout(() => {
            setQueryShardKey(trimmed);
        }, delayMs);

        return () => {
            clearTimeout(id);
        };
    }, [trimmed, delayMs]);

    const setShardKey = (value: string): void => {
        setShardKeyState(value);
    };

    return { queryShardKey, setShardKey, shardKey };
};

export { useShardKey };
export type { UseShardKeyResult };
