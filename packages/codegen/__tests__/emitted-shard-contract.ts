/**
 * A compile-time contract for the shard subclass `emitShard` generates.
 *
 * **Why this file exists.** The emitter produces TypeScript as a *string*, and
 * every test around it asserts on substrings of that string. Nothing compiles
 * it. So the generated code can reference a base-class member that a subclass
 * cannot legally touch, and the whole suite stays green — which is exactly what
 * happened: the external-source poll loop emitted `this.logs.push(...)` against
 * a `private logs`, so every project declaring a `.source()` table emitted a
 * shard that failed `tsc`. No fixture or example declares one, so nobody ran
 * into it.
 *
 * Golden fixtures cannot close that gap: `tsconfig.json` deliberately excludes
 * `__tests__/fixtures/**`, because generated output only type-checks inside a
 * whole app (its schema, its `_generated` siblings, its bindings). This file is
 * the cheap half of the job — it mirrors the base-class surface the emitted
 * shard depends on, in a real subclass, so `lint:types` fails HERE, in the
 * package that owns the emitter, the moment one of those members changes
 * visibility or signature.
 *
 * It is not a test and is never executed. Keeping it honest is a two-part
 * contract with `emit-external-source.test.ts`, which asserts the emitted text
 * really does call these members (and really does not touch `this.logs`):
 * this file proves the calls compile, that one proves they are the calls made.
 *
 * When the emitter starts using a new base member, add it here.
 */
import type { TraceRefLike } from "@lunora/do";
import { ShardDO } from "@lunora/do";
import { flushDeferredDeletes } from "@lunora/server";

class EmittedShardContract extends ShardDO {
    public override async handleRpc(): Promise<unknown> {
        // Mirrors the shape of the emitted mutation branch, so the flush below is
        // reached from a real dispatch signature rather than sitting unreferenced.
        await this.flushDeferredStorageDeletes({});

        return undefined;
    }

    /**
     * Mirrors the `hasSourcedTables` branch of the generated shard: the override
     * signature, and every base member its poll loop touches.
     */
    protected override async pollExternalSources(trace?: TraceRefLike): Promise<number | undefined> {
        await Promise.resolve();

        const shardKey = this.currentShardKey();

        this.alarmHeadroom();
        this.recordChangedTable("documents");

        // The two contained-failure seams. `recordExternalSourceWarning` exists
        // precisely so this loop never has to reach for the private log ring.
        this.recordExternalSourceError("documents", new Error(shardKey), trace);
        this.recordExternalSourceWarning("documents", "hit the transaction limit mid-batch", trace);

        await this.scheduleSourcePoll();

        return undefined;
    }

    /**
     * Mirrors the mutation branch of the generated `handleRpc`: the post-commit
     * flush of `ctx.storage`'s deferred object deletes. It reaches one base
     * member (`deferPastResponse`), which is `protected` for exactly this call —
     * the host's `waitUntil` behind it is private.
     */
    private async flushDeferredStorageDeletes(context: unknown): Promise<void> {
        const dispatchContext = context as { log?: { warn: (message: string, fields?: Record<string, unknown>) => void }; storage?: unknown };

        await this.deferPastResponse(
            (async () => {
                const outcome = await flushDeferredDeletes(dispatchContext.storage);

                for (const failure of outcome.failures) {
                    dispatchContext.log?.warn("ctx.storage.deleteAfterCommit: delete failed, object leaked", {
                        error: String(failure.error),
                        key: failure.key,
                    });
                }
            })(),
        );
    }
}
export default EmittedShardContract;
