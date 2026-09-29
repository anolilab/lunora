/**
 * The emitted ShardDO's static dispatch source: the module-level `dispatchRun`
 * (the in-process `ctx.run*` dispatcher), the RPC/mutation-transaction methods
 * and the subscription/stream executors. Split out of `emitShard`; none of it
 * varies by project.
 */

/* eslint-disable no-secrets/no-secrets -- emitted ShardDO source, not credentials */
const DISPATCH_RUN_SOURCE = `// Bound in-process \`ctx.run*\` composition depth so a self- or cyclically-
// referencing call fails loudly with a clear error instead of overflowing the
// stack. Tracked across the awaited handler chain (one DO invocation is
// single-threaded), so the counter reflects true nesting depth.
const MAX_RUN_DEPTH = 32;
let runDepth = 0;

const dispatchRun = async (
    expected: FunctionKind,
    functionPath: string,
    args: Record<string, unknown>,
    ctx: unknown,
    // The kind of the context making the call, and — for a mutation target — the
    // transaction wrapper to run it under. Both are supplied by \`buildCtx\`, which
    // is the only place that knows which dispatch this \`ctx\` belongs to. Widened
    // past \`FunctionKind\` because the registry also carries \`"stream"\`, and
    // \`undefined\` for a ctx built outside a registered function (admin, migration).
    callerKind?: "stream" | FunctionKind,
    runTransactional?: (work: () => Promise<unknown>) => Promise<unknown>,
): Promise<unknown> => {
    // A query is read-only. The ctx object installs \`run*\` on every kind (one
    // shape, built once), so the TYPE is all that stops a query from writing —
    // and a cast walks straight past it, inside a subscription re-run that can
    // execute many times per write. Checked on the CALLER, before the registry
    // lookup, so \`ctx.runMutation\` from a query fails identically whatever it
    // aimed at.
    if (callerKind === "query" && expected !== "query") {
        throw new LunoraError(
            "RUN_KIND_FORBIDDEN",
            \`ctx.run\${expected[0]!.toUpperCase()}\${expected.slice(1)}: a query may only compose other queries (tried to run "\${functionPath}")\`,
        );
    }

    const registered = LUNORA_FUNCTIONS[functionPath];

    if (!registered) {
        throw new Error(\`unknown function: \${functionPath}\`);
    }

    if (registered.kind !== expected) {
        throw new Error(\`ctx.run\${expected[0]!.toUpperCase()}\${expected.slice(1)}: "\${functionPath}" is registered as a \${registered.kind}, not a \${expected}\`);
    }

    if (runDepth >= MAX_RUN_DEPTH) {
        throw new LunoraError("RUN_DEPTH_EXCEEDED", \`ctx.run*: composition depth limit (\${MAX_RUN_DEPTH}) exceeded — likely a cyclic runQuery/runMutation\`);
    }

    runDepth += 1;

    try {
        // A mutation composed from an action (or an http action) is the shape the
        // docs prescribe for atomicity — "do the transactional reads and writes in
        // a mutation and call it from the action". It only holds if the composed
        // dispatch gets the same BEGIN/COMMIT span and single-writer gate the
        // top-level mutation path gets; without it every write autocommits and a
        // mid-handler throw leaves the earlier ones durable. A \`runMutation\` from
        // inside a mutation rides the enclosing span instead of opening a second
        // one (see \`runMutationTransaction\`).
        if (runTransactional) {
            return await runTransactional(async () => registered.handler(ctx, args));
        }

        return await registered.handler(ctx, args);
    } finally {
        runDepth -= 1;
    }
};`;

