import { LunoraError } from "@lunora/errors";

import compileArgsValidator from "../compile-validator";
import type { AgentIR, FunctionIR, MigrationIR, MutatorIR, ShapeIR, ValidatorIR } from "../ir";
import { sanitizeNamespace } from "../paths";
import { renderAgentFunctionRegistry, renderSandboxFunctionRegistry } from "./api";
import { rebaseRelativeQualifiers, referencedDataModelImports, referenceReturnType, relocateBaseQualifiers } from "./qualifiers";
import emitServer from "./server";
import { baseSpecifiers, GENERATED_HEADER, IMPORT_PATH_RE, renderArgsType, renderNamespaceTree, renderObjectKey } from "./shared";

/**
 * Convert a raw file path into a JS-identifier-safe alias used as the
 * imported namespace inside `_generated/server.ts`. Keeps the path
 * recognisable in the generated source while satisfying the lexer.
 */
const moduleAlias = (filePath: string, index: number): string => `lunora_${sanitizeNamespace(filePath)}_${String(index)}`;

/** The compact validator facts the admin discovery endpoint can serve without loading user code. */
const renderArgumentDescriptors = (args: Record<string, ValidatorIR>): string =>
    JSON.stringify(
        Object.entries(args)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([name, original]) => {
                const optional = original.kind === "optional";
                const validator = optional ? (original.inner ?? { kind: "unknown" }) : original;
                const element = validator.kind === "array" ? validator.inner?.kind : undefined;
                const table = validator.kind === "id" ? validator.tableName : undefined;

                return {
                    kind: validator.kind,
                    name,
                    optional,
                    ...(table === undefined ? {} : { table }),
                    ...(element === undefined || element === "unknown" ? {} : { element }),
                };
            }),
    );

/** The module namespaces codegen assigns, shared by eager imports and lazy shims. */
const moduleAliasesFor = (
    functions: ReadonlyArray<FunctionIR>,
    migrations: ReadonlyArray<MigrationIR>,
    mutators: ReadonlyArray<MutatorIR>,
    shapes: ReadonlyArray<ShapeIR>,
): Map<string, string> => {
    const aliases = new Map<string, string>();
    const register = (filePath: string): void => {
        if (!aliases.has(filePath)) {
            aliases.set(filePath, moduleAlias(filePath, aliases.size));
        }
    };

    for (const definition of functions) {
        register(definition.filePath);
    }

    for (const migration of migrations) {
        register(migration.filePath);
    }

    for (const mutator of mutators) {
        register(mutator.filePath);
    }

    for (const shape of shapes) {
        register(shape.filePath);
    }

    return aliases;
};

/** Keep eager registry imports and lazy shim emission on the same file-path policy. */
const eagerModulePaths = (migrations: ReadonlyArray<MigrationIR>, mutators: ReadonlyArray<MutatorIR>, shapes: ReadonlyArray<ShapeIR>): ReadonlySet<string> =>
    new Set([...migrations.map((migration) => migration.filePath), ...mutators.map((mutator) => mutator.filePath), ...shapes.map((shape) => shape.filePath)]);

// Split this generated lookup so no-secrets can keep checking strings without
// mistaking a framework access for a credential-shaped literal.
const renderFunctionTableLookup = (table: "LUNORA_FUNCTIONS" | "LUNORA_FUNCTION_MANIFEST"): string => `${table}[functionPath]`;

/**
 * The `callRegistered` helper emitted into `functions.ts` — the shared dispatch
 * shim every `createCaller` leaf routes through. Hoisted to module scope so the
 * emitter body reads as composition rather than a wall of escaped TS.
 */
