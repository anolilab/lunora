import { LunoraError } from "@lunora/errors";

import compileArgsValidator from "../compile-validator";
import type { AgentIR, FunctionIR, MigrationIR, MutatorIR, ShapeIR } from "../ir";
import sanitizeNamespace from "../paths";
import { groupByFileSorted, renderAgentFunctionRegistry, renderSandboxFunctionRegistry } from "./api";
import { rebaseRelativeQualifiers, referencedDataModelImports, referenceReturnType, relocateBaseQualifiers } from "./qualifiers";
import emitServer from "./server";
import { baseSpecifiers, GENERATED_HEADER, IMPORT_PATH_RE, renderArgsType, renderObjectKey, renderPropertyKey } from "./shared";

/**
 * Convert a raw file path into a JS-identifier-safe alias used as the
 * imported namespace inside `_generated/server.ts`. Keeps the path
 * recognisable in the generated source while satisfying the lexer.
 */
const moduleAlias = (filePath: string, index: number): string => `lunora_${sanitizeNamespace(filePath)}_${String(index)}`;

/**
 * The `callRegistered` helper emitted into `functions.ts` — the shared dispatch
 * shim every `createCaller` leaf routes through. Hoisted to module scope so the
 * emitter body reads as composition rather than a wall of escaped TS.
 */
const CALL_REGISTERED_HELPER = `const callRegistered = async <R>(context: CallerCtx, functionPath: string, args: Record<string, unknown> | undefined): Promise<R> => {
    const registered = LUNORA_FUNCTIONS[functionPath];

    if (!registered) {
        throw new LunoraError("FUNCTION_NOT_FOUND", \`function not registered: \${functionPath}\`);
    }

    // A mutation is routed through the caller's own \`ctx.runMutation\` rather than
    // invoked directly, so \`createCaller(ctx).ns.someMutation()\` gets exactly what
    // \`ctx.runMutation(api.ns.someMutation)\` gets: the BEGIN/COMMIT span (or the
    // enclosing one, when the caller is already inside a transaction), the jobs it
    // schedules held until that span commits, and the deferred object deletes
    // flushed only once it has. Called straight, a mutation composed from an action
    // or a stream had none of the three — its writes autocommitted one row at a
    // time and its \`ctx.scheduler\` calls dispatched immediately, so a mid-handler
    // throw left the earlier writes durable and the job already enqueued.
    //
    // The fallback covers a context that is not a shard dispatch (\`runMutation\` is
    // installed by \`buildCtx\` on every kind but a query's TYPE omits it); there is
    // no transaction to join in that case, so a direct call is all there is.
    //
    // A query is routed through \`ctx.runQuery\` for the same reason: that is what
    // hands it a query view of a mutation's or action's ctx (no request origin,
    // query-guarded \`run*\`) instead of the caller's own.
    if (registered.kind === "mutation" || registered.kind === "query") {
        const run = (context as { runMutation?: unknown; runQuery?: unknown })[registered.kind === "mutation" ? "runMutation" : "runQuery"];

        if (typeof run === "function") {
            return (await run.call(context, { __lunoraRef: functionPath }, args ?? {})) as R;
        }
    }

    return (await registered.handler(context, args ?? {})) as R;
};`;

/**
 * Build the per-user-module import aliases plus the `LUNORA_FUNCTIONS` /
 * `LUNORA_MIGRATIONS` table bodies emitted into `functions.ts`. One import alias
 * per distinct source file: functions register first (preserving the prior alias
 * numbering), then migration-only files pick up the next indices —
 * deterministic across runs. Returns the ready-to-splice string fragments.
 */
