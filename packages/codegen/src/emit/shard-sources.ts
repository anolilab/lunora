/**
 * The emitted ShardDO's external-source ingest (`.source(...)` tables): the
 * per-instance client/poll memos, the `pollExternalSources` override and the
 * constructor bootstrap that arms the poll alarm. Split out of `emitShard`;
 * all three are empty when no table is sourced.
 */
const emitExternalSourceFragments = (
    hasSourcedTables: boolean,
): { externalSourceOverride: string; sourceBootstrap: string; sourceClientCacheConst: string } => {
    // External-source ingest (plan 077). Per-DO-instance memos: the resolved
    // SqlClient keyed by binding (build each connection once), and the last-polled
    // wall-clock per table (so `refresh.everyMs` throttles the per-tick poll).
    const sourceClientCacheConst = hasSourcedTables
        ? `
const sourceClientCache = new WeakMap<object, Map<string, SourceClientLike>>();
const sourcePollAtCache = new WeakMap<object, Map<string, number>>();
`
        : "";

    // The DO subclass's poll override: each alarm tick, materialize every due
    // sourced table's tenant slice. Reads the runtime `.source(...)` config straight
    // off the `schema` object (the functions are not serialized into code), resolves
    // the host-supplied SqlClient, and delegates the per-table work to the tested
    // `pullExternalSourceTick` in @lunora/do (query under `tenantBy(shardKey)` →
    // id-lift → diff → apply through the validated CDC writer). System-owned (alarm
    // tier, no request identity), so it never loosens `ctx.sql`'s action-only contract.
    /* eslint-disable no-secrets/no-secrets -- the emitted `pullExternalSourceIncrementalTick(this.sql …)` poll-loop call is a dense generated identifier, not a credential */
    const externalSourceOverride = hasSourcedTables
        ? `
        protected override async pollExternalSources(trace?: TraceRefLike): Promise<number | undefined> {
            const env = (this.env ?? {}) as Record<string, unknown>;
            const sourced = Object.entries((schema as unknown as SchemaLike).tables)
                .map(([table, definition]) => [table, (definition as { externalSource?: ExternalSourceLike }).externalSource] as const)
                .filter((entry): entry is [string, ExternalSourceLike] => entry[1] !== undefined);

            if (sourced.length === 0) {
                return undefined;
            }

            const shardKey = this.currentShardKey();
            const scheduler = (config.scheduler?.(env) ?? schedulerStub) as SchedulerLike;

            let clients = sourceClientCache.get(this);

            if (clients === undefined) {
                clients = new Map();
                sourceClientCache.set(this, clients);
            }

            let polledAt = sourcePollAtCache.get(this);

            if (polledAt === undefined) {
                polledAt = new Map();
                sourcePollAtCache.set(this, polledAt);
            }

            const now = Date.now();
            // \`nextDueAt\` tracks the EARLIEST next-due timestamp across every
            // non-manual source; the shared alarm re-arms there instead of the
            // fixed 2 s global-shape floor, so a large \`refresh.everyMs\` actually
            // sleeps until it's due. Stays \`undefined\` when every source is
            // \`refresh: "manual"\`, so the shared alarm goes idle for this tier.
            let nextDueAt: number | undefined;

            for (const [table, source] of sourced) {
                if (source.refresh === "manual") {
                    continue;
                }

                if (isSourceDue(source.refresh, polledAt.get(table), now)) {
                    try {
                        let client = clients.get(source.binding);

                        if (client === undefined) {
                            client = config.sourceClient?.(env, source.binding);

                            if (client !== undefined) {
                                clients.set(source.binding, client);
                            }
                        }

                        if (client === undefined) {
                            // No SqlClient resolved for this binding (host never wired
                            // \`config.sourceClient\`, or wired it wrong). Surface it in the
                            // Logs panel and stamp \`polledAt\` so a persistent misconfig backs
                            // off to \`refresh.everyMs\` instead of retrying every alarm tick.
                            this.recordExternalSourceError(table, new Error(\`external-source: no sourceClient resolved for binding "\${source.binding}"\`), trace);
                        } else {
                            // A FRESH tracker per TABLE, not one shared across the whole
                            // loop: one table's runaway pull must not spend a budget a
                            // sibling table needs, and a limit hit here must not block
                            // that sibling from getting its own full budget this tick.
                            const writer = createShardCtxDb({
                                // Admin and maintenance writes go through the SAME reactive-cache hooks as
                                // a user mutation. Without this, a studio row edit, a TTL sweep, an admin
                                // import, a CDC apply or a data-migration backfill writes without
                                // invalidating, and the next query answers from the pre-write snapshot.
                                ...this.ctxDbTuning(),
                                broadcast: (delta) => {
                                    this.recordChangedTable(delta.table, delta.indexKeys);
                                },
                                cdc: config.cdc ?? false,
                                headroom: this.alarmHeadroom(),
                                scheduler,
                                schema: schema as unknown as SchemaLike,
                                sql: this.sql as SqlExec,
                            });

                            if (source.mode === "incremental") {
                                // Incremental (plan 136): pull only rows past the durable
                                // watermark (or a full-pull seed/reconcile), upsert-only.
                                // eslint-disable-next-line no-await-in-loop -- one sourced table at a time; sequential keeps the writer transaction simple
                                await pullExternalSourceIncrementalTick(this.sql as SqlExec, writer, client, table, source, shardKey, now);
                            } else {
                                // eslint-disable-next-line no-await-in-loop -- one sourced table at a time; slices are independent but small and sequential keeps the writer transaction simple
                                await pullExternalSourceTick(this.sql as SqlExec, writer, client, table, source, shardKey);
                            }
                        }

                        // Timestamp AFTER the poll finishes, not the batch-start \`now\` — a
                        // poll that outruns \`everyMs\` must not make \`nextDueAt\` (below)
                        // stale-immediate and re-arm the alarm in a hammering loop.
                        polledAt.set(table, Date.now());
                    } catch (error) {
                        if (error instanceof LunoraError && error.code === "TRANSACTION_LIMIT_EXCEEDED") {
                            // Batch full, not a genuine failure. Incremental mode only
                            // persists its watermark AFTER a full apply (see
                            // \`pullExternalSourceIncrementalTick\`), so this throw left it
                            // untouched — the next tick safely re-pulls/re-applies the
                            // SAME slice (idempotent upsert). Full-pull mode (and an
                            // incremental source's own occasional full-pull/reconcile
                            // sweep) has no resumable cursor at all — deliberately not
                            // inventing one here; a retry just redoes the whole pull,
                            // safe if wasteful. Either way: warn instead of
                            // \`recordExternalSourceError\`, and leave \`polledAt\`
                            // UNCHANGED (skip the stamp below via \`continue\`) so this
                            // table stays "due" and \`nextPollAlarmTarget\`'s existing
                            // due-now floor re-arms the shared alarm promptly — not a
                            // fresh \`setAlarm(now)\`.
                            this.recordExternalSourceWarning(
                                table,
                                \`external-source poll for "\${table}" hit the transaction limit mid-batch; resuming next tick: \${error.message}\`,
                                trace,
                            );

                            nextDueAt = nextDueAt === undefined ? now : Math.min(nextDueAt, now);

                            continue;
                        }

                        this.recordExternalSourceError(table, error, trace);
                        // Stamp on failure too, so a persistently failing source throttles
                        // to \`refresh.everyMs\` rather than being hammered every tick.
                        polledAt.set(table, Date.now());
                    }
                }

                // This source's own next-due time, read AFTER the poll-or-skip above
                // so a just-polled source reports \`now + everyMs\` (its FRESH due
                // time), not the stale pre-poll one. An omitted \`refresh\` (poll
                // every tick) is due again immediately.
                const sourceNextDueAt = source.refresh === undefined ? now : (polledAt.get(table) ?? now) + source.refresh.everyMs;

                nextDueAt = nextDueAt === undefined ? sourceNextDueAt : Math.min(nextDueAt, sourceNextDueAt);
            }

            return nextDueAt;
        }
`
        : "";
    /* eslint-enable no-secrets/no-secrets */

    // Arm the shared poll alarm on construction so a sourced DO starts ingesting —
    // but only when at least one source is non-manual (a \`refresh: "manual"\`-only
    // schema must not spin the alarm). The alarm re-arms itself while
    // `pollExternalSources` reports active sources. Emitted only when the schema has
    // a sourced table (else the class stays constructor-free).
    const sourceBootstrap = hasSourcedTables
        ? `
            const autoSourced = Object.values((schema as unknown as SchemaLike).tables).some((definition) => {
                const source = (definition as { externalSource?: ExternalSourceLike }).externalSource;

                return source !== undefined && source.refresh !== "manual";
            });

            if (autoSourced) {
                void this.scheduleSourcePoll();
            }
`
        : "";

    return { externalSourceOverride, sourceBootstrap, sourceClientCacheConst };
};

export default emitExternalSourceFragments;
