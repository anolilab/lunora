/**
 * The emitted ShardDO's context builder: the `buildCtx` method every dispatch
 * builds its `ctx` with. Split out of `emitShard`; the fragments it splices in
 * are computed there from the project's feature flags.
 */

/** The pre-rendered fragments `buildCtx` splices in. */
interface BuildContextParts {
    /** The ActionCtx-only helpers' builds, attached only on an `action` ctx. */
    actionOnlyBuild: string;
    /** The ctx field each ActionCtx-only helper is attached as (named after its local). */
    actionOnlyFields: ReadonlyArray<string>;
    agentsBuild: string;
    agentsContextField: string;
    containersBuild: string;
    containersContextField: string;
    databaseOptions: string;
    everyContextBuild: string;
    everyContextField: string;
    facadeBlock: string;
    globalDatabaseLine: string;
    hasSensitiveArgs?: boolean;
    lazyFunctions?: boolean;
    notifyBuild: string;
    ormContextField: string;
    paymentsBuild: string;
    paymentsContextField: string;
    queuesBuild: string;
    queuesContextField: string;
    topicsBuild: string;
    topicsContextField: string;
    vectorsBuild: string;
    vectorsContextField: string;
    workflowsBuild: string;
    workflowsContextField: string;
}

/* eslint-disable no-secrets/no-secrets -- emitted ShardDO source, not credentials */
const renderBuildContext = ({
    actionOnlyBuild,
    actionOnlyFields,
    agentsBuild,
    agentsContextField,
    containersBuild,
    containersContextField,
    databaseOptions,
    everyContextBuild,
    everyContextField,
    facadeBlock,
    globalDatabaseLine,
    hasSensitiveArgs = false,
    lazyFunctions = false,
    notifyBuild,
    ormContextField,
    paymentsBuild,
    paymentsContextField,
    queuesBuild,
    queuesContextField,
    topicsBuild,
    topicsContextField,
    vectorsBuild,
    vectorsContextField,
    workflowsBuild,
    workflowsContextField,
}: BuildContextParts): string => {
    const actionOnlyHasAny = actionOnlyFields.length > 0;
    const databaseContextReturn = ormContextField === "" ? "{ db }" : "{ db, orm: bindOrm(facade) }";
    const databaseContextField = ormContextField === "" ? "" : "\n                orm: databaseContext.orm,";
    const mutationOrmDescriptor =
        ormContextField === ""
            ? ""
            : "\n                                orm: { configurable: true, enumerable: true, value: mutationDatabase.orm, writable: true },";
    // The builds are written at `buildCtx` body depth (they are shared with the
    // every-context helpers' shape); here they sit one block deeper.
    const actionOnlyBlock = actionOnlyHasAny
        ? `
            // ActionCtx-only helpers (external, non-deterministic I/O): constructed
            // and attached only for an \`action\` so query/mutation ctx never carry them.
            if (isAction) {
${actionOnlyBuild.replaceAll(/^(?=.)/gmu, "    ")}${actionOnlyFields.map((field) => `                ctx.${field} = ${field};`).join("\n")}
            }
`
        : "";
    // Only emit `isAction` when an action-only helper is wired — otherwise it
    // would be an unused local.
    const isActionLine = actionOnlyHasAny ? `            const isAction = contextKind === "action";\n` : "";
    // Only with a `v.sensitive` argument somewhere in the app: the key is the one
    // `admitSensitiveArgs` in `@lunora/server` looks up, and a validator can only
    // hand over a marked value when one exists.
    const sensitiveAdmitField = hasSensitiveArgs
        ? `
                [Symbol.for("lunora.admitSensitiveArgs")]: (args: Record<string, unknown>, names: ReadonlySet<string>): void => this.admitSensitiveValues(options.sensitive, args, names),`
        : "";

    return `        private buildCtx(options: { bookmarks?: DispatchBookmark | undefined; functionPath?: string | undefined; headroom?: TransactionHeadroomTracker | undefined; identity?: SubscriptionIdentity | undefined; kind?: "query" | undefined; onRead?: ((table: string, idOrScan?: string) => void) | undefined; onReadRange?: ((range: KeyRange) => void) | undefined; replayKey?: boolean | undefined; scope?: QueryReadScope | undefined; sensitive?: SensitiveScope | undefined; trusted?: boolean | undefined } = {}): unknown {
            const env = (this.env ?? {}) as Record<string, unknown>;
            // The caller context this ctx runs under, resolved ONCE on one
            // discriminant. When the caller threads an explicit identity
            // (subscription seed / refresh / stream pull / shape resolve — all
            // deferred or interleaved), it is used by value and the shared
            // per-request fields are never read, because a concurrent RPC owns
            // them: a refresh in particular runs inside the writing dispatch's
            // \`flushChangedTables\`, BEFORE its \`endDispatch\`, so \`getCurrentIp()\`
            // there is the MUTATING caller's address. Otherwise (the synchronous
            // RPC dispatch path) it falls back to those fields as before.
            //
            // One expression, not one per field: three parallel ternaries on the
            // same discriminant is how \`ip\` came to be the only one still reading
            // the shared field.
            const caller: SubscriptionIdentity = options.identity ?? (() => {
                const identity = this.getCurrentIdentity();
                const ip = this.getCurrentIp();
                const userId = this.getCurrentUserId();

                return {
                    ...(identity === undefined ? {} : { identity }),
                    ...(ip === undefined ? {} : { ip }),
                    ...(userId === undefined ? {} : { userId }),
                };
            })();
            const { identity, ip, userId } = caller;
${vectorsBuild}${everyContextBuild}${containersBuild}${workflowsBuild}${queuesBuild}${topicsBuild}${agentsBuild}
            // Which dispatch this ctx belongs to. Drives the two deferral facades
            // below and the \`ctx.run*\` caller guard; a ctx built for an
            // admin/lifecycle path has no registered function, and so no kind. An
            // untracked \`ctx.runQuery\` overrides it with \`"query"\`: the sub-query
            // keeps the caller's \`functionPath\` for attribution but runs as a query.
            const contextKind = options.kind ?? LUNORA_FUNCTIONS[options.functionPath ?? ""]?.kind;
            // \`list\`/\`get\` are the two methods \`ctx.db.system.query("_scheduled_functions")\`
            // reaches through, and pending jobs live in the SchedulerDO — nothing the
            // CDC changelog records — so reading them must forfeit a delta resume.
            // The scheduler's own \`runAfter\`/\`runAt\`/\`cancel\` are writes and stay unstamped.
            const schedulerBase = markUnvouchableReads((config.scheduler?.(env) ?? schedulerStub) as SchedulerLike, options.onRead, ["get", "list"]);
            // \`ctx.scheduler.runAfter(0, ...)\` is documented as the deterministic
            // equivalent of an \`afterCommit\` hook, and the SchedulerDO persists the
            // job the moment it is called — so inside a mutation the call is BUFFERED
            // and replayed after the transaction commits (a rollback drops it).
            // Composed mutations get their own facade when the caller is outside
            // a transaction. True nested calls share the enclosing facade and open
            // a nested window. The action's own schedules stay immediate.
            //
            // Every kind but \`query\` is wrapped, because \`runMutationTransaction\`
            // is installed on \`ctx.runMutation\` for every kind but \`query\`: a
            // STREAM ctx, and an admin/lifecycle ctx with no registered kind at all,
            // both get the BEGIN/COMMIT span for a mutation they compose, and used
            // to get it with the deferral missing — so that mutation's job reached
            // the SchedulerDO while its transaction was still open, and survived the
            // rollback. A query cannot host a mutation handler (\`dispatchRun\`
            // refuses it) and its ctx is built on the hot subscription path, so it
            // stays unwrapped.
            //
            // Wrapped OUTSIDE the read-stamping facade so \`get\`/\`list\` stay stamped.
            //
            // \`this.scheduleOutbox()\` is what keeps the buffer honest. Everything
            // between the COMMIT and the scheduler's acknowledgement is outside the
            // transaction, so a failure there leaves writes that are durable and a
            // job that exists nowhere — and the mutation's replay-dedup row committed
            // inside the span, so the client's retry is answered from cache and told
            // it succeeded. The outbox takes custody of each buffered call inside the
            // transaction and releases it once the scheduler has the job; what
            // survives is retried by \`pollScheduleOutbox\` on the shared poll alarm.
            const scheduler = contextKind === "query" ? schedulerBase : withDeferredSchedules(schedulerBase, this.scheduleOutbox());
            // Build the storage adapter once and share it between \`ctx.storage\`
            // and \`ctx.db.system._storage\` so both read the same R2 binding. The
            // \`storageStub\` fallback satisfies SystemReaderStorageLike structurally
            // (its \`list\`/\`getMetadata\` throw the "no storage configured" error).
            //
            // Wrapped BEFORE the split so both consumers share one stamping facade.
            // Only the methods that actually reach R2 are stamped: \`getUrl\` and
            // \`getSignedUrl\` build a URL from the configured base (and an HMAC) and
            // read nothing, and they are what handlers overwhelmingly call — stamping
            // them would forfeit resumes for a dependency that cannot move the result.
            // \`bucket\` IS stamped: it hands back a sub-facade this wrapper does not
            // reach, so the selection is the last point at which the read can be seen.
            //
            // The request origin is the storage base fallback for mutations and
            // actions on the synchronous dispatch only. A deferred caller
            // (\`options.identity\` set) runs outside the dispatch that owns the
            // field, the same hazard \`getCurrentIp\` has. A query never gets it: a
            // live query re-runs with no request behind it, and the reactive
            // cache does not key on the host, so a query that signs URLs needs a
            // declared \`publicBaseUrl\` either way.
            const requestOrigin = contextKind !== "query" && options.identity === undefined ? this.getCurrentOrigin() : undefined;
            const makeStorage = (origin?: string): SystemReaderStorageLike =>
                markUnvouchableReads(asBucketStorage(config.storage?.(env, origin) ?? storageStub) as SystemReaderStorageLike, options.onRead, [
                    "bucket",
                    "download",
                    "getMetadata",
                    "list",
                ]);
            const storage = makeStorage(requestOrigin);
            // \`ctx.storage.deleteAfterCommit(key)\`, on every dispatch that can host
            // a MUTATION handler — which is not only a mutation dispatch. An
            // action's composed mutation gets a child ctx with its own deferred
            // delete queue, while mutations reuse the admitted ctx. Queries stay
            // unwrapped: they cannot host one, and their ctx is built on the hot
            // subscription path.
            //
            // Every dispatch wrapped here also flushes (see \`handleRpc\` and
            // \`runReactor\`) — a queue nothing drains leaks silently, which is worse
            // than not having the method at all.
            //
            // Wrapped OUTSIDE the read-stamping facade so \`bucket(name)\` still
            // resolves through it and stays stamped, and applied only to
            // \`ctx.storage\` so \`ctx.db.system._storage\` (which shares the adapter
            // above) is untouched.
            const contextStorage = contextKind === "mutation" || contextKind === "action" ? withDeferredDeletes(storage) : storage;
            // \`ctx.log\`: the DO base builds the attributed logger (structured
            // fields + \`.with(...)\` child + trace correlation) and routes each call
            // to the optional \`observability\` sink. It also buffers the line (studio
            // Logs panel) and emits a structured console event the dev-server formats.
            //
            // Resolved BEFORE \`ctx.db\` below, because the database is wrapped in
            // auto-instrumentation that needs the sink, the trace anchor, and the
            // dispatch's wide-event handle.
            const observability = config.observability?.(env);
            const logFunctionPath = options.functionPath ?? "";
            const log = this.makeLogger(logFunctionPath, observability, undefined, options.sensitive);
            const traceAnchor = this.resolveDispatchAnchor(Boolean(options.identity));

            // \`ctx.span\`: the handle onto the DISPATCH's own span — the wide-event
            // surface. Attributes attached here accumulate for the whole request
            // and are folded into the one span it already emits, instead of
            // becoming N separate log lines. Shares \`traceAnchor\` with \`ctx.trace\`
            // so both write to the same trace.
            const span = this.makeDispatchSpan(traceAnchor, observability, options.sensitive);

${globalDatabaseLine}            // \`ctx.db\`, wrapped in automatic instrumentation: by default this
            // adds aggregate counters (call count, total time, per-operation
            // breakdown) to the wide event rather than a span per call, so a
            // handler making hundreds of queries stays readable. See
            // \`instrumentDatabase\` for the \`"spans"\` / \`"off"\` levels.
            // Schema triggers close over this DB's scheduler, so a composed
            // mutation must rebuild its DB and table/ORM views with its own queue.
            const makeDatabaseContext = (scheduler: SchedulerLike) => {
                const db: DatabaseWriterLike = this.instrumentDb(createShardCtxDb(${databaseOptions}), logFunctionPath, traceAnchor, observability, options.sensitive);
${facadeBlock}                return ${databaseContextReturn};
            };
            const databaseContext = makeDatabaseContext(scheduler);
            const db = databaseContext.db;
${paymentsBuild}

            // \`ctx.trace\` / \`ctx.metrics\`: spans and measurements to the same sink.
            // The trace anchor is threaded explicitly for the same reason \`identity\`
            // is — a deferred caller (a subscription re-run) must not inherit the
            // writing mutation's trace from the shared per-request field.
            const trace = this.makeTracer(logFunctionPath, observability, traceAnchor, options.sensitive);
            const metrics = this.makeMetrics(logFunctionPath, observability, options.sensitive);
${notifyBuild}
            // \`ctx.now\`: the wall-clock instant (epoch ms) this function began,
            // captured ONCE so the whole handler body sees a single stable value.
            // A \`query\` handler is re-run by every live subscription that reads it,
            // so \`Date.now()\` there flickers between re-evaluations. A \`mutation\`
            // handler does not replay under ordinary dispatch (an OCC conflict throws
            // to the caller rather than retrying internally), but one called from a
            // workflow step or queue consumer runs again when that step replays. Both
            // read time through \`ctx.now\` — the \`nondeterministic_query_mutation\`
            // advisor flags \`Date.now()\`. Actions may still use ambient \`Date.now()\`.
            const now = Date.now();

            // \`ctx.fetch\` is action-only. A query is re-run by every live subscription and a
            // mutation may be replayed, so a network call in either returns a different answer
            // on each run. Refused at runtime, not only linted: the advisor sees just the call
            // sites it can read, and a call inside a dependency is invisible to it.
            // Synchronous on purpose: an async refusal only rejects a promise the handler may
            // discard, and the handler would then return normally. A sync throw surfaces at the call.
            const refuseFetch = (): never => {
                throw new LunoraError("FORBIDDEN", "ctx.fetch is action-only: network I/O belongs in an action, not a query or mutation");
            };

            // A reactor run is driven by the writer's inline refresh, not replayed by the writer, so it must not
            // inherit the writer's key: every run would restart the same id and random sequence.
            const stableKey = options.replayKey !== false && options.identity === undefined && this.idempotencyNamespace() !== undefined ? this.getCurrentMutationId() : undefined;
            const stableScope = JSON.stringify([this.currentShardKey(), options.functionPath ?? "", this.idempotencyNamespace() ?? "", userId ?? ""]);

            const ctx: Record<string, unknown> = {
                auth: {
                    getIdentity: async () => identity ?? null,
                    userId: userId ?? null,
                },
                db,
                // \`ctx.newId()\`: a replay of the same top-level mutation gets the same ids. A nested or
                // subscription-driven build (\`options.identity\`) is not a replay.
                // A replay key only means something inside the caller's dedup namespace; without one the call is not
                // deduplicated, so its ids stay random.
                // \`ctx.random()\` shares the replay key and scope, so a replay reproduces both sequences.
                newId: createStableIdFactory(stableKey, stableScope),
                random: createStableRandomFactory(stableKey, stableScope),
                // Instrumented \`fetch\`: a CLIENT span per outbound call plus W3C
                // \`traceparent\` propagation, so time spent in a downstream service
                // is visible and its spans join this trace. Degrades to the bare
                // global when no sink is configured. Not built for a query or a
                // mutation: those refuse network I/O (see \`refuseFetch\`).
                fetch: contextKind === "query" || contextKind === "mutation" ? refuseFetch : this.makeFetch(logFunctionPath, traceAnchor, observability, options.sensitive),
                // A GETTER, not a plain field, so the reactive cache can tell a
                // handler that reads the caller's address from the majority that
                // never do. \`ctx.ip\` is per-request state the memo must be keyed
                // by — otherwise two anonymous callers share one entry and the
                // second is served the first's address — but keying every entry
                // by address would shard the cache per client for every query.
                // Reading it here marks the dispatch's scope; \`runCachedQuery\`
                // folds the address into the key for this function from then on.
                get ip() {
                    options.scope?.markIpRead();

                    return ip;
                },
                log,
                metrics,
                now,
                // The same request origin the storage fallback above uses, handed
                // to the handler so code that signs its own URLs (a copy-in
                // \`createStorage\`) can fall back to it too. \`undefined\` for a
                // query and for a deferred dispatch, for the reasons given there.
                origin: requestOrigin,${databaseContextField}
                scheduler,
                span,
                storage: contextStorage,
                trace,${vectorsContextField}${everyContextField}${paymentsContextField}${containersContextField}${workflowsContextField}${queuesContextField}${topicsContextField}${agentsContextField}${sensitiveAdmitField}
            };
${isActionLine}${actionOnlyBlock}
${
    lazyFunctions
        ? `            const captureScope = (): (() => void) => {
                const requestScope = this.captureRequestScope();
                return () => this.restoreRequestScope(requestScope);
            };

`
        : ""
}            const installRun = (target: Record<string, unknown>, kind: typeof contextKind): void => {
                target.runAction = (reference: FunctionReference, fnArgs: Record<string, unknown>) => {
                    // The callee runs inside this invocation, so its marked arguments are scrubbed here too.
                    this.admitSensitiveArgs(options.sensitive, reference.__lunoraRef, fnArgs);

                    return dispatchRun("action", reference.__lunoraRef, fnArgs, target, kind${lazyFunctions ? ", undefined, captureScope" : ""});
                };
                // The composed mutation runs under the SAME wrapper the top-level RPC
                // uses, so "do the transactional work in a mutation and call it from the
                // action" — the recipe the docs give for atomicity — actually is atomic.
                target.runMutation = (reference: FunctionReference, fnArgs: Record<string, unknown>) => {
                    this.admitSensitiveArgs(options.sensitive, reference.__lunoraRef, fnArgs);
                    // An action can start sibling mutations concurrently. Each owns its
                    // context and deferral queues; only calls from an admitted mutation
                    // inherit that mutation's transaction.
                    const mutationCtx: Record<string, unknown> = this.mutationContexts.has(target)
                        ? target
                        : (() => {
                            const mutationScheduler = withDeferredSchedules(schedulerBase, this.scheduleOutbox());
                            const mutationDatabase = makeDatabaseContext(mutationScheduler);

                            // Copied from an action's ctx, which carries the real \`fetch\`; a mutation
                            // refuses network I/O wherever it runs, so its \`fetch\` is overridden here.
                            return Object.defineProperties({}, {
                                ...Object.getOwnPropertyDescriptors(target),
                                db: { configurable: true, enumerable: true, value: mutationDatabase.db, writable: true },${mutationOrmDescriptor}
                                fetch: { configurable: true, enumerable: true, value: refuseFetch, writable: true },
                                scheduler: { configurable: true, enumerable: true, value: mutationScheduler, writable: true },
                                storage: { configurable: true, enumerable: true, value: withDeferredDeletes(storage), writable: true },
                            });
                        })();

                    if (mutationCtx !== target) {
                        installRun(mutationCtx, kind);
                    }

                    return dispatchRun("mutation", reference.__lunoraRef, fnArgs, mutationCtx, kind, async (work) => this.runMutationTransaction(mutationCtx, work)${lazyFunctions ? ", captureScope" : ""});
                };
                // \`ctx.runQuery(ref, args, { untracked: true })\` runs the sub-query on
                // its OWN query context, built without the subscription's read-footprint
                // hooks — so its reads never enter this subscription's footprint and a
                // write to the tables it touched does not re-run us. Everything else is
                // inherited: \`functionPath\` (log/metric attribution), \`headroom\` (the
                // sub-query must not escape this dispatch's resource ceiling),
                // \`scope\` (the reactive-cache capture — an untracked sub-query's reads
                // must still be deps of the entry the OUTER query is memoized as, or
                // the memo goes stale), and — load-bearing — the resolved \`caller\` BY VALUE
                // (identity, userId AND ip). Omitting it would let \`buildCtx\` fall back
                // to the shared per-request fields, which a concurrent RPC may have
                // re-set, and an RLS-scoped sub-query would then read as the wrong user
                // from the wrong address. A tracked call runs on \`queryContext()\` below.
                target.runQuery = (reference: FunctionReference, fnArgs: Record<string, unknown>, runOptions?: { untracked?: boolean }) => {
                    this.admitSensitiveArgs(options.sensitive, reference.__lunoraRef, fnArgs);

                    return dispatchRun(
                        "query",
                        reference.__lunoraRef,
                        fnArgs,
                        runOptions?.untracked === true
                            ? this.buildCtx({ bookmarks: options.bookmarks, functionPath: options.functionPath, headroom: options.headroom, identity: caller, kind: "query", scope: options.scope, sensitive: options.sensitive })
                            : queryContext(),
                        kind,${lazyFunctions ? "\n                        undefined,\n                        captureScope," : ""}
                    );
                };
            };

            // A query composed from a mutation or action runs on a QUERY view of
            // this ctx, so it behaves exactly as it does when called directly or
            // live: same \`db\`, read hooks, trace and \`now\`, but every field that
            // depends on the dispatch kind or the request origin is re-derived for a
            // query — no \`ctx.origin\`, storage with no origin fallback (and no
            // \`deleteAfterCommit\`), the unwrapped scheduler, no ActionCtx-only
            // helpers, no \`fetch\` (a query is re-run, see \`refuseFetch\`), and a \`run*\` guard
            // that refuses a mutation or action. A new kind- or origin-dependent ctx field must
            // be overridden here too.
            // Copied by descriptor so the \`ip\` getter is carried over, not read.
            // Built on the first composed call only; a query ctx is its own view.
            let queryView: Record<string, unknown> | undefined;
            const queryContext = (): Record<string, unknown> => {
                if (contextKind === "query") {
                    return ctx;
                }

                if (queryView === undefined) {
                    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(ctx);
${actionOnlyFields.map((field) => `                    delete descriptors.${field};\n`).join("")}                    // Writable and configurable, like the plain fields they replace.
                    const field = (value: unknown): PropertyDescriptor => ({ configurable: true, enumerable: true, value, writable: true });

                    queryView = Object.defineProperties({}, {
                        ...descriptors,
                        fetch: field(refuseFetch),
                        origin: field(undefined),
                        scheduler: field(schedulerBase),
                        storage: field(makeStorage()),
                    }) as Record<string, unknown>;
                    installRun(queryView, "query");
                }

                return queryView;
            };

            installRun(ctx, contextKind);

            return ctx;
        }`;
};
/* eslint-enable no-secrets/no-secrets */

export default renderBuildContext;