const DISPATCH_METHODS = `        public override async handleRpc(functionPath: string, args: Record<string, unknown>, headroom?: TransactionHeadroomTracker, scope?: QueryReadScope, bookmarks?: DispatchBookmark): Promise<unknown> {
            const registered = LUNORA_FUNCTIONS[functionPath];

            // Internal functions are reachable server-side only: via \`ctx.run*\`
            // composition, or a trusted system dispatch (scheduler/cron, marked by
            // \`isSystemDispatch()\`). A client RPC never carries that flag, so its
            // internals stay not-found and never leak across the external boundary.
            if (!registered || (registered.visibility === "internal" && !this.isSystemDispatch())) {
                throw new LunoraError("FUNCTION_NOT_FOUND", \`function not registered: \${functionPath}\`);
            }

            this.ensureMigrated();

            // \`headroom\`, when the caller supplied one, is threaded straight
            // through to \`buildCtx\` — bypassing its \`this.transactionHeadroom()\`
            // fallback (the racy shared-field read) entirely for THIS dispatch.
            // The main \`/rpc\` path always supplies one; \`dispatchLifecycle\` /
            // \`handleRunAs\` don't mint their own and omit it, so they keep the
            // prior fallback behavior unchanged.
            //
            // \`scope\` is the reactive cache's per-dispatch read capture, threaded
            // the same way and for the same reason: the ctx-db read hooks resolve
            // their tracker at READ time, so binding them to the scope THIS
            // dispatch was handed is what keeps a concurrent query's reads out of
            // our dep set — and ours out of theirs. A dispatch with no scope (a
            // mutation, an action, a cache-less shard) builds unbound hooks that
            // stamp no deps.
            const ctx = this.buildCtx({ bookmarks, functionPath, headroom, scope, trusted: registered.lifecycle === "init" });

            // A mutation's writes must commit all-or-nothing, so its dispatch runs
            // under \`runMutationTransaction\` — the ONE place that opens the span,
            // settles the deferred schedules and flushes the deferred deletes. The
            // same helper backs \`ctx.runMutation\` and \`runReactor\`, because a
            // mutation reached by composition is promised exactly these guarantees
            // and used to get none of them.
            //
            // The replay bookkeeping (idempotency dedup row + custom-mutator
            // watermark advance) commits INSIDE the span via
            // \`commitMutationBookkeeping\`, so the writes, the dedup row, and the
            // watermark are atomic — a crash can't leave the writes durable without
            // the replay guard. It is deliberately NOT in the shared helper: it is
            // per-REQUEST bookkeeping, and a composed sub-mutation has no request of
            // its own to record.
            if (registered.kind === "mutation") {
                return await this.runMutationTransaction(ctx, async () => {
                    const value = await registered.handler(ctx, args);

                    this.commitMutationBookkeeping(value);

                    return value;
                });
            }

            const result = await registered.handler(ctx, args);

            // An action is not itself transactional, but \`ctx.runMutation\` runs its
            // submutations on THIS ctx, so anything they queued after their own
            // transaction settled lands here. A dispatch with nothing queued no-ops.
            await this.deferPastResponse(flushDeferredDeletes(ctx));

            return result;
        }

        /**
         * Run one mutation handler with the atomicity every caller of a mutation is
         * promised: a BEGIN/COMMIT span (with the single-writer gate
         * \`ShardRunner.runInTransaction\` composes in front of it), scheduled jobs
         * held until that span commits, and the deferred object deletes flushed
         * only once it has.
         *
         * Shared by the three entry points that dispatch a mutation handler — the
         * top-level RPC, \`ctx.runMutation\` from an action or http action, and a
         * reactor — because the guarantee is a property of the mutation, not of how
         * it was reached. The docs tell users to put the transactional part in a
         * mutation and call it from the action precisely so that composition is
         * atomic.
         *
         * A \`ctx.runMutation\` issued from inside a mutation is NESTED: SQLite-in-DO
         * has no savepoints and \`runInTransaction\` rejects a second open, so it
         * rides the enclosing span, which also owns its commit and therefore its
         * scheduler flush.
         *
         * Both deferral windows are opened here and settled against the SAME
         * outcome. The delete window is what keeps a composed mutation's queued
         * object deletes off the caller's flush when it rolls back: \`ctx\` is
         * shared, so without a window the keys are indistinguishable from the
         * action's own and the action's flush destroys objects whose rows the
         * rollback put back.
         */
        private async runMutationTransaction<T>(ctx: unknown, work: () => Promise<T>): Promise<T> {
            const settleSchedules = beginDeferredSchedules(ctx as { scheduler?: unknown });
            // Synchronous and non-throwing (it only moves queue entries), so it can
            // settle first on every path and cannot mask the outcome.
            const settleDeletes = beginDeferredDeletes(ctx);

            if (this.isInTransaction()) {
                try {
                    const nested = await work();

                    settleDeletes(true);
                    await settleSchedules(true);

                    return nested;
                } catch (error) {
                    settleDeletes(false);
                    await settleSchedules(false);

                    throw error;
                }
            }

            let result: T;

            try {
                result = await this.runInTransaction(work);
            } catch (error) {
                // The span rolled back, so the rows are gone and the jobs that were
                // to run "after I commit" must go with them. Dropping them is the
                // whole point of buffering: a persisted job for a write that never
                // landed fires against state that does not exist.
                //
                // The queued object deletes go the same way, and for a sharper
                // reason: the rows they were to clean up after are still there, and
                // an R2 delete cannot be undone.
                settleDeletes(false);
                await settleSchedules(false);

                throw error;
            }

            // Committed, so this span's queued keys join whatever the flush below
            // (or an enclosing span's) will drain.
            settleDeletes(true);

            // Committed. Schedules first and AWAITED: \`runAfter(0, ...)\` is
            // documented as the deterministic equivalent of an \`afterCommit\` hook,
            // so the job must be enqueued after the commit, and a failure to enqueue
            // it must be visible rather than swallowed.
            //
            // In a \`finally\`, because both halves of this are post-commit cleanup
            // and neither is allowed to cancel the other. \`settleSchedules\` drains
            // its whole queue and then rethrows what failed, so a SchedulerDO that
            // refused one job used to take the object cleanup down with it — the
            // rows were durably gone and their objects leaked with nothing logged.
            try {
                await settleSchedules(true);
            } finally {
                // Then the objects whose rows are now durably gone. Deliberately AFTER
                // the span, never inside it: an R2 delete cannot roll back, so a delete
                // issued from within a transaction that later aborts destroys data the
                // surviving row still points at.
                //
                // \`flushDeferredDeletes\` never rejects — the mutation has already
                // succeeded, so a failed cleanup must not turn into a failed response.
                // A leaked object is reported through \`ctx.log\` instead, with its key.
                await this.deferPastResponse(flushDeferredDeletes(ctx));
            }

            return result;
        }

        // Only a \`mutation\` may enter the base class's single-writer gate for
        // mutation-replay dedup — it is \`blockConcurrencyWhile\`, so gating an
        // action would stall every other dispatch on the shard for the length of
        // its outbound I/O, on nothing but a caller-supplied header. Unregistered
        // paths answer \`false\`; \`handleRpc\` above rejects them anyway.
        protected override isMutationFunction(functionPath: string): boolean {
            return LUNORA_FUNCTIONS[functionPath]?.kind === "mutation";
        }

        // The scheduler the deferred-schedule outbox retries through. Only the
        // CONFIGURED one: falling back to \`schedulerStub\` would have an app with no
        // scheduler retry every entry against a thrower until the attempt ceiling
        // parked it, and there is nothing to park — an app with no scheduler has no
        // \`ctx.scheduler\` call that reached the buffer in the first place.
        protected override scheduleOutboxScheduler(): SchedulerLike | undefined {
            return config.scheduler?.((this.env ?? {}) as Record<string, unknown>) as SchedulerLike | undefined;
        }`;

