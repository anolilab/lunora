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

class EmittedShardContract extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- required abstract override; this file exercises the base surface, it never dispatches
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(undefined);
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
}
export default EmittedShardContract;
