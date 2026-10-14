/* eslint-disable no-secrets/no-secrets -- emitted builder source: the string fragments are framework API type names (e.g. "SchedulerDeclaration<Env>"), not credentials. */
import type { TableIR } from "../ir";
import type { ResolvedAppOptions } from "./app-helpers";
import { hasShardedTables } from "./app-helpers";

/**
 * The schema's jurisdiction, pinned onto the DO-backed auth object: it holds
 * users, sessions, and credentials, so it must live where every other DO does.
 * Only once the move is acknowledged — see `EmitAppOptions.jurisdictionPinsAuth`.
 */
const doAuthJurisdictionLine = (options: ResolvedAppOptions): string =>
    options.jurisdiction && options.jurisdictionPinsAuth === true
        ? `
                // The schema's jurisdiction pins the auth object like every other DO.
                jurisdiction: ${JSON.stringify(options.jurisdiction)},`
        : "";

/** A table's IR shard mode as a runtime `ShardingInfo` literal. */
const shardingLiteral = (shardMode: TableIR["shardMode"]): string =>
    typeof shardMode === "string"
        ? `{ mode: { kind: ${JSON.stringify(shardMode)} } }`
        : `{ mode: { field: ${JSON.stringify(shardMode.field)}, kind: "shardBy" } }`;

/**
 * The worker's view of the schema's tables: the literal table map behind
 * `listSchemaTables` / `resolveTableSharding`, and — for a schema with
 * `.shardBy()` tables — the coordinator over the declared shard registry.
 */
const buildTableShardingLines = (options: ResolvedAppOptions): string[] => [
    // Export's answer to "every table". Shard discovery unions each named table's
    // live shard keys, so an export that names none discovers none — which is how
    // `lunora export` with no `--tables`, and the scheduled backup with
    // `backupTables` omitted, used to write a file holding only `.global()` rows.
    // The same map answers `resolveTableSharding`: without it every import row
    // routes to the default shard, and the worker's default shard registry cannot
    // tell a `.shardBy()` table (which it must refuse) from a root one (which it
    // can serve). Emitted for every app (a literal, so it needs no `schema`
    // import) and skipped only for an empty schema.
    ...(options.tables.length > 0
        ? [
              `        const tableSharding = new Map<string, ShardingInfo>([
${options.tables.map((table) => `            [${JSON.stringify(table.name)}, ${shardingLiteral(table.shardMode)}],`).join("\n")}
        ]);

        options.listSchemaTables = () => [...tableSharding.keys()];
        options.resolveTableSharding = (table) => tableSharding.get(table);`,
          ]
        : []),
    // A declared registry replaces the worker's default one, which refuses every
    // `.shardBy()` table because it cannot know which shard keys hold rows.
    ...(hasShardedTables(options)
        ? [
              `        const shardRegistry = this.shardRegistrySelector?.(env);

        if (shardRegistry) {
            options.queryCoordinator = createQueryCoordinator({ registry: createDynamicShardRegistry({ ${options.jurisdiction ? `jurisdiction: ${JSON.stringify(options.jurisdiction)}, ` : ""}namespace: shardRegistry }) });
        }`,
          ]
        : []),
];