const renderFunctionRegistry = (
    functions: ReadonlyArray<FunctionIR>,
    migrations: ReadonlyArray<MigrationIR>,
    mutators: ReadonlyArray<MutatorIR> = [],
    shapes: ReadonlyArray<ShapeIR> = [],
): { dispatchBody: string; importBlock: string; installBlock: string; migrationBody: string; mutatorPaths: ReadonlyArray<string>; shapeBody: string } => {
    const aliasByPath = new Map<string, string>();

    const registerPath = (filePath: string): void => {
        if (!aliasByPath.has(filePath)) {
            aliasByPath.set(filePath, moduleAlias(filePath, aliasByPath.size));
        }
    };

    for (const definition of functions) {
        registerPath(definition.filePath);
    }

    for (const migration of migrations) {
        registerPath(migration.filePath);
    }

    // Mutators + shapes live in fixed files (`mutators`/`shapes`) distinct from
    // any function/migration file, so they pick up fresh aliases LAST — existing
    // function/migration alias numbering is preserved untouched, keeping the
    // golden output byte-identical for shape/mutator-free projects.
    for (const mutator of mutators) {
        registerPath(mutator.filePath);
    }

    for (const shape of shapes) {
        registerPath(shape.filePath);
    }

    const importLines = [...aliasByPath.entries()]
        .map(([filePath, alias]) => {
            if (!IMPORT_PATH_RE.test(filePath)) {
                throw new LunoraError("INTERNAL", `@lunora/codegen: refusing to emit import for unsafe file path: ${JSON.stringify(filePath)}`);
            }

            return `import * as ${alias} from "../${filePath}.js";`;
        })
        .join("\n");

    // Functions arrive pre-sorted by `${filePath}:${exportName}`, so same-file
    // entries stay contiguous and the alias lookup is always populated.
    const dispatchEntries = functions
        .map(
            (definition) =>
                `    "${sanitizeNamespace(definition.filePath)}:${definition.exportName}": ${aliasByPath.get(definition.filePath) ?? ""}.${definition.exportName} as unknown as RegisteredLunoraFunction,`,
        )
        .join("\n");

    const migrationEntries = migrations
        .map(
            (migration) =>
                `    ${JSON.stringify(migration.id)}: ${aliasByPath.get(migration.filePath) ?? ""}.${migration.exportName} as unknown as RegisteredDataMigration,`,
        )
        .join("\n");

    // Custom mutators register into the SAME `LUNORA_FUNCTIONS` table as ordinary
    // procedures (their `kind: "mutation"` makes `handleRpc` transaction-wrap the
    // authoritative `server` impl). The entries are appended after the function
    // entries so a project with no mutators emits a byte-identical dispatch body.
    const mutatorEntries = mutators
        .map(
            (mutator) =>
                `    "${sanitizeNamespace(mutator.filePath)}:${mutator.exportName}": ${aliasByPath.get(mutator.filePath) ?? ""}.${mutator.exportName} as unknown as RegisteredLunoraFunction,`,
        )
        .join("\n");

    // Shape registry body: one `"exportName": shapesAlias.exportName` entry the
    // generated DO's `resolveShape` override dispatches `shape_subscribe` against.
    const shapeEntries = shapes
        .map((shape) => `    "${shape.exportName}": ${aliasByPath.get(shape.filePath) ?? ""}.${shape.exportName} as unknown as RegisteredShape,`)
        .join("\n");

    // The `namespace:fn` paths the DO's `isCustomMutator` override routes through
    // the client-watermark push protocol — exactly the `LUNORA_FUNCTIONS` keys above.
    const mutatorPaths = mutators.map((mutator) => `${sanitizeNamespace(mutator.filePath)}:${mutator.exportName}`);

    // Splice mutator entries onto the function dispatch body (both already sorted
    // by `${filePath}:${exportName}`); `filter` keeps the joiner clean when either side is empty.
    const combinedDispatch = [dispatchEntries, mutatorEntries].filter((entries) => entries.length > 0).join("\n");

    // AOT-compiled argument validators. For each function whose args are fully
    // structural (no `.check(...)` refinement, no unmodelled validator kind) we
    // emit a specialised fast-path parser and install it onto the function's live
    // `.args` object — the same reference the procedure builder validates against,
    // so dispatch transparently uses it (and falls back to the interpreted parser
    // for anything the fast path defers). See `./compile-validator`.
    const installLines = functions
        .map((definition) => {
            // Skip argless functions (nothing to accelerate) and lifecycle hooks
            // (no `.args`). Refinements (`.check`) and unmodelled validators are
            // declined by `compileArgsValidator` itself (returns undefined below).
            if (definition.lifecycle || Object.keys(definition.args).length === 0) {
                return undefined;
            }

            const compiled = compileArgsValidator(definition.args);

            if (compiled === undefined) {
                return undefined;
            }

            const alias = aliasByPath.get(definition.filePath) ?? "";

            return `installCompiledValidatorMap(${alias}.${definition.exportName}.args, ${compiled});`;
        })
        .filter((line): line is string => line !== undefined)
        .join("\n");

    return {
        dispatchBody: combinedDispatch.length > 0 ? `\n${combinedDispatch}\n` : "",
        importBlock: importLines.length > 0 ? `${importLines}\n\n` : "",
        installBlock: installLines,
        migrationBody: migrationEntries.length > 0 ? `\n${migrationEntries}\n` : "",
        mutatorPaths,
        shapeBody: shapeEntries.length > 0 ? `\n${shapeEntries}\n` : "",
    };
};