const CALL_REGISTERED_HELPER = `const callRegistered = async <R>(context: CallerCtx, functionPath: string, args: Record<string, unknown> | undefined): Promise<R> => {
    const registered = await loadFunction(functionPath);

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
    lazyFunctions = false,
): {
    dispatchBody: string;
    importBlock: string;
    installBlock: string;
    manifestBody: string;
    migrationBody: string;
    moduleLoaders: string;
    mutatorPaths: ReadonlyArray<string>;
    roomMessagesBody: string;
    shapeBody: string;
} => {
    const aliasByPath = moduleAliasesFor(functions, migrations, mutators, shapes);
    const eagerPaths = eagerModulePaths(migrations, mutators, shapes);

    const importLines = [...aliasByPath.entries()]
        .filter(([filePath]) => {
            if (!lazyFunctions || eagerPaths.has(filePath)) {
                return true;
            }

            return functions.some((definition) => definition.filePath === filePath && definition.channel?.kind === "room");
        })
        .map(([filePath, alias]) => {
            if (!IMPORT_PATH_RE.test(filePath)) {
                throw new LunoraError("INTERNAL", `@lunora/codegen: refusing to emit import for unsafe file path: ${JSON.stringify(filePath)}`);
            }

            const typeOnly = lazyFunctions && !eagerPaths.has(filePath);

            return `import ${typeOnly ? "type " : ""}* as ${alias} from "../${filePath}.js";`;
        })
        .join("\n");

    // Functions arrive pre-sorted by `${filePath}:${exportName}`, so same-file
    // entries stay contiguous and the alias lookup is always populated.
    const dispatchEntries = functions
        .map((definition) => {
            if (!lazyFunctions || eagerPaths.has(definition.filePath)) {
                return `    "${sanitizeNamespace(definition.filePath)}:${definition.exportName}": ${aliasByPath.get(definition.filePath) ?? ""}.${definition.exportName} as unknown as RegisteredLunoraFunction,`;
            }

            return `    "${sanitizeNamespace(definition.filePath)}:${definition.exportName}": { args: {}, handler: unloadedFunctionHandler, ...${JSON.stringify(
                {
                    argumentDescriptors: JSON.parse(renderArgumentDescriptors(definition.args)) as unknown,
                    kind: definition.kind,
                    ...(definition.channel ? { channel: definition.channel } : {}),
                    ...(definition.expose ? { expose: definition.expose } : {}),
                    ...(definition.lifecycle ? { lifecycle: definition.lifecycle } : {}),
                    ...(definition.visibility ? { visibility: definition.visibility } : {}),
                    ...(definition.x402?.price === undefined ? {} : { x402: { price: definition.x402.price } }),
                },
            )} } satisfies RegisteredLunoraFunction & Pick<FunctionManifestEntry, "argumentDescriptors" | "channel" | "expose">,`;
        })
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
        .filter((definition) => !lazyFunctions || eagerPaths.has(definition.filePath))
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

    // One `LunoraRoomMessages` entry per room, typed off the room's own registration.
    const roomMessagesBody = functions
        .filter((definition) => definition.channel?.kind === "room")
        .map(
            (definition) =>
                `    ${JSON.stringify(definition.channel?.name ?? "")}: RoomMessageOf<typeof ${aliasByPath.get(definition.filePath) ?? ""}[${JSON.stringify(definition.exportName)}]>;`,
        )
        .join("\n");

    const manifests = [
        ...functions.map((definition) => {
            return {
                args: definition.args,
                definition,
                path: `${sanitizeNamespace(definition.filePath)}:${definition.exportName}`,
            };
        }),
        ...mutators.map((definition) => {
            return {
                args: definition.args,
                definition: {
                    ...definition,
                    expose: undefined,
                    kind: "mutation" as const,
                    lifecycle: undefined,
                    visibility: undefined,
                    x402: undefined,
                },
                path: `${sanitizeNamespace(definition.filePath)}:${definition.exportName}`,
            };
        }),
    ];
    const lazyManifests = lazyFunctions ? manifests.filter(({ definition }) => !eagerPaths.has(definition.filePath)) : [];

    for (const { definition } of manifests) {
        if (lazyFunctions && definition.x402 && definition.x402.price === undefined) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/codegen: lazy function registry needs a literal \`.x402({ price })\` value in ${definition.filePath}:${definition.exportName}`,
            );
        }
    }

    const manifestEntries = lazyFunctions
        ? lazyManifests
              .map(({ definition, path }) => {
                  const moduleId = aliasByPath.get(definition.filePath) ?? "";
                  const channel = "channel" in definition ? definition.channel : undefined;
                  const staticFields = {
                      argumentDescriptors: JSON.parse(renderArgumentDescriptors(definition.args)) as unknown,
                      exportName: definition.exportName,
                      kind: definition.kind,
                      moduleId,
                      ...(channel ? { channel } : {}),
                      ...(definition.expose ? { expose: definition.expose } : {}),
                      ...(definition.lifecycle ? { lifecycle: definition.lifecycle } : {}),
                      ...(definition.visibility ? { visibility: definition.visibility } : {}),
                      ...(definition.x402?.price === undefined ? {} : { x402: { price: definition.x402.price } }),
                  };

                  return `    ${JSON.stringify(path)}: ${JSON.stringify(staticFields)},`;
              })
              .join("\n")
        : "";
    const modulePaths = [...new Set(lazyManifests.map(({ definition }) => definition.filePath))];
    const moduleLoaders = lazyFunctions
        ? modulePaths
              .map((filePath) => {
                  if (!IMPORT_PATH_RE.test(filePath)) {
                      throw new LunoraError("INTERNAL", `@lunora/codegen: refusing to emit import for unsafe file path: ${JSON.stringify(filePath)}`);
                  }

                  const moduleId = aliasByPath.get(filePath) ?? "";

                  return `    ${JSON.stringify(moduleId)}: () => import(${JSON.stringify(`./fn/${moduleId}.js`)}),`;
              })
              .join("\n")
        : "";

    return {
        dispatchBody: combinedDispatch.length > 0 ? `\n${combinedDispatch}\n` : "",
        importBlock: importLines.length > 0 ? `${importLines}\n\n` : "",
        installBlock: installLines,
        manifestBody: manifestEntries.length > 0 ? `\n${manifestEntries}\n` : "",
        migrationBody: migrationEntries.length > 0 ? `\n${migrationEntries}\n` : "",
        moduleLoaders: moduleLoaders.length > 0 ? `\n${moduleLoaders}\n` : "",
        mutatorPaths,
        roomMessagesBody,
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
    const types = renderNamespaceTree(
        functions,
        (definition) => {
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
                return `${definition.exportName}: (args${optional}: ${argsType}) => Promise<AsyncIterable<${returnType}>>;`;
            }

            return `${definition.exportName}: (args${optional}: ${argsType}) => Promise<${returnType}>;`;
        },
        "type",
    );

    // The object keys are quoted when a segment isn't a bare identifier
    // (leading-digit filename); the dispatch ref strings embed the `_`-joined
    // namespace, the same `__lunoraRef` the generated `api.ts` carries.
    const implementation = renderNamespaceTree(
        functions,
        (definition) =>
            `${renderObjectKey(definition.exportName)}: (args) => callRegistered(context, "${sanitizeNamespace(definition.filePath)}:${definition.exportName}", args),`,
        "value",
    );

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
        // A `room` registration is dispatched through the dedicated
        // `LUNORA_ROOMS` map and a `socket` route through `LUNORA_SOCKETS`, not
        // the socket-lifecycle manifest, so both are excluded here (the emitted
        // manifest keeps its five socket moments).
        if (!definition.lifecycle || definition.lifecycle === "socket") {
            continue;
        }

        manifest[definition.lifecycle].push(`${sanitizeNamespace(definition.filePath)}:${definition.exportName}`);
    }

    return manifest;
};