/** The per-capability blocks of `buildWorkerOptions` (the worker-side fan-out). */
const buildWorkerOptionLines = (options: ResolvedAppOptions): string[] => [
    ...buildTableShardingLines(options),
    ...(options.hasScheduler
        ? [
              `        if (this.schedulerDeclaration) {
            options.schedulerDO = this.schedulerDeclaration.namespace(env);
        }`,
          ]
        : []),
    ...(options.hasWorkflow
        ? [
              // Resolve the Workflows REST client from the request env so the studio's
              // \`/_lunora/admin/workflows*\` proxy can read instance/step state; returns
              // undefined (→ "not configured") until the CF account id + API token are set.
              `        options.workflowsClient = (workflowEnv) => {
            const source = workflowEnv as Record<string, unknown>;
            const accountId = source["CLOUDFLARE_ACCOUNT_ID"];
            const apiToken = source["CLOUDFLARE_API_TOKEN"];

            return typeof accountId === "string" && accountId !== "" && typeof apiToken === "string" && apiToken !== ""
                ? createWorkflowsRestClient({ accountId, apiToken })
                : undefined;
        };`,
          ]
        : []),
    ...(options.hasGlobal
        ? [
              `        if (this.globalDeclaration) {
            const database = this.globalDeclaration.d1(env);

            if (database) {
                options.globalIntrospector = buildGlobalIntrospector(database);
                // \`importGlobals\` wires the admin bulk-import endpoint's global
                // plane: the rows \`resolveTableSharding\` classifies as \`.global()\`
                // land here, and without it they are reported, not written.
                options.importGlobals = buildGlobalImporter(database, this.cdcEnabled);
                // The read/replay half of the same admin plane. Each one is the
                // only reason its endpoint can see the global storage plane at
                // all, and every one of them fails SILENTLY when unset — export
                // and \`lunora backup create\` answer 200 having written only
                // shard-local rows (an export→import round trip then restores
                // cleanly minus every global row), CDC sync answers with only
                // shard changes, and point-in-time apply reports
                // \`globalApplied: 0\`. Nothing here is project-specific either.
                options.exportGlobals = buildGlobalExporter(database);
                options.syncGlobals = buildGlobalCdcSync(database);
                options.applyGlobals = buildGlobalCdcApplier(database, this.cdcEnabled);
            }
        }`,
          ]
        : []),
    ...(options.hasStorage
        ? [
              // The admin ops back the studio file browser; \`storage\` is the
              // app-facing capability, and is what gives an HTTP action a
              // \`ctx.storage\` without a hop through a scheduled action.
              `        if (this.storageDeclaration) {
            Object.assign(options, this.buildStorageAdmin(env));
            options.storage = (rawEnv: unknown, origin?: string) => this.resolveStorage(rawEnv as Env, origin);
        }`,
          ]
        : []),
    // The studio's KV browser is wired zero-config: `createKvIntrospectorFromEnv`
    // scans `env` for every bound Workers KV namespace, so each `kv_namespaces`
    // entry in wrangler.jsonc appears under its binding name (any name, any count)
    // with no manual `createKvIntrospector` call. A deployment with no KV binding
    // yields an empty namespace list rather than crashing.
    ...(options.hasKvIntrospector ? [`        options.kvIntrospector = createKvIntrospectorFromEnv(env);`] : []),
    // The studio's Vectorize browser, on the SAME flag that emits the `.vectors()`
    // builder and that `studioFeatures.vectors` gates the nav tab on — so a visible
    // Vectors tab always has a working backend, never the reverse. Without this the
    // page and the home-screen "Vectorize Indexes" card both call
    // `/_lunora/admin/vector/indexes` and get 400 `VECTORS_NOT_CONFIGURED`.
    //
    // The index map is the app's OWN `.vectors(...)` selector — the same
    // `name → binding` mapping the DO uses — rather than a re-scan of `env`, so an
    // arbitrary binding name resolves to its logical index without guessing.
    // Embedders live on the schema's `.vectorize()` options and are not reachable
    // from here, so `queryIndex` is withheld and similarity search reports
    // `VECTOR_QUERY_UNSUPPORTED`; listing indexes and their live stats works.
    ...(options.hasVectors
        ? [
              `        if (this.shardExtras.vectors) {
            options.vectorIntrospector = createVectorAdminIntrospector({
                indexes: this.shardExtras.vectors(env as unknown as Record<string, unknown>),
                registry: LUNORA_VECTOR_INDEXES,
            });
        } else {
            // Emitted only when the schema declares an index, so reaching here
            // means the app declared one and never bound it. The studio's
            // Vectors tab is on (its flag is the same index count) and every
            // request to it would answer VECTORS_NOT_CONFIGURED, while
            // \`ctx.vectors\` is the throwing stub — so this is already broken,
            // just later and less legibly. Same shape as \`.auth()\`'s guards.
            throw new Error(
                ".vectors(): the schema declares vector index(es) but no binding map was chained. Pass \`.vectors((env) => ({ <indexName>: env.<BINDING> }))\` so \`ctx.vectors\` resolves and the studio's Vectors tab can list them.",
            );
        }`,
          ]
        : []),
    // The studio's Notifications page reads the app's registered `@lunora/notify`
    // device subscriptions through the SAME store the handlers register into. The
    // store is built from `env` via `lunora/notify.ts`'s `defineNotify({ store })`;
    // when no `store` is configured (the in-memory default), the gated
    // `__lunora_admin__:listPushSubscriptions` RPC returns an empty device list.
    // The `env` cast is load-bearing: `defineApp`'s `Env` is bound to `object` (so a
    // wrangler-generated `interface Env` is accepted), while `defineNotify`'s `store`
    // factory takes `NotifyEnv` — an index signature an interface does not satisfy.
    // Without it every app with a `lunora/notify.ts` emits an app.ts that fails tsc.
    ...(options.hasNotify
        ? [`        options.notifySubscriptionStore = notifyConfig.store ? notifyConfig.store(env as Record<string, unknown>) : undefined;`]
        : []),
    // The studio's Logs → Archive feed is wired zero-config: when the operator sets
    // `LUNORA_LOG_ARCHIVE_TABLE` (the R2 Data Catalog table `pipelineLogSink` writes
    // to), the durable archive becomes readable; unset ⇒ `undefined` ⇒ the feed
    // reports "not configured". The R2 SQL credentials come from `R2_SQL_*` env vars.
    `        options.logArchive = resolveLogArchiveFromEnv(env);`,
    ...(options.hasAuth
        ? [
              `        // Captured before the branch so the narrowing survives — reading
        // \`this.authDeclaration.namespace\` again below would be optional all over again.
        const authDeclaration = this.authDeclaration;
        const authNamespace = authDeclaration?.namespace;
        const authD1 = authDeclaration?.d1;

        if (authDeclaration && authNamespace) {
            // DO-backed mode. The auth tables live inside the object and DO storage is
            // unreachable from here, so better-auth runs in there and this worker talks
            // to it. \`createDoAuthWiring\` is a tested function in \`@lunora/auth\` rather
            // than more emitted code: request-path logic in generated output can only be
            // typechecked, never unit-tested.
            const authWiring = createDoAuthWiring({
                // The OAuth discovery documents (an \`mcp()\` resource's metadata, the
                // issuer's) are derived here from the declared options, so the worker
                // forwards only those exact paths and no other probe reaches the object.
                // Memoised on the declaration: a framework-hosted worker rebuilds these
                // options per request, and \`options(env)\` rebuilds every plugin.
                discoveryPaths: authDiscoveryPathsFor(authDeclaration, env),
                internalSecret: authDeclaration.internalSecret?.(env),${doAuthJurisdictionLine(options)}
                namespace: authNamespace(env),
                objectName: authDeclaration.objectName?.(env),
            });

            options.authHandler = authWiring.authHandler;
            options.authDiscoveryHandler = authWiring.discoveryHandler;
            options.resolveIdentity = authWiring.resolveIdentity;
            // The audit log lives in the object like every other auth table, so the feed
            // reads through it rather than querying D1.
            options.authAuditReader = authWiring.auditReader;
            // Set only once auth is pinned to a jurisdiction: copies the users left in the
            // un-pinned object across (\`__lunora_admin__:copyAuthToJurisdiction\`).
            options.authJurisdictionMove = authWiring.jurisdictionMove;
            // \`authAdmin\` stays D1-only: its ~30 methods read the auth tables directly
            // from the worker, which DO storage does not allow. The studio's auth pages
            // therefore report "not configured" in this mode rather than silently
            // returning empty data.
        } else if (authDeclaration && authD1) {
            options.authHandler = (request) => {
                const auth = getAuth();

                return auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined);
            };
            // The OAuth discovery documents outside \`/api/auth\` (served only with an
            // \`mcp()\` or \`oauthProvider()\` plugin, and only after the app's own routes).
            options.authDiscoveryHandler = (request) => {
                const auth = getAuth();

                return auth ? handleAuthDiscoveryRequest(auth, request) : Promise.resolve(undefined);
            };
            options.resolveIdentity = async (request) => {
                const auth = getAuth();

                if (!auth) {
                    return null;
                }

                const session = await auth.api.getSession({ headers: (request as Request).headers });

                if (!session?.user?.id) {
                    return null;
                }

                // \`role\` rides along so \`rls(policies, { roles })\` and \`auth.can(...)\`
                // work on this wiring without a hand-written resolver. better-auth's
                // \`admin()\` plugin owns that column (comma-joined for multiple roles)
                // and only an administrator can write it; it is absent when the plugin
                // is off, which reads as no roles.
                //
                // \`expiresAtMs\` is the socket credential expiry the runtime forwards
                // as \`x-lunora-identity-exp\`. Without it the DO's expiry check never
                // fires, so a signed-out, banned or lapsed user keeps streaming their
                // RLS-scoped rows over an already-open WebSocket while every HTTP call
                // is anonymous. better-auth hands back a \`Date\`; anything else means
                // the adapter did not hydrate it, and omitting beats guessing.
                const expiresAt = session.session.expiresAt;
                // \`email\` and \`name\` are the claims \`ctx.auth.getIdentity()\` is
                // documented to carry ("email, name, roles, custom claims"). Without
                // them the documented \`me\` query — \`identity?.email\` — resolves
                // \`undefined\` on the built-in wiring. Empty strings are dropped so an
                // absent claim reads as absent rather than as "".
                const user = session.user as { email?: unknown; name?: unknown; role?: unknown };

                return {
                    ...(typeof user.email === "string" && user.email.length > 0 ? { email: user.email } : {}),
                    ...(expiresAt instanceof Date ? { expiresAtMs: expiresAt.getTime() } : {}),
                    ...(typeof user.name === "string" && user.name.length > 0 ? { name: user.name } : {}),
                    role: user.role,
                    userId: session.user.id,
                };
            };
            const authInstance = getAuth();

            options.authAdmin = authInstance ? createAuthAdmin(authInstance) : undefined;
            options.authAuditReader = createAuthAuditReader(d1Executor(authD1(env) as never));
        }`,
          ]
        : []),
    // Cloudflare Access — runs AFTER the auth block so it can compose ahead of
    // the better-auth resolver rather than clobber it. With `.auth()` present,
    // a request carrying a verified Access JWT is authenticated by Access and
    // everyone else falls through to the app session; without it, Access is the
    // sole resolver.
    ...(options.hasAccess
        ? [
              options.hasAuth
                  ? `        if (this.accessSelector) {
            const accessResolver = createAccessResolver(this.accessSelector(env));
            const fallback = options.resolveIdentity;

            options.resolveIdentity = fallback ? composeResolvers(accessResolver, fallback) : accessResolver;
        }`
                  : `        if (this.accessSelector) {
            options.resolveIdentity = createAccessResolver(this.accessSelector(env));
        }`,
          ]
        : []),
    // Voice-enabled agents: map each export name to its `VOICE_*` Durable Object
    // namespace so the runtime serves `/_lunora/voice/<exportName>`. Read off
    // `env` structurally (the binding is provisioned by the config layer's
    // reconcile step, so it may not be on the generated `Env` type). Emitted only
    // when at least one agent opted into voice — voice-free output is unchanged.
    ...(options.voiceAgents && options.voiceAgents.length > 0
        ? [
              `        options.voiceAgents = {
${options.voiceAgents
    .map(
        (agent) =>
            `            ${JSON.stringify(agent.exportName)}: (env as Record<string, unknown>)[${JSON.stringify(agent.bindingName)}] as ShardNamespaceLike,`,
    )
    .join("\n")}
        };`,
          ]
        : []),
];