/**
 * Render the typed `Caller` interface and the `createCaller` object body for a
 * set of functions, both grouped by namespace. The caller surfaces **every**
 * registered function — public *and* internal — because server-to-server calls
 * legitimately reach internal functions (mirroring `ctx.run*`). Each leaf is
 * `(args) => Promise<Return>`; `args` is optional only when the function takes
 * none. The runtime leaves dispatch through `callRegistered`, which infers the
 * return type from the interface's contextual type.
 *
 * `Return` comes from {@link referenceReturnType}, so a declared `.output()`
 * wins over the handler's inferred type here exactly as it does in `api.ts`.
 * Reading `definition.returnType` directly is what let the two surfaces
 * disagree: `ctx.run*` through the caller saw a field the validator declares
 * `v.optional(...)` as required, and a `v.string()` narrowed to a branded
 * `Id<...>` — while `api.ts`, one function away, described the same procedure
 * correctly.
 */
const renderCaller = (functions: ReadonlyArray<FunctionIR>): { implementation: string; types: string } => {
    const ordered = groupByFileSorted(functions);

    const types = ordered
        .map(([file, list]) => {
            const members = list
                .map((definition) => {
                    const argsType = rebaseRelativeQualifiers(renderArgsType(definition.args), definition.filePath);
                    const optional = argsType === "{}" ? "?" : "";
                    const returnType = rebaseRelativeQualifiers(referenceReturnType(definition), definition.filePath);

                    // A `stream` handler returns an `AsyncIterable<T>` *synchronously*;
                    // `callRegistered` awaits the handler, and awaiting a non-thenable
                    // async-iterable yields the iterable itself. So the leaf resolves to
                    // `AsyncIterable<T>`, not a single element `T`. (Note `unwrapHandlerReturn`
                    // already unwrapped the iterable to its element type — and
                    // `referenceReturnType` keeps a stream on that inferred type rather
                    // than an inert `.output()`, so this is still the element type.)
                    if (definition.kind === "stream") {
                        return `        ${definition.exportName}: (args${optional}: ${argsType}) => Promise<AsyncIterable<${returnType}>>;`;
                    }

                    return `        ${definition.exportName}: (args${optional}: ${argsType}) => Promise<${returnType}>;`;
                })
                .join("\n");

            return `    ${renderPropertyKey(sanitizeNamespace(file))}: {\n${members}\n    };`;
        })
        .join("\n");

    const implementation = ordered
        .map(([file, list]) => {
            const namespace = sanitizeNamespace(file);
            const leaves = list
                .map(
                    (definition) =>
                        `        ${renderObjectKey(definition.exportName)}: (args) => callRegistered(context, "${namespace}:${definition.exportName}", args),`,
                )
                .join("\n");

            // The object key is quoted when `namespace` isn't a bare identifier
            // (leading-digit filename); the `"${namespace}:..."` dispatch ref
            // strings above already embed the raw value, so both still agree.
            return `    ${renderObjectKey(namespace)}: {\n${leaves}\n    },`;
        })
        .join("\n");

    return { implementation, types };
};

/**
 * Emit `_generated/functions.ts` — a static dispatch table that maps
 * `${namespace}:${fnName}` keys to the registered handler objects (and a
 * `LUNORA_MIGRATIONS` registry keyed by migration id), plus the typed
 * server-to-server `createCaller`. A `ShardDO` subclass and the worker entry
 * plug these straight into `handleRpc(functionPath, args)` / the data-migration
 * runner.
 *
 * This is the file that imports every user function module — kept separate from
 * `server.ts` (which user code imports for `v`/`query`/`mutation`) so the two
 * never form an initialization cycle. See {@link emitServer}.
 */

