import { useEffect, useRef, useState } from "react";

import { fireAndForget } from "./internal";
import useDebounced from "./use-debounced";

/**
 * The shard-seed protocol every shard-scoped admin panel shares (metrics,
 * function-stats, audit, logs, migrations) — the one piece that must behave
 * identically everywhere, replacing both the deleted `useLiveToggle` and the
 * per-panel Refresh button. It debounces the live shard-key input (so typing
 * re-loads once it settles); runs the panel's one-shot `seed(shard)` when the
 * debounced value — or any `extraDeps`, e.g. the logs panel's view/filters —
 * changes; and **commits** the shard the always-on live channel keys on only
 * after that seed resolves successfully, and only for the latest non-superseded
 * value (a newer shard cancels an in-flight older one, so a slow load can't
 * commit a stale shard nor strand the panel on the old one with no Refresh).
 *
 * Returns `committedShard` to feed `useLiveAdmin` (subscribe to `committedShard
 * ?? ""`, enabled `committedShard !== undefined`). The panel's `seed` must fetch
 * + apply its own state and **throw on failure** so a failed load doesn't commit
 * its shard; it must not touch the committed shard itself. The live-unavailable
 * notice stays panel-local (panels set it from their own value/error sinks).
 */
const useLiveShardSeed = (shardKey: string, seed: (shard: string) => Promise<void>, extraDeps: ReadonlyArray<unknown> = []): string | undefined => {
    const [committedShard, setCommittedShard] = useState<string | undefined>(undefined);
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    // Hold the latest seed in a ref so a fresh closure each render doesn't re-fire
    // the effect; only the debounced shard / extra deps drive a re-seed.
    const seedRef = useRef(seed);

    useEffect(() => {
        seedRef.current = seed;
    });

    useEffect(() => {
        // A mutable flag (object property, so TS doesn't narrow it to a constant
        // across the async closure) the cleanup flips when a newer shard supersedes
        // this load or the panel unmounts.
        const live = { current: true };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await seedRef.current(debouncedShard);

                    // Commit only the latest, still-current shard: a slow older load
                    // can't re-target the live channel to a stale shard.
                    if (live.current) {
                        setCommittedShard(debouncedShard);
                    }
                } catch {
                    // The seed owns its own error state; leave the committed shard as-is.
                }
            })(),
        );

        return () => {
            live.current = false;
        };
        // `seed` is read through `seedRef`; re-seed on the shard or any panel dep.
    }, [debouncedShard, ...extraDeps]);

    return committedShard;
};

export default useLiveShardSeed;
