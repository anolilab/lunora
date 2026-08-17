/**
 * The `*Like` projections of the RivetKit surface this host consumes.
 *
 * Same convention as `@lunora/platform`'s binding projections, and for the same
 * reason: the adapter is written against the *shape* it needs rather than
 * against `rivetkit` itself, so the package type-checks, tests and installs with
 * no Rivet runtime present — and so the exact surface it depends on is written
 * down in one reviewable place instead of being implied by call sites.
 *
 * These are **narrowings, not restatements**: every member below is copied from
 * `rivetkit@2.3.10`'s `src/actor/config.ts` (`ActorContext`, `ActorKv`,
 * `ActorSchedule`, `ActorCron`) and `src/common/database/config.ts`
 * (`RawAccess`), with the generics erased and the members this host never calls
 * dropped. A real `ActorContext` is assignable to {@link RivetActorLike};
 * `__tests__/rivet-context-projection.test.ts` pins that by checking the
 * projection against the upstream declarations rather than trusting this
 * comment — the failure mode CLAUDE.md calls out (a `*Like` type nothing
 * consumes, drifting from the real one) is exactly what that test exists to
 * prevent.
 *
 * Deliberately absent: `state`, `vars`, `broadcast`, `conns`, `queue`, and the
 * connection lifecycle. Lunora's engine owns its own state, fan-out and
 * subscription bookkeeping; an adapter that also reached for Rivet's would give
 * one shard two sources of truth.
 *
 * Also absent, and for the reason this file exists at all: anything with no
 * consumer in `src/`. `actorId`, `name`, `schedule.after`, `schedule.get`,
 * `cron.delete` and `db.transaction` all read plausibly and were all dead —
 * and a projection member nothing calls is exactly what drifts from upstream
 * unnoticed, because assignability keeps passing forever. Add a member when
 * the call site that needs it lands, not before.
 */

/**
 * Rivet's raw SQLite access — `c.db`, as produced by `db({ onMigrate })` from
 * `rivetkit/db`.
 *
 * Every entry point is a promise. That is the single fact that shapes this
 * whole package: `ShardSqlExec.exec` is synchronous, so the engine's hot path
 * cannot be served from here directly. See `./rivet-shard-state` for the
 * working copy that bridges the two, and `RIVET_CAPABILITIES.localSql` in
 * `@lunora/platform` for how that is rated.
 */
export interface RivetRawDatabaseLike {
    /**
     * Run a statement, resolving to its rows. Writes resolve to an empty array.
     * Bindings are positional (`?`) when passed as loose arguments, or named
     * (`:name`) when passed as a single object.
     */
    execute: <Row extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]) => Promise<Row[]>;
}

/** One pending Rivet schedule — `ScheduledEventInfo`. */
export interface RivetScheduledEventLike {
    action: string;
    args: unknown[];
    id: string;
    runAt: number;
}

/**
 * Rivet's durable one-shot scheduler — `c.schedule`.
 *
 * Schedules survive sleep, restart, upgrade and crash, and Rivet wakes a
 * sleeping actor to deliver them. Delivery invokes an **action on the same
 * actor**, which is why both the shard alarm and the scheduler host route
 * through a well-known action name rather than a callback.
 */
export interface RivetScheduleLike {
    /** Run `action` once at an absolute epoch-ms `timestamp`. Resolves to the schedule id. */
    at: (timestamp: number, action: string, ...args: unknown[]) => Promise<string>;
    /** Cancel a pending schedule; `false` when it already fired or never existed. */
    cancel: (id: string) => Promise<boolean>;
    /** Every pending schedule on this actor. */
    list: () => Promise<RivetScheduledEventLike[]>;
}

/** Options accepted by `c.cron.set`. */
export interface RivetCronSetOptions {
    action: string;
    args?: unknown[];
    expression: string;
    /** Retained run-history entries. Defaults to 100; 0 disables. */
    maxHistory?: number;
    name: string;
    /** IANA zone. Defaults to UTC. */
    timezone?: string;
}

/**
 * Rivet's durable recurring scheduler — `c.cron`.
 *
 * Registrable **at runtime**, which is what lets this host implement the
 * optional `SchedulerHost.cron`. Cloudflare cannot: its crons are declared in
 * `wrangler.jsonc` and reconciled at build time.
 */
export interface RivetCronLike {
    /** Register (or, on a repeated name, update) a cron-expression job. */
    set: (options: RivetCronSetOptions) => Promise<void>;
}

/**
 * The slice of a Rivet `ActorContext` this host binds to.
 *
 * `db` is required rather than optional: an actor that Lunora mounts a shard on
 * must be declared with `db: db({ onMigrate })`, because the shard's durable
 * state lives in that SQLite database. An actor without it would type-check and
 * then lose every write on sleep.
 */
export interface RivetActorLike {
    /** Recurring schedules — see {@link RivetCronLike}. */
    readonly cron: RivetCronLike;
    /** The actor's own SQLite database — see {@link RivetRawDatabaseLike}. */
    readonly db: RivetRawDatabaseLike;
    /** The actor's key, as passed to `getOrCreate`. Joined to form `ShardHost.shardKey`. */
    readonly key: ReadonlyArray<string>;
    /** One-shot schedules — see {@link RivetScheduleLike}. */
    readonly schedule: RivetScheduleLike;

    /**
     * Hold the actor awake until `promise` settles, within Rivet's sleep grace
     * period. The closest analogue to `ShardHost.waitUntil`, and the reason
     * background work here is not merely "not dropped" (the best a Node process
     * can do) but genuinely deferred against a real lifecycle boundary.
     */
    waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * A live WebSocket inside `onWebSocket`. WinterTC-shaped, so this is the
 * standard `WebSocket` surface narrowed to what the socket host touches.
 */
export interface RivetWebSocketLike {
    /** Bytes queued but not yet flushed, when the transport reports it. */
    readonly bufferedAmount?: number;
    close: (code?: number, reason?: string) => void;
    send: (data: string | ArrayBufferLike | ArrayBufferView | Blob) => void;
}

/**
 * A resolved actor handle from `createClient()` — `client.<name>.getOrCreate(key)`.
 *
 * `fetch` reaches the actor's `onRequest` handler, which is what makes a Rivet
 * actor addressable as a `ShardStub`.
 */
export interface RivetActorHandleLike {
    /** Send an HTTP request to the actor's `onRequest` handler. */
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

/** Options `getOrCreate` accepts, narrowed to the placement hint this host forwards. */
export interface RivetGetOrCreateOptions {
    /**
     * Rivet region slug to create the actor in, honoured only by the call that
     * creates it (an actor never migrates). Deployment-defined — `atl` on Rivet
     * Cloud, operator-named when self-hosting — which is why the directory maps
     * Lunora's region vocabulary through a caller-supplied function rather than
     * guessing.
     */
    createInRegion?: string;
}

/**
 * One actor type on a RivetKit client, narrowed to key-addressed lookup.
 *
 * `getForId`/`create`/`resolve` are deliberately absent: `ShardDirectory` is a
 * deterministic key → stub mapping, and get-or-create is the only operation
 * that expresses it.
 */
export interface RivetActorNamespaceLike {
    getOrCreate: (key: string | string[], options?: RivetGetOrCreateOptions) => RivetActorHandleLike;
}