/**
 * Build the `LUNORA_LIFECYCLE_HOOKS` manifest body: the
 * connect/disconnect/init/reactor/whisper function-path arrays the generated
 * ShardDO iterates — the first two on socket open/close, `init` once per instance
 * before any handler runs, `reactor` after a write flush, `whisper` before a
 * topic join or broadcast. Each entry is the same `${namespace}:${fn}` key the
 * function lands under in `LUNORA_FUNCTIONS`, so the DO dispatches a hook by path
 * like any other registered function. Functions arrive pre-sorted, so the arrays
 * are stable.
 */
const renderLifecycleManifest = (
    functions: ReadonlyArray<FunctionIR>,
): { connect: string[]; disconnect: string[]; init: string[]; reactor: string[]; whisper: string[] } => {
    const manifest: { connect: string[]; disconnect: string[]; init: string[]; reactor: string[]; whisper: string[] } = {
        connect: [],
        disconnect: [],
        init: [],
        reactor: [],
        whisper: [],
    };

    for (const definition of functions) {
        if (!definition.lifecycle) {
            continue;
        }

        manifest[definition.lifecycle].push(`${sanitizeNamespace(definition.filePath)}:${definition.exportName}`);
    }

    return manifest;
};

interface EmitFunctionsOptions {
    agents?: ReadonlyArray<AgentIR>;
    functions: ReadonlyArray<FunctionIR>;
    migrations?: ReadonlyArray<MigrationIR>;
    mutators?: ReadonlyArray<MutatorIR>;
    shapes?: ReadonlyArray<ShapeIR>;
    /** Import of a sandbox tool (`browserTool`/`containerTool`) auto-registers the `sandbox:invoke` action. */
    usesSandbox?: boolean;
    useUmbrella?: boolean;
}

