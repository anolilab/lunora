import { GENERATED_HEADER } from "./emit";
import { buildDeclarationBlocks, buildFieldLines, buildMethodBlocks, buildShardFactoryBody } from "./emit/app-builder";
import type { EmitAppOptions, ResolvedAppOptions } from "./emit/app-helpers";
import { buildGlobalHelpers, buildSchedulerHelper, buildStorageHelpers } from "./emit/app-helpers";
import buildImportLines from "./emit/app-imports";
import { buildBaseWorkerOptions, buildWorkerOptionLines } from "./emit/app-worker-options";

/** The `export type { ... }` list — only the declaration types that were emitted. */
const buildExportedTypes = (options: ResolvedAppOptions): string =>
    [
        ...(options.hasAuth ? ["AuthDeclaration"] : []),
        "ComposedApp",
        ...(options.hasGlobal ? ["GlobalDeclaration"] : []),
        "LunoraConfig",
        ...(options.hasScheduler ? ["SchedulerDeclaration"] : []),
        "Selector",
        ...(options.hasStorage ? ["StorageDeclaration"] : []),
    ]
        .toSorted((a, b) => a.localeCompare(b))
        .join(", ");

/**
 * Emit `_generated/app.ts` — a fluent, feature-specialized worker-composition
 * builder. Only the methods for capabilities THIS app uses are emitted, so the
 * builder's type surface (IntelliSense) lists exactly what can be configured.
 *
 * Each capability declaration is fanned into BOTH runtime surfaces: the DO-side
 * `createShardDO(...)` factory that backs `ctx.*`, and the worker-side
 * `createWorker(...)` options that back the studio/admin endpoints — so storage
 * / scheduler / global are declared once instead of twice. The builder is pure
 * sugar over the public `createWorker` / `createShardDO`; both stay usable.
 *
 * Lives in generated code (not `@lunora/runtime`, which is dependency-free) so
 * it can import the add-on packages the app installed (`@lunora/auth`,
 * `@lunora/storage`, …) directly.
 */

/**
 * Why the auth request instance is constructed before `ensureMigrated` (the
 * emitted comment is deliberately short — it ships into every user's generated
 * tree, where a description of another package's internals would rot unnoticed).
 *
 * `ensureMigrated` finishes by calling better-auth's
 * `invalidateSchemaChecks(database)`. That call is a NO-OP until something has
 * registered a schema check for the binding: it reads a `WeakMap` entry only
 * `createSchemaCheck` writes, and returns silently when there is none.
 *
 * The adapter-backed request instance is the only thing that registers one
 * (`@lunora/auth`'s `withAuthSchemaCheck`, keyed on the raw D1 binding — the same
 * object `ensureMigrated` invalidates). Building it AFTER the migration therefore
 * left that invalidation inert: a mismatch verdict observed against the
 * pre-migration schema stayed cached for the life of the isolate even though the
 * migration had just fixed it.
 *
 * The cost of the reorder is one pre-migration introspection sweep, and the
 * `console.error` better-auth's eager check logs on a first boot against an
 * unmigrated database. That is noise on a healthy cold start, not a fault.
 *
 * Verified against better-auth 1.7.3; `@better-auth/core/db/internal` is an
 * internal subpath, so re-check on a minor bump.
 */