/**
 * The `defineWebSocket`-only fragments of the emitted `functions.ts`: the
 * `LUNORA_SOCKETS` registry, the extra `"socket"` member of the
 * `RegisteredLunoraFunction.lifecycle` union, and its `socketPath`/`auth`
 * fields. Split out of {@link emitFunctions} so the emitter's own branching
 * stays within budget; all three vanish for a route-free project, keeping its
 * output byte-identical.
 */
const renderSocketFragments = (functions: ReadonlyArray<FunctionIR>): { fields: string; lifecycleMember: string; registry: string } => {
    const hasSockets = functions.some((definition) => definition.lifecycle === "socket");
    const registry = hasSockets
        ? `\n/**\n * Socket registry: the URL path of each \`defineWebSocket\` route → its function\n * path + auth requirement. The generated ShardDO's \`socketRoute\` override\n * resolves an upgraded socket through this map so a route's typed\n * \`onOpen\`/\`onMessage\`/\`onClose\` dispatch server-side under the socket's\n * verified identity. Two routes on one path throw at module load rather than letting\n * the map silently keep whichever came last.\n */\nexport const LUNORA_SOCKETS: Readonly<Record<string, { auth: boolean; functionPath: string }>> = (() => {\n    const registry: Record<string, { auth: boolean; functionPath: string }> = {};\n    const owners = new Map<string, unknown>();\n\n    for (const [path, fn] of Object.entries(LUNORA_FUNCTIONS)) {\n        if (fn.lifecycle !== "socket" || typeof fn.socketPath !== "string") {\n            continue;\n        }\n\n        const owner = owners.get(fn.socketPath);\n\n        // The same registration exported under two names (an alias) is one route.\n        if (owner !== undefined && owner !== fn) {\n            throw new Error(\`two defineWebSocket routes serve "\${fn.socketPath}"; socket paths must be unique\`);\n        }\n\n        if (owner === undefined) {\n            owners.set(fn.socketPath, fn);\n            registry[fn.socketPath] = { auth: fn.auth === true, functionPath: path };\n        }\n    }\n\n    return registry;\n})();\n`
        : "";
    const lifecycleMember = hasSockets ? ` | "socket"` : "";
    const fields = hasSockets
        ? `
    /**
     * Set on a \`defineWebSocket\` registration: the URL path the route serves.
     * The generated \`LUNORA_SOCKETS\` map keys it on this path so the ShardDO
     * resolves an upgraded socket to this registration.
     */
    socketPath?: string;
    /**
     * Set on a \`defineWebSocket\` registration: whether the route refuses an
     * anonymous upgrade. Read into \`LUNORA_SOCKETS\` alongside \`socketPath\`.
     */
    auth?: boolean;`
        : "";

    return { fields, lifecycleMember, registry };
};