/** The `shardDO` + spec fields the worker always (or conditionally) carries. */
const buildBaseWorkerOptions = (options: ResolvedAppOptions): string[] => [
    `            cronJobs: LUNORA_CRONS,`,
    `            functions: LUNORA_FUNCTIONS,`,
    // The declared `defineIdentity(...)` contract — wires the runtime trust
    // boundary so `wrapResolverWithContract` validates every resolved identity
    // against it before it becomes `ctx.auth`. Emitted only when the app declares
    // a contract, so apps without one keep unchanged output.
    ...(options.identity ? [`            identity: lunoraIdentityContract.${options.identity.exportName},`] : []),
    // Schema `.jurisdiction("…")` pins every DO the worker reaches to the
    // Cloudflare data-residency region. Emitted only when declared, so apps
    // without it keep the un-pinned global namespace (and unchanged output).
    ...(options.jurisdiction ? [`            jurisdiction: ${JSON.stringify(options.jurisdiction)},`] : []),
    ...(options.wantsArchitecture ? [`            architecture,`] : []),
    ...(options.wantsOpenApi ? [`            openApiSpec,`] : []),
    ...(options.wantsOpenRpc ? [`            openRpcSpec,`] : []),
    // The push-consumer handler backing the worker's `queue(batch, …)` entry:
    // routes each delivered batch to its `defineQueue` handler. Built from
    // `@lunora/queue` here (keeping the runtime decoupled) and wired only when the
    // app declares push queues in `lunora/queues.ts`. In a dev environment (or with
    // `LUNORA_QUEUE_CAPTURE`), every consumed message is recorded into the studio's
    // Queues log via the root shard's `recordQueueMessage` admin RPC.
    ...(options.hasQueue
        ? [
              `            queue: (batch: unknown, queueEnv: unknown, _context: ExecutionContextLike, trigger: TriggerTrace): Promise<void> =>`,
              `                dispatchQueueBatch(batch as Parameters<typeof dispatchQueueBatch>[0], LUNORA_QUEUE_REGISTRY, {`,
              `                    capture: shouldCaptureQueue(queueEnv as Record<string, unknown>)`,
              `                        ? createQueueCaptureSink(queueEnv as Record<string, unknown>${
                  options.jurisdiction ? `, { jurisdiction: ${JSON.stringify(options.jurisdiction)} }` : ""
              })`,
              `                        : undefined,`,
              `                    env: queueEnv as Record<string, unknown>,`,
              // The consumer's `ctx.run` joins the queue invocation's trace instead
              // of minting a fresh one per dispatched function.
              `                    traceparent: trigger.traceparent,`,
              `                }),`,
          ]
        : []),
    // Spread so an unset `.httpRouter()` leaves the key absent rather than
    // explicitly `undefined` — `createWorker` treats the two the same, but the
    // emitted options object reads as "not configured" either way.
    `            ...(this.httpRouterApp ? { httpRouter: this.httpRouterApp } : {}),`,
    `            routes: this.routeMap,`,
    `            shardDO: this.shardSelector?.(env) ?? (undefined as unknown as ShardNamespaceLike),`,
];

export { buildBaseWorkerOptions, buildWorkerOptionLines };