const emitApp = (rawOptions: EmitAppOptions): string => {
    // `hasVectors` arrives as the platform gate's VERDICT and is consumed as
    // "emit `.vectors()`" — the AND with the app's own declaration happens once,
    // here, exactly as `emitServer` and `emitShard` make it against their
    // `schema`. Normalising up front keeps the three emitters on one convention
    // instead of leaving the conjunction to whichever call site remembered to
    // make it. The `vectors` usage flag (an `@lunora/bindings/vectors` import)
    // does not decide the method — no `appMethod` hangs off that row.
    const hasVectors = (rawOptions.hasVectors ?? true) && (rawOptions.vectorIndexCount ?? 0) > 0;
    const options: ResolvedAppOptions = { ...rawOptions, hasVectors };
    const { hasAuth } = options;

    const declarationBlocks = buildDeclarationBlocks(options);
    const workerOptionLines = buildWorkerOptionLines(options);

    // The auth lazy-init dance is woven through `build()` and `buildWorkerOptions`.
    const authState = hasAuth ? `        let auth: LunoraAuth | null = null;\n        let authInit: Promise<void> | null = null;\n` : "";
    const ensureAuthBlock = hasAuth
        ? `
        const initAuth = async (env: Env): Promise<void> => {
            if (!this.authDeclaration) {
                return;
            }

            const d1 = this.authDeclaration.d1;

            // DO-backed mode builds no instance here: better-auth runs inside the
            // object, which materialises its own schema (the Kysely migrator below is
            // dialect-bound and cannot target DO storage).
            if (!d1) {
                return;
            }

            // Apply the better-auth schema lazily on first request (raw-D1 Kysely
            // migrator). For production run the migrate command ahead of deploy.
            // The migration instance takes the RAW binding: better-auth migrates
            // only through Kysely and rejects the adapter the request instance uses.
            //
            // CONSTRUCTED BEFORE THE MIGRATION, ASSIGNED AFTER IT. Both halves matter:
            // building it first gives \`ensureMigrated\`'s schema-check invalidation a
            // registered check to invalidate, and assigning it only afterwards keeps a
            // concurrent request from serving \`/api/auth/*\` against tables the
            // migrator has not created yet. See \`emit-app.ts\` in @lunora/codegen for
            // the full reasoning.
            //
            // On a first boot against an unmigrated database this means better-auth's
            // eager schema check runs BEFORE the migration, so one
            // "the auth tables do not match…" line on a cold start is expected.
            const requestAuth = createAuth({ ...this.authDeclaration.options(env), database: lunoraD1Adapter(d1(env) as never) });

            await ensureMigrated(createAuth({ ...this.authDeclaration.options(env), database: d1(env) as never }));

            auth = requestAuth;
        };

        // Single-flighted on the PROMISE, not on \`auth\`. Every \`fetch\` awaits this
        // and the body above is async, so a per-isolate cold start runs it once
        // rather than once per concurrent request — better-auth's migrator emits a
        // bare \`CREATE TABLE\` (no IF NOT EXISTS), so a second concurrent run on a
        // fresh database fails with \`table user already exists\` and, because this is
        // awaited ahead of the router, 500s every route. Evicted on failure so a
        // transient error retries instead of being replayed forever.
        const ensureAuth = (env: Env): Promise<void> =>
            (authInit ??= initAuth(env).catch((error: unknown) => {
                authInit = null;
                throw error;
            }));
`
        : "";
    const ensureAuthCall = hasAuth ? `\n                await ensureAuth(env);` : "";
    const getAuthArgument = hasAuth ? `() => auth` : `() => null`;
    const getAuthParameter = hasAuth ? `getAuth: () => LunoraAuth | null` : `_getAuth: () => null`;

    // The underlying `LunoraWorker` factory. With a framework adapter present,
    // `.buildFrameworkWorker(host)` passes a host and composition routes through
    // `withFrameworkWorker` (the host serves everything but `/_lunora/*`);
    // otherwise it's a standalone `createWorker`.
    const buildWorkerLine = options.hasFramework
        ? `        const buildWorker = (env: Env): LunoraWorker =>
            host ? withFrameworkWorker(host, (hostEnv) => this.buildWorkerOptions(hostEnv as Env, ${getAuthArgument})) : createWorker(this.buildWorkerOptions(env, ${getAuthArgument}));`
        : `        const buildWorker = (env: Env): LunoraWorker => createWorker(this.buildWorkerOptions(env, ${getAuthArgument}));`;
    const assembleParameter = options.hasFramework ? `host?: FrameworkHostHandler` : ``;

    // Auto-wire the worker's `email()` handler for `defineAgent({ onEmail })`
    // agents: received mail starts a durable run via `dispatchAgentEmail`
    // (`@lunora/agent/inbound`). Emitted as the DEFAULT `composed.email`, ahead of
    // the manual `.onEmail(...)` override below, so a hand-registered handler still
    // wins. Empty when no `onEmail` agent is declared — email-free (and agent-free)
    // output stays byte-identical.
    const emailAgents = options.emailAgents ?? [];
    const emailAgentsBlock =
        emailAgents.length > 0
            ? `        composed.email = dispatchAgentEmail([
${emailAgents.map((agent) => `            { agent: lunoraAgentDefinitions.${agent.exportName}, className: ${JSON.stringify(agent.className)} },`).join("\n")}
        ]);

`
            : "";

    // Public terminals: always `build()`; `.buildFrameworkWorker(host)` only when
    // a worker-composition framework adapter is a dependency.
    const buildTerminals = `    /** Materialise the standalone Cloudflare worker + \`ShardDO\` class. */
    public build(): ComposedApp {
        return this.assemble();
    }${
        options.hasFramework
            ? `

    /** Compose Lunora's realtime plane INTO a meta-framework's Cloudflare handler (SvelteKit/Astro/Nuxt). The framework \`host\` serves everything except the reserved \`/_lunora/*\` endpoints; pass the adapter-emitted worker (e.g. SvelteKit's \`_worker.js\`, Astro's \`handle\`). */
    public buildFrameworkWorker(host: FrameworkHostHandler): ComposedApp {
        return this.assemble(host);
    }`
            : ``
    }`;

    return `${GENERATED_HEADER}${buildImportLines(options).join("\n")}

/** Read a value off the per-request \`env\`. Returns \`undefined\` to leave the capability unconfigured (its \`ctx.*\`/admin surface stays a clear-error stub). */
type Selector<Env, T> = (env: Env) => T | undefined;

/** The generated \`createShardDO\` config — \`.observability()\`, \`.maxRelationKeys()\` and the long-tail \`.ai()\` / \`.kv()\` / … methods pass straight through to it. */
type ShardConfig = NonNullable<Parameters<typeof createShardDO>[0]>;
${
    options.jurisdiction
        ? `
// Module scope, so every isolate loading this script (the worker and each Durable
// Object class it exports) knows the schema's jurisdiction before a request runs.
// \`@lunora/mail\` reads it to pin its shard RPC like every other DO path.
declareAppJurisdiction(${JSON.stringify(options.jurisdiction)});
`
        : ""
}
${declarationBlocks.join("\n\n")}${declarationBlocks.length > 0 ? "\n\n" : ""}/** The composed app: a Cloudflare module worker (\`fetch\` / \`scheduled\` / optional \`email\`) plus the \`ShardDO\` class binding. */
interface ComposedApp extends LunoraWorker {
    /** Cloudflare Email Routing entry — present only when \`.onEmail(...)\` was configured. */
    email?: (message: unknown, env: unknown, context: ExecutionContextLike) => Promise<void>;
    /** The generated shard Durable Object class — re-export it as a named export so wrangler can bind it. */
    ShardDO: ReturnType<typeof createShardDO>;
}

/**
 * Fluent worker-composition builder. Records each capability declaration, then
 * \`.build()\` fans them into the DO-side \`createShardDO\` factory and the
 * worker-side \`createWorker\` options — constructing the worker lazily on the
 * first request so per-isolate singletons are built once.
 */
class AppBuilder<Env extends object> {
${buildFieldLines(options).join("\n")}

    private emailHandler?: (env: Env) => (message: unknown, env: unknown, context: ExecutionContextLike) => Promise<void>;

${buildMethodBlocks(options).join("\n\n")}

${buildTerminals}

    /** Build the shard DO + compose the worker (standalone or framework-hosted), wrapping the lazy per-isolate singletons + auth init. */
    private assemble(${assembleParameter}): ComposedApp {
        const ShardDO = createShardDO({${buildShardFactoryBody(options)}});

        // Per-isolate singletons: the worker (and auth instance) are expensive to
        // build, so the first request constructs them and every later request on
        // the same isolate reuses them.
        let worker: LunoraWorker | null = null;
${authState}${ensureAuthBlock}
${buildWorkerLine}

        const composed: ComposedApp = {
            ShardDO,
            fetch: async (request: Request, rawEnv: unknown, context: ExecutionContextLike): Promise<Response> => {
                const env = rawEnv as Env;${ensureAuthCall}
                worker ??= buildWorker(env);

                return worker.fetch(request, rawEnv, context);
            },
            scheduled: async (controller: ScheduledControllerLike, rawEnv: unknown, context: ExecutionContextLike): Promise<void> => {
                worker ??= buildWorker(rawEnv as Env);

                return worker.scheduled(controller, rawEnv, context);
            },
            serverQuery: (request, rawEnv, reference, args, options) => {
                worker ??= buildWorker(rawEnv as Env);

                return worker.serverQuery(request, rawEnv, reference, args, options);
            },${
                // Emitted for a framework-hosted app even with no push queues of its
                // own: `withFrameworkWorker` hands the FRAMEWORK host's `queue` back
                // out of the composed worker, and without this key wrangler never sees
                // it. On workerd a consumer that returns without throwing implicitly
                // acks, so the host's messages were not merely unprocessed — they were
                // acked and destroyed.
                options.hasQueue || options.hasFramework
                    ? `
            queue: async (batch: unknown, rawEnv: unknown, context: ExecutionContextLike): Promise<void> => {
                worker ??= buildWorker(rawEnv as Env);

                return worker.queue?.(batch, rawEnv, context);
            },`
                    : ""
            }
        };

${emailAgentsBlock}        if (this.emailHandler) {
            const handler = this.emailHandler;

            composed.email = (message, rawEnv, context) => handler(rawEnv as Env)(message, rawEnv, context);
        }
${
    options.hasFramework
        ? `
        // A framework host may export its own \`email\` (Nitro's \`cloudflare-module\`
        // does). Nothing in Lunora serves one, so when the app registered no handler
        // of its own the host's is the only one there is — forward to it rather than
        // dropping the entry.
        if (!composed.email && host && typeof host === "object" && typeof host.email === "function") {
            composed.email = (message, rawEnv, context) => {
                worker ??= buildWorker(rawEnv as Env);

                return worker.email?.(message, rawEnv, context) ?? Promise.resolve();
            };
        }
`
        : ""
}
        return composed;
    }
${buildSchedulerHelper(options)}${buildStorageHelpers(options.hasStorage)}
    /** Fan the recorded declarations into the worker-side \`createWorker\` options. */
    private buildWorkerOptions(env: Env, ${getAuthParameter}): WorkerOptions {
        const options: WorkerOptions = {
${buildBaseWorkerOptions(options).join("\n")}
        };

        if (this.adminToken) {
            options.adminToken = this.adminToken(env);
        }

${workerOptionLines.join("\n\n")}${workerOptionLines.length > 0 ? "\n\n" : ""}        for (const fn of this.extendFns) {
            Object.assign(options, fn(env, { ...options }));
        }

        return options;
    }
}
${buildGlobalHelpers(options.hasGlobal)}
/**
 * Shape of the project's root \`lunora.config.*\`.
 *
 * Declared HERE, not in a package, so the \`app\` hook is typed against THIS
 * project's builder with no annotation to keep in step — and so the config file
 * needs only a type-only import, which is erased. That matters: the hook is
 * bundled into the worker, and a runtime import in that file ships with it.
 */
interface LunoraConfig<Env extends object = object> {
    /** Codegen's static advisor. \`minSeverity\` is the lowest level it reports and writes into \`_generated/shard.ts\`; an \`"error"\` is never dropped, so the gate that fails codegen stays on. A literal, for the same reason as \`target\`. */
    advisor?: { minSeverity?: "error" | "info" | "warn" };
    /** Receives this project's \`defineApp()\` builder and returns it — where a Vite-first app makes the builder calls its generated entry cannot derive. */
    app?: (app: AppBuilder<Env>) => AppBuilder<Env>;
    /** Opt into remote-binding dev without \`--remote\` or \`LUNORA_REMOTE\` on every run. A literal, for the same reason as \`target\`. */
    remote?: boolean;
    /** Sibling Workers the app calls through service bindings — key → its folder and, for RPC, the exported \`WorkerEntrypoint\` class (\`rpc: false\` binds that class but calls it with plain \`fetch\`, without importing the service's sources). Becomes \`ctx.services.<key>\` in actions, a wrangler \`services[]\` entry, one \`lunora dev\` session and a services-first \`lunora deploy\`. Literals, for the same reason as \`target\`. */
    services?: Record<string, { dir: string; entrypoint?: string; rpc?: false }>;
    /** Deploy target id — \`lunora deploy\`/\`verify\` read it when no \`--target\` is passed. Must be a literal: \`runCodegen\` resolves it synchronously by PARSING this file, so a computed value is not seen — \`lunora verify\` reports \`platform_unreadable_target\` rather than defaulting in silence. */
    target?: string;
}

/**
 * Start composing the app. Chain the capability methods, then \`.build()\`.
 *
 * \`Env\` is constrained to \`object\`, not \`Record<string, unknown>\`: an \`interface Env\`
 * — which is what wrangler's generated \`worker-configuration.d.ts\` gives you, and
 * what any app with its own bindings declares — is NOT assignable to an index
 * signature, so the stricter bound forced every real app to write
 * \`type AppEnv = Env & Record<string, unknown>\`. The builder only ever reads \`env\`
 * through the selectors you pass it, so the looser bound costs nothing.
 */
const defineApp = <Env extends object>(): AppBuilder<Env> => new AppBuilder<Env>();

export { AppBuilder, defineApp };
export type { ${buildExportedTypes(options)} };
`;
};

export { emitApp };
export type { EmitAppOptions } from "./emit/app-helpers";