interface EmitFunctionsOptions {
    agents?: ReadonlyArray<AgentIR>;
    functions: ReadonlyArray<FunctionIR>;
    lazyFunctions?: boolean;
    migrations?: ReadonlyArray<MigrationIR>;
    mutators?: ReadonlyArray<MutatorIR>;
    shapes?: ReadonlyArray<ShapeIR>;
    /** Import of a sandbox tool (`browserTool`/`containerTool`) auto-registers the `sandbox:invoke` action. */
    usesSandbox?: boolean;
    useUmbrella?: boolean;
}

/**
 * The room-only fragments of `functions.ts`: the message-type import, the typed
 * `LunoraRoomMessages` map, and the interface's `channel` field. All empty for a
 * room-free project, so its output is unchanged.
 */
const renderRoomFragments = (
    hasRooms: boolean,
    serverSpecifier: string,
    roomMessagesBody: string,
): { channelField: string; messagesBlock: string; typeImport: string } => {
    if (!hasRooms) {
        return { channelField: "", messagesBlock: "", typeImport: "" };
    }

    return {
        channelField: `    /**\n     * Set on a \`defineRoom\` registration: the room's name (without the \`room:\`\n     * topic prefix). The generated \`LUNORA_ROOMS\` map keys it on the room's\n     * \`room:<name>\` whisper topic so the ShardDO resolves a room topic to this\n     * path.\n     */\n    channel?: { readonly kind: "room"; readonly name: string };\n`,
        messagesBlock: `\n/**\n * The message type each \`defineRoom\` carries, read off the room's own registration. The generated \`rooms\` references type a client's \`connectRoom\` from it.\n */\nexport type LunoraRoomMessages = {\n${roomMessagesBody}\n};\n`,
        typeImport: `import type { RoomMessageOf } from "${serverSpecifier}";\n`,
    };
};