const emitFunctions = (options: EmitFunctionsOptions): string => {
    const { agents = [], functions, migrations = [], mutators = [], shapes = [], useUmbrella = false, usesSandbox = false } = options;
    const hasFunctions = functions.length > 0;
    const base = baseSpecifiers(useUmbrella);
    const { dispatchBody, importBlock, installBlock, migrationBody, mutatorPaths, shapeBody } = renderFunctionRegistry(functions, migrations, mutators, shapes);
    // Auto-registered agent runtime + sandbox dispatcher functions (see the
    // render*FunctionRegistry helpers). Both are empty-gated so an unused feature
    // keeps output byte-identical.
    const agentRegistry = renderAgentFunctionRegistry(agents, functions);
    const sandboxRegistry = renderSandboxFunctionRegistry(usesSandbox, functions);
    const autoLines = [agentRegistry.lines, sandboxRegistry.lines].filter((block) => block.length > 0).join("\n");
    let dispatchBodyWithAgents = dispatchBody;

    if (autoLines.length > 0) {
        // Splice the auto entries after the discovered ones, preserving the
        // `{\n    entries\n}` layout either side already emits (trimEnd keeps
        // this independent of how many trailing newlines the wrapper carries).
        dispatchBodyWithAgents = dispatchBody.length > 0 ? `${dispatchBody.trimEnd()}\n${autoLines}\n` : `\n${autoLines}\n`;
    }
    const lifecycleHooks = renderLifecycleManifest(functions);

    // Replication-shape + custom-mutator registries (local-first sync engine).
    // Both are gated on non-empty so a project without shapes/mutators emits a
    // byte-identical `functions.ts` (the `RegisteredShape` type import, the
    // `LUNORA_SHAPES` map, and the `LUNORA_MUTATOR_PATHS` set all vanish).
    const shapeTypeImport = shapes.length > 0 ? `import type { RegisteredShape } from "${base.server}";\n` : "";
    const shapeRegistry =
        shapes.length > 0
            ? `\n/**\n * Replication-shape registry — one entry per \`defineShape\` in \`lunora/shapes.ts\`.\n * The generated ShardDO's \`resolveShape\` override looks a shape up by name and\n * evaluates its trusted \`compileWhere(ctx, args)\` to authorize + scope a\n * \`shape_subscribe\` (reads-as-permissions).\n */\nexport const LUNORA_SHAPES: Record<string, RegisteredShape> = {${shapeBody}};\n`
            : "";
    const mutatorPathsRegistry =
        mutatorPaths.length > 0
            ? `\n/**\n * Custom-mutator function paths — the \`LUNORA_FUNCTIONS\` keys the generated\n * ShardDO's \`isCustomMutator\` override routes through the client-watermark push\n * protocol (\`x-lunora-client-id\`/\`x-lunora-client-seq\` ordering).\n */\nexport const LUNORA_MUTATOR_PATHS: ReadonlySet<string> = new Set([${mutatorPaths.map((path) => JSON.stringify(path)).join(", ")}]);\n`
            : "";

    // Pull in the compiled-args seam only when at least one function compiled —
    // an unused import would trip `noUnusedLocals`.
    const compiledArgsImport = installBlock.length > 0 ? `import { DEFER_VALIDATION as DEFER, installCompiledValidatorMap } from "${base.values}";\n` : "";
    const compiledArgsInstall =
        installBlock.length > 0
            ? `\n/**\n * AOT-compiled argument validators (Worker-safe, no \`eval\`). Each is installed\n * onto its function's live \`.args\` object and consulted by the interpreted\n * parser as a zero-allocation fast path; anything it can't model is deferred.\n */\n${installBlock}\n`
            : "";

    const caller = renderCaller(functions);
    const callerTypes = caller.types ? `\n${caller.types}\n` : "";
    const callerImpl = caller.implementation ? `\n${caller.implementation}\n` : "";

    // Pull the `Doc`/`Id` aliases the caller's arg/return types actually
    // reference into a type-only dataModel import (importing an unused one
    // trips noUnusedLocals; omitting the import entirely when neither is
    // referenced keeps the file dependency-light).
    const callerDataModelImports = referencedDataModelImports(caller.types);
    const dataModelImport = callerDataModelImports.length > 0 ? `import type { ${callerDataModelImports.join(", ")} } from "./dataModel.js";\n` : "";

    // `callRegistered` (and thus `context`) is only referenced when at least one
    // function exists; otherwise it would be an unused local / parameter.
    const callerParameter = hasFunctions ? "context" : "_context";
    const callRegisteredHelper = hasFunctions ? `${CALL_REGISTERED_HELPER}\n\n` : "";

    return relocateBaseQualifiers(
        `${GENERATED_HEADER}${importBlock}${agentRegistry.importLine}${sandboxRegistry.importLine}${compiledArgsImport}${shapeTypeImport}import { LunoraError } from "${base.server}";\nimport type { ActionCtx, MutationCtx, QueryCtx } from "./server.js";
${dataModelImport}
/**
 * Single registered function, narrowed to the shape \`handleRpc\` needs.
 * The real argument validators / return types are checked elsewhere — at
 * the dispatch site we erase to \`unknown\` so a single map can host every
 * registered function.
 */
export interface RegisteredLunoraFunction {
    kind: "action" | "mutation" | "query" | "stream";
    args: Record<string, unknown>;
    /**
     * Present on a \`"stream"\` declared \`durable\`: its run is persisted and
     * survives the socket that opened it. Absent on every other kind, and on an
     * ephemeral stream.
     */
    durable?: { ttlMs?: number };
    /**
     * For \`"action" | "mutation" | "query"\` the handler is awaited and its result returned.
     * For \`"stream"\` the handler returns an \`AsyncIterable\` synchronously and takes an
     * \`AbortSignal\` as a third argument — the runtime drives it frame-by-frame.
     */
    handler: ((context: unknown, args: Record<string, unknown>) => Promise<unknown> | unknown) | ((context: unknown, args: Record<string, unknown>, signal?: AbortSignal) => AsyncIterable<unknown>);
    /**
     * The lifecycle moment a hook fires on, when this registration came from
     * \`onConnect\`/\`onDisconnect\`/\`onShardInit\`/\`onQueryChange\`/\`onWhisper\`.
     * Read at dispatch to decide whether the function runs system-trusted:
     * \`init\` and \`reactor\` have no caller identity, so RLS has no user to scope
     * to. \`whisper\` does have one — it runs under the asking socket's identity.
     */
    lifecycle?: "connect" | "disconnect" | "init" | "reactor" | "whisper";
    /**
     * Hoisted by the builder when the \`.use()\` chain carries a step with a
     * per-dispatch effect — \`rateLimit(...)\` consuming budget, a single-use
     * captcha token being burned. Read by \`isCacheableQuery\`: the chain runs
     * inside the dispatch callback, and a reactive-cache HIT skips that
     * callback, so such a query must never be memoized.
     */
    perDispatch?: boolean;
    /** \`"internal"\` functions are rejected on the external RPC path; absence === public. */
    visibility?: "internal" | "public";
    /**
     * \`.x402({ price })\` tag on a paid public procedure. The origin worker
     * paywalls it; the shard refuses to subscribe it (\`isPaidFunction\`).
     */
    x402?: { readonly price: number | string };
}
${agentRegistry.prelude}${sandboxRegistry.prelude}
/**
 * Static dispatch table. The key matches the \`__lunoraRef\` the client
 * emits (\`api[namespace][fn].__lunoraRef === "namespace:fn"\`).
 */
export const LUNORA_FUNCTIONS: Record<string, RegisteredLunoraFunction> = {${dispatchBodyWithAgents}};
${compiledArgsInstall}${shapeRegistry}${mutatorPathsRegistry}
/**
 * Lifecycle manifest: the function paths the generated ShardDO dispatches when a
 * client's WebSocket connects (\`connect\`) or disconnects (\`disconnect\`), once
 * per Durable Object instance before any handler runs (\`init\`), after a
 * write flush when a watched read's result changed (\`reactor\`), and before a
 * socket joins or broadcasts to a whisper topic (\`whisper\`). Each path also
 * resolves through {@link LUNORA_FUNCTIONS}. The socket-scoped moments run under
 * the socket's verified identity; \`init\` and \`reactor\` have no caller, so they
 * run anonymous — all via system dispatch.
 */
export const LUNORA_LIFECYCLE_HOOKS: {
    connect: readonly string[];
    disconnect: readonly string[];
    init: readonly string[];
    reactor: readonly string[];
    whisper: readonly string[];
} = {
    connect: [${lifecycleHooks.connect.map((path) => JSON.stringify(path)).join(", ")}],
    disconnect: [${lifecycleHooks.disconnect.map((path) => JSON.stringify(path)).join(", ")}],
    init: [${lifecycleHooks.init.map((path) => JSON.stringify(path)).join(", ")}],
    reactor: [${lifecycleHooks.reactor.map((path) => JSON.stringify(path)).join(", ")}],
    whisper: [${lifecycleHooks.whisper.map((path) => JSON.stringify(path)).join(", ")}],
};

/**
 * Resolve and invoke a registered function from an external caller. Throws a
 * LunoraError-shaped object (404) when the path is unknown — the runtime's
 * structural error mapper turns that into the right HTTP status. Internal
 * functions are treated as not-found so their existence never leaks to clients.
 */
export const dispatchLunoraFunction = async (functionPath: string, context: unknown, args: Record<string, unknown>): Promise<unknown> => {
    const registered = LUNORA_FUNCTIONS[functionPath];

    if (!registered || registered.visibility === "internal") {
        throw new LunoraError("FUNCTION_NOT_FOUND", \`function not registered: \${functionPath}\`);
    }

    return registered.handler(context, args);
};

/**
 * A handler context accepted by {@link createCaller}. The runtime context the
 * shard DO builds is uniform across kinds, so any handler's \`ctx\` works here.
 */
export type CallerCtx = ActionCtx | MutationCtx | QueryCtx;

/**
 * Typed, in-process server-to-server caller. Every registered function — public
 * *and* internal — is reachable; each call dispatches against the same shard
 * with the supplied \`context\`, exactly like \`ctx.runQuery\`/\`runMutation\`/
 * \`runAction\` but without re-stating the function path.
 */
export interface Caller {${callerTypes}}

${callRegisteredHelper}/** Build a {@link Caller} bound to \`context\` (typically a handler's \`ctx\`). */
export const createCaller = (${callerParameter}: CallerCtx): Caller => ({${callerImpl}});

/**
 * Single registered data migration, narrowed to the shape the per-shard runner
 * consumes. \`up\`/\`down\` are erased to a structural transform; the authoring
 * validation lives in \`defineMigration\`.
 */
export interface RegisteredDataMigration {
    batchSize?: number;
    down?: (document: Record<string, unknown>) => Record<string, unknown> | undefined;
    id: string;
    table: string;
    up: (document: Record<string, unknown>) => Record<string, unknown> | undefined;
}

/**
 * Registry of online data migrations keyed by \`defineMigration\`'s \`id\`. The
 * shard DO's admin RPC and the CLI resolve migrations to run through this map.
 */
export const LUNORA_MIGRATIONS: Record<string, RegisteredDataMigration> = {${migrationBody}};
`,
        useUmbrella,
    );
};

export default emitFunctions;