const SUBSCRIPTION_METHODS = `        protected override async executeSubscription(functionPath: string, args: Record<string, unknown>, identity?: SubscriptionIdentity): Promise<{ ranges?: Map<string, KeyRange[]>; result: unknown; tables: Set<string> } | null> {
            const registered = LUNORA_FUNCTIONS[functionPath];

            if (!registered || registered.kind !== "query" || registered.visibility === "internal") {
                return null;
            }

            this.ensureMigrated();

            const footprint = createReadFootprint();
            // Identity is threaded EXPLICITLY from the (deferred/interleaved)
            // subscription caller — never read from the shared per-request field
            // here — so a concurrent RPC can't leak its identity into this re-run.
            const ctx = this.buildCtx({ functionPath, headroom: this.subscriptionHeadroom(), identity, onRead: footprint.onRead, onReadRange: footprint.onReadRange });
            const result = await registered.handler(ctx, args);

            // Ranges come from THIS run's reads, never a shared field on the DO:
            // a deferred re-run interleaves with unrelated dispatches.
            return { ranges: footprint.ranges(), result, tables: footprint.tables };
        }

        protected override executeStream(functionPath: string, args: Record<string, unknown>, identity?: SubscriptionIdentity): null | { durable?: { ttlMs?: number }; iterator: (signal: AbortSignal) => AsyncIterable<unknown> } {
            const registered = LUNORA_FUNCTIONS[functionPath];

            if (!registered || registered.kind !== "stream" || registered.visibility === "internal") {
                return null;
            }

            this.ensureMigrated();

            return {
                ...(registered.durable ? { durable: registered.durable as { ttlMs?: number } } : {}),
                // Identity threaded EXPLICITLY from the socket, exactly as
                // \`executeSubscription\` above: the iterator is pulled after this
                // frame returned, interleaved with unrelated dispatches, so
                // \`buildCtx\`'s per-request fallback would run an \`rls()\` /
                // \`ctx.auth\` stream as nobody — or as a concurrent RPC's caller.
                iterator: (signal) => (registered.handler as (context: unknown, args: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<unknown>)(this.buildCtx({ functionPath, identity }), args, signal),
            };
        }`;
/* eslint-enable no-secrets/no-secrets */

export { DISPATCH_METHODS, DISPATCH_RUN_SOURCE, SUBSCRIPTION_METHODS };