/**
 * Return nothing for room-free apps so their output stays byte-identical. Keep
 * `room:` literal here; the room codegen test keeps it matched to ROOM_TOPIC_PREFIX
 * without requiring another server export.
 */
const renderRoomRegistry = (hasRooms: boolean, lazyFunctions: boolean, functions: ReadonlyArray<FunctionIR>): string => {
    if (!hasRooms) {
        return "";
    }

    if (lazyFunctions) {
        return `\n/**\n * Room routes are static metadata so building the worker never evaluates user handlers.\n */\nexport const LUNORA_ROOMS: Readonly<Record<string, string>> = (() => {\n    const registry: Record<string, string> = {};\n    const owners = new Map<string, string>();\n\n    for (const { owner, path, topic } of [\n${functions
            .filter((definition) => definition.channel?.kind === "room")
            .map(
                (definition) =>
                    `        { owner: ${JSON.stringify(definition.filePath)}, path: ${JSON.stringify(`${sanitizeNamespace(definition.filePath)}:${definition.exportName}`)}, topic: ${JSON.stringify(`room:${definition.channel?.name ?? ""}`)} },`,
            )
            .join(
                "\n",
            )}\n    ]) {\n        const prior = owners.get(topic);\n\n        if (prior !== undefined && prior !== owner) {\n            throw new Error(\`two defineRoom registrations are named "\${topic.slice("room:".length)}"; room names must be unique\`);\n        }\n\n        if (prior === undefined) {\n            owners.set(topic, owner);\n            registry[topic] = path;\n        }\n    }\n\n    return registry;\n})();\n`;
    }

    return `\n/**\n * Room registry: the whisper topic of each \`defineRoom\` registration → its\n * function path. The generated ShardDO's \`roomHandlerPath\` override resolves a\n * room topic through this map so a room's typed \`onJoin\`/\`onMessage\`/\`onLeave\`\n * dispatch server-side, reusing the whisper channel for membership and fan-out.\n * Two registrations under one name throw at module load: the map would otherwise\n * silently keep whichever came last.\n */\nexport const LUNORA_ROOMS: Readonly<Record<string, string>> = (() => {\n    const registry: Record<string, string> = {};\n    const owners = new Map<string, unknown>();\n\n    for (const [path, fn] of Object.entries(LUNORA_FUNCTIONS)) {\n        if (fn.channel?.kind !== "room") {\n            continue;\n        }\n\n        const topic = \`room:\${fn.channel.name}\`;\n        const owner = owners.get(topic);\n\n        // The same registration exported under two names (an alias) is one room.\n        if (owner !== undefined && owner !== fn) {\n            throw new Error(\`two defineRoom registrations are named "\${fn.channel.name}"; room names must be unique\`);\n        }\n\n        if (owner === undefined) {\n            owners.set(topic, fn);\n            registry[topic] = path;\n        }\n    }\n\n    return registry;\n})();\n`;
};

/**
 * Assemble caller types, implementation and imports. Import only the referenced
 * Doc/Id aliases; omit callRegistered (and its context parameter) without
 * functions so generated files avoid noUnusedLocals errors.
 */
const renderCallerAssembly = (functions: ReadonlyArray<FunctionIR>, lazyFunctions: boolean) => {
    const caller = renderCaller(functions);
    const types = caller.types ? `\n${caller.types}\n` : "";
    const implementation = caller.implementation ? `\n${caller.implementation}\n` : "";
    const imports = referencedDataModelImports(caller.types);
    const dataModelImport = imports.length > 0 ? `import type { ${imports.join(", ")} } from "./dataModel.js";\n` : "";
    const parameter = functions.length > 0 ? "context" : "_context";
    let callRegisteredHelper = "";

    if (functions.length > 0) {
        let helper = CALL_REGISTERED_HELPER;

        if (!lazyFunctions) {
            helper = helper.replace("await loadFunction(functionPath)", renderFunctionTableLookup("LUNORA_FUNCTIONS"));
        }

        callRegisteredHelper = `${helper}\n\n`;
    }

    return { callRegisteredHelper, dataModelImport, implementation, parameter, types };
};

const emitFunctions = (options: EmitFunctionsOptions): string => {
    const { agents = [], functions, lazyFunctions = false, migrations = [], mutators = [], shapes = [], useUmbrella = false, usesSandbox = false } = options;
    const base = baseSpecifiers(useUmbrella);
    const { dispatchBody, importBlock, installBlock, manifestBody, migrationBody, moduleLoaders, mutatorPaths, roomMessagesBody, shapeBody } =
        renderFunctionRegistry(functions, migrations, mutators, shapes, lazyFunctions);
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
    const dispatchLookup = lazyFunctions ? "await loadFunction(functionPath)" : renderFunctionTableLookup("LUNORA_FUNCTIONS");
    const dispatchPreflight = lazyFunctions
        ? `    if (${renderFunctionTableLookup("LUNORA_FUNCTION_MANIFEST")}?.visibility === "internal") {
        throw new LunoraError("FUNCTION_NOT_FOUND", \`function not registered: \${functionPath}\`);
    }

`
        : "";

    // Replication-shape + custom-mutator registries (local-first sync engine).
    // Both are gated on non-empty so a project without shapes/mutators emits a
    // byte-identical `functions.ts` (the `RegisteredShape` type import, the
    // `LUNORA_SHAPES` map, and the `LUNORA_MUTATOR_PATHS` set all vanish).
    const shapeTypeImport = shapes.length > 0 ? `import type { RegisteredShape } from "${base.server}";\n` : "";
    const hasRooms = functions.some((definition) => definition.channel?.kind === "room");
    const rooms = renderRoomFragments(hasRooms, base.server, roomMessagesBody);
    const shapeRegistry =
        shapes.length > 0
            ? `\n/**\n * Replication-shape registry — one entry per \`defineShape\` in \`lunora/shapes.ts\`.\n * The generated ShardDO's \`resolveShape\` override looks a shape up by name and\n * evaluates its trusted \`compileWhere(ctx, args)\` to authorize + scope a\n * \`shape_subscribe\` (reads-as-permissions).\n */\nexport const LUNORA_SHAPES: Record<string, RegisteredShape> = {${shapeBody}};\n`
            : "";
    const mutatorPathsRegistry =
        mutatorPaths.length > 0
            ? `\n/**\n * Custom-mutator function paths — the \`LUNORA_FUNCTIONS\` keys the generated\n * ShardDO's \`isCustomMutator\` override routes through the client-watermark push\n * protocol (\`x-lunora-client-id\`/\`x-lunora-client-seq\` ordering).\n */\nexport const LUNORA_MUTATOR_PATHS: ReadonlySet<string> = new Set([${mutatorPaths.map((path) => JSON.stringify(path)).join(", ")}]);\n`
            : "";

    const roomsRegistry = renderRoomRegistry(hasRooms, lazyFunctions, functions);

    // The `defineWebSocket`-only fragments (registry + interface fields),
    // computed by a helper so this emitter's branching stays within budget and
    // gated so a route-free project's output is byte-identical.
    const { fields: socketFields, lifecycleMember: socketLifecycleMember, registry: socketsRegistry } = renderSocketFragments(functions);

    // Pull in the compiled-args seam only when at least one function compiled —
    // an unused import would trip `noUnusedLocals`.
    const compiledArgsImport = installBlock.length > 0 ? `import { DEFER_VALIDATION as DEFER, installCompiledValidatorMap } from "${base.values}";\n` : "";
    const compiledArgsInstall =
        installBlock.length > 0
            ? `\n/**\n * AOT-compiled argument validators (Worker-safe, no \`eval\`). Each is installed\n * onto its function's live \`.args\` object and consulted by the interpreted\n * parser as a zero-allocation fast path; anything it can't model is deferred.\n */\n${installBlock}\n`
            : "";

    const caller = renderCallerAssembly(functions, lazyFunctions);
    const { callRegisteredHelper, dataModelImport, implementation: callerImpl, parameter: callerParameter, types: callerTypes } = caller;
    const lazyRegistryPrelude = lazyFunctions
        ? `
export interface FunctionManifestEntry {
    argumentDescriptors: ReadonlyArray<{ element?: string; kind: string; name: string; optional: boolean; table?: string }>;
    channel?: { kind: "room"; name: string };
    exportName: string;
    expose?: { cache?: { credentialHeaders?: ReadonlyArray<string>; maxAge?: number; scope?: "private" | "public"; staleWhileRevalidate?: number; tag?: string; vary?: string }; rest?: boolean };
    kind: "action" | "mutation" | "query" | "stream";
    lifecycle?: "connect" | "disconnect" | "init" | "reactor" | "whisper";
    moduleId: string;
    visibility?: "internal" | "public";
    x402?: { readonly price: number | string };
}

/** Static, codegen-derived facts. Request gates can inspect these without evaluating a user module. */
export const LUNORA_FUNCTION_MANIFEST: Readonly<Record<string, FunctionManifestEntry>> = {${manifestBody}};

const MODULE_LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {${moduleLoaders}};
const loadedModules = new Map<string, Promise<Record<string, unknown>>>();
const resolvedModules = new Map<string, Record<string, unknown>>();
const boundFunctions = new Set<string>();
const unloadedFunctionHandler = (): never => {
    throw new Error("a lazy function was invoked before it was prepared");
};

/** Reuse an evaluated module synchronously, so dispatch does not yield after restoring request scope. */
export const getLoadedFunction = (functionPath: string): RegisteredLunoraFunction | undefined => {
    const registered = ${renderFunctionTableLookup("LUNORA_FUNCTIONS")};
    const manifest = ${renderFunctionTableLookup("LUNORA_FUNCTION_MANIFEST")};

    if (!registered || !manifest) {
        return registered;
    }

    if (boundFunctions.has(functionPath)) {
        return registered;
    }

    const module = resolvedModules.get(manifest.moduleId);

    if (module === undefined) {
        return undefined;
    }

    const loaded = module[manifest.exportName];

    if (typeof loaded !== "object" || loaded === null) {
        throw new Error(\`lazy module export for "\${functionPath}" is not a registered function\`);
    }

    Object.assign(registered, loaded);
    boundFunctions.add(functionPath);

    return registered;
};

/** Load one function's owning module once per isolate, then merge its live builder result into the registry entry. */
export const loadFunction = async (functionPath: string): Promise<RegisteredLunoraFunction | undefined> => {
    const registered = getLoadedFunction(functionPath);
    const manifest = ${renderFunctionTableLookup("LUNORA_FUNCTION_MANIFEST")};

    if (registered || !manifest) {
        return registered;
    }

    let pending = loadedModules.get(manifest.moduleId);

    if (pending === undefined) {
        const loader = MODULE_LOADERS[manifest.moduleId];

        if (loader === undefined) {
            throw new Error(\`no lazy module loader registered for "\${functionPath}"\`);
        }

        pending = loader();
        loadedModules.set(manifest.moduleId, pending);
    }

    // A module that failed to evaluate stays failed for the isolate: the runtime has already cached
    // the failed evaluation, and a bundler's lazy initializer can hand a retry a half-initialized
    // namespace, so every later call rethrows the original error instead.
    resolvedModules.set(manifest.moduleId, await pending);

    return getLoadedFunction(functionPath);
};
`
        : "";

    return relocateBaseQualifiers(
        `${GENERATED_HEADER}${importBlock}${agentRegistry.importLine}${sandboxRegistry.importLine}${compiledArgsImport}${shapeTypeImport}${rooms.typeImport}import { LunoraError } from "${base.server}";\nimport type { ActionCtx, MutationCtx, QueryCtx } from "./server.js";
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
    lifecycle?: "connect" | "disconnect" | "init" | "reactor" | "whisper"${socketLifecycleMember};${socketFields}
${rooms.channelField}    /**
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
${agentRegistry.prelude}${sandboxRegistry.prelude}${lazyRegistryPrelude}
/**
 * Static dispatch table. The key matches the \`__lunoraRef\` the client
 * emits (\`api[namespace][fn].__lunoraRef === "namespace:fn"\`).
 */
export const LUNORA_FUNCTIONS: Record<string, RegisteredLunoraFunction> = {${dispatchBodyWithAgents}};
${compiledArgsInstall}${shapeRegistry}${mutatorPathsRegistry}${roomsRegistry}${rooms.messagesBlock}${socketsRegistry}
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
${dispatchPreflight}    const registered = ${dispatchLookup};

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

/** Directory under `_generated/` holding the per-module lazy import shims. */
const LAZY_FUNCTION_DIRECTORY = "fn";

/** Emit one generated shim per user module, keyed by file name under {@link LAZY_FUNCTION_DIRECTORY}; importing a shim installs that module's compiled validators once. */
const emitLazyFunctionModules = (options: EmitFunctionsOptions): Record<string, string> => {
    if (options.lazyFunctions !== true) {
        return {};
    }

    const { functions } = options;
    const migrations = options.migrations ?? [];
    const mutators = options.mutators ?? [];
    const shapes = options.shapes ?? [];
    const aliases = moduleAliasesFor(functions, migrations, mutators, shapes);
    const eagerPaths = eagerModulePaths(migrations, mutators, shapes);
    const filePaths = [...new Set(functions.filter((definition) => !eagerPaths.has(definition.filePath)).map((definition) => definition.filePath))];
    const base = baseSpecifiers(options.useUmbrella ?? false);
    const output: Record<string, string> = {};

    for (const filePath of filePaths) {
        if (!IMPORT_PATH_RE.test(filePath)) {
            throw new LunoraError("INTERNAL", `@lunora/codegen: refusing to emit import for unsafe file path: ${JSON.stringify(filePath)}`);
        }

        const moduleId = aliases.get(filePath) ?? "";
        const sourcePath = `../../${filePath}.js`;
        const compiledInstalls = functions
            .filter((definition) => definition.filePath === filePath && !definition.lifecycle && Object.keys(definition.args).length > 0)
            .flatMap((definition) => {
                const compiled = compileArgsValidator(definition.args);

                return compiled === undefined ? [] : [`installCompiledValidatorMap(${moduleId}.${definition.exportName}.args, ${compiled});`];
            });
        const compiledImport = compiledInstalls.length > 0 ? `import { DEFER_VALIDATION as DEFER, installCompiledValidatorMap } from "${base.values}";\n` : "";
        const namespaceImport = compiledInstalls.length > 0 ? `import * as ${moduleId} from "${sourcePath}";\n` : "";
        const installBlock =
            compiledInstalls.length > 0
                ? `\n/** Install the precompiled argument parsers before the module is dispatched. */\n${compiledInstalls.join("\n")}\n`
                : "";
        const hasDefault =
            functions.some((definition) => definition.filePath === filePath && definition.exportName === "default") ||
            migrations.some((migration) => migration.filePath === filePath && migration.exportName === "default");
        const defaultExport = hasDefault ? `export { default } from "${sourcePath}";\n` : "";

        output[`${moduleId}.ts`] = `${GENERATED_HEADER}${compiledImport}${namespaceImport}${installBlock}export * from "${sourcePath}";\n${defaultExport}`;
    }

    return output;
};

export { emitFunctions, emitLazyFunctionModules, LAZY_FUNCTION_DIRECTORY };
