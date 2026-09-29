// The /component subpath avoids the package barrel (which pulls the agent
// runtime + AI SDK into the codegen process just to enumerate function names).
import { agentComponent } from "@lunora/agent/component";
import { LunoraError } from "@lunora/errors";

import type { AgentIR, FunctionIR, HttpRouteIR, MutatorIR, ShapeIR, WorkflowIR } from "../ir";
import sanitizeNamespace from "../paths";
import { rebaseRelativeQualifiers, referencedDataModelImports, referenceReturnType, relocateBaseQualifiers } from "./qualifiers";
import { assertIdentifier, baseSpecifiers, GENERATED_HEADER, pascalCase, renderArgsType, renderObjectKey, renderPropertyKey } from "./shared";

/** Group entries by `filePath`, entries sorted by file for deterministic output. */
const groupByFileSorted = <T extends { filePath: string }>(entries: ReadonlyArray<T>): [string, T[]][] => {
    const namespaces = new Map<string, T[]>();

    for (const entry of entries) {
        const list = namespaces.get(entry.filePath) ?? [];

        list.push(entry);
        namespaces.set(entry.filePath, list);
    }

    return [...namespaces.entries()].toSorted(([a], [b]) => a.localeCompare(b));
};

/**
 * Render the grouped-by-namespace body of an api interface for a subset of
 * functions. Returns `""` when the subset is empty so the caller can emit an
 * empty `{}` interface.
 */
const renderApiBody = (functions: ReadonlyArray<FunctionIR>): string => {
    const renderNamespace = ([file, list]: [string, FunctionIR[]]): string => {
        // Sorted by export name so a namespace that mixes discovered functions with
        // synthetic entries (agents, custom mutators — appended after the sorted
        // discovery output) still emits in a stable, alphabetical order.
        const members = list
            .toSorted((a, b) => a.exportName.localeCompare(b.exportName))
            .map((definition) => {
                // We emit `FunctionReference<Kind, ArgsObj, Return>` so the
                // generated `api.*` references plug directly into
                // `useQuery`/`useMutation` from `@lunora/react` (and
                // `client.query` / `client.mutation` from `@lunora/client`).
                // The phantom `Kind`/`Args`/`Return` parameters carry the
                // info downstream hooks need to infer call signatures.
                const argsType = rebaseRelativeQualifiers(renderArgsType(definition.args), definition.filePath);
                const returnType = rebaseRelativeQualifiers(referenceReturnType(definition), definition.filePath);

                return `        ${definition.exportName}: FunctionReference<"${definition.kind}", ${argsType}, ${returnType}>;`;
            })
            .join("\n");

        // A namespace derived from a leading-digit filename (e.g. `2fa.ts`) is a
        // valid `__lunoraRef` string but not a bare TS key, so quote it when
        // needed — the string value (and thus the runtime dispatch key) is
        // unchanged.
        return `    ${renderPropertyKey(sanitizeNamespace(file))}: {\n${members}\n    };`;
    };

    return groupByFileSorted(functions)
        .map((entry) => renderNamespace(entry))
        .join("\n");
};

/**
 * Render the scheduler-target reference block for `_generated/api.ts` (its
 * import line + the type/value) — the typed `workflows.*` and/or `agents.*`
 * reference objects, whichever the project declares.
 *
 * Each `lunora/workflows.ts` export becomes a `workflows.<name>` reference
 * carrying its `WORKFLOW_*` binding and — via the definition's phantom
 * `__params` — its `params` type, so a `cronJobs()` registration that targets it
 * infers the args. Each `lunora/agents.ts` export becomes an `agents.<name>`
 * reference carrying its `AGENT_*` binding (an agent compiles onto a Cloudflare
 * Workflow, so it IS a workflow reference structurally) typed with the flat
 * `AgentRunInput`, so `crons.daily("sweep", …, agents.support, { input,
 * threadKey })` starts a fresh agent run per fire.
 *
 * Returns empty strings when the project declares neither. The shared
 * `WorkflowReference` shape is defined locally (not imported from
 * `@lunora/scheduler`) so a workflow-only project needs no scheduler dependency;
 * it matches `@lunora/scheduler`'s `WorkflowReference` structurally at the cron
 * call site. `AgentRunInput` is imported from `@lunora/agent` (type-only, erased
 * at build) only when agents are declared, so agent-free output is unchanged.
 */
/* eslint-disable no-secrets/no-secrets -- the emitted `WorkflowReference`/`WorkflowParamsOf` generic strings are dense generated TS, not credentials */
const renderSchedulerReferences = (workflows: ReadonlyArray<WorkflowIR>, agents: ReadonlyArray<AgentIR>): { block: string; importLine: string } => {
    if (workflows.length === 0 && agents.length === 0) {
        return { block: "", importLine: "" };
    }

    const importLines: string[] = [];
    let block = "";

    // `WorkflowParamsOf` is workflow-specific (agents carry the concrete flat
    // `AgentRunInput`), so it is emitted only when workflows are declared.
    if (workflows.length > 0) {
        block += `
/** Params type carried by a \`defineWorkflow\` definition (its phantom \`__params\`). */
type WorkflowParamsOf<Definition> = Definition extends { __params?: infer Params } ? (unknown extends Params ? Record<string, unknown> : Params) : Record<string, unknown>;
`;
    }

    // The `WorkflowReference` interface backs BOTH workflow and agent handles (an
    // agent run is a workflow instance), so it is emitted once whenever either
    // exists. The comment text is kept verbatim so workflow-only output stays
    // byte-identical to before agents rode the same emitter.
    block += `
/** A typed reference to a durable workflow, addressable for \`cronJobs()\` targets. Mirrors \`@lunora/scheduler\`'s \`WorkflowReference\` structurally. */
export interface WorkflowReference<Params = Record<string, unknown>> {
    readonly isLunoraWorkflow: true;
    readonly __params?: Params;
    readonly binding: string;
    readonly name: string;
}
`;

    if (workflows.length > 0) {
        const sorted = [...workflows].toSorted((a, b) => a.exportName.localeCompare(b.exportName));
        const refMembers = sorted
            .map((workflow) => `    ${workflow.exportName}: WorkflowReference<WorkflowParamsOf<typeof lunoraWorkflowDefinitions.${workflow.exportName}>>;`)
            .join("\n");
        const objectMembers = sorted
            .map(
                (workflow) =>
                    `    ${renderObjectKey(workflow.exportName)}: { isLunoraWorkflow: true, binding: ${JSON.stringify(workflow.bindingName)}, name: ${JSON.stringify(workflow.exportName)} },`,
            )
            .join("\n");

        block += `
/** This project's durable workflows, addressable as typed references (e.g. \`crons.daily("digest", …, workflows.digestPipeline, params)\`). */
export interface WorkflowsRef {
${refMembers}
}

export const workflows: WorkflowsRef = {
${objectMembers}
};
`;
        importLines.push(`import type * as lunoraWorkflowDefinitions from "../workflows.js";\n`);
    }

    if (agents.length > 0) {
        const sorted = [...agents].toSorted((a, b) => a.exportName.localeCompare(b.exportName));
        const refMembers = sorted.map((agent) => `    ${agent.exportName}: WorkflowReference<AgentRunInput>;`).join("\n");
        const objectMembers = sorted
            .map(
                (agent) =>
                    `    ${renderObjectKey(agent.exportName)}: { isLunoraWorkflow: true, binding: ${JSON.stringify(agent.bindingName)}, name: ${JSON.stringify(agent.name)} },`,
            )
            .join("\n");

        block += `
/** This project's durable agents, addressable as typed references for \`cronJobs()\` — each fire starts a fresh agent run (e.g. \`crons.daily("sweep", …, agents.support, { input, threadKey })\`). */
export interface AgentsRef {
${refMembers}
}

export const agents: AgentsRef = {
${objectMembers}
};
`;
        importLines.push(`import type { AgentRunInput } from "@lunora/agent";\n`);
    }

    return { block, importLine: importLines.join("") };
};
/* eslint-enable no-secrets/no-secrets -- re-enable after the scheduler-refs emitter */

/**
 * The `@lunora/agent` runtime functions codegen auto-registers under the
 * `agents:*` namespace whenever the project declares at least one agent. Their
 * values come from `agentComponent()` imported directly inside the generated
 * dispatch table, so apps never re-export them by hand — and function
 * discovery (which cannot resolve a destructured re-export through a
 * published package's `.d.ts`) is never involved. The name list is DERIVED
 * from codegen's own `@lunora/agent` dependency at emit time, so a function
 * added to (or renamed in) the component is auto-registered without touching
 * this file — only the typed api surface below is pinned by hand.
 */
const agentRuntimeFunctionNames = (): ReadonlyArray<string> => Object.keys(agentComponent().functions).toSorted((a, b) => a.localeCompare(b));

/** Names the app registered itself under the `agents` namespace — they win over auto-registration. */
const takenAgentFunctionNames = (functions: ReadonlyArray<FunctionIR>): ReadonlySet<string> =>
    new Set(functions.filter((definition) => sanitizeNamespace(definition.filePath) === "agents").map((definition) => definition.exportName));

/**
 * Names of the `@lunora/agent` runtime functions the durable loop dispatches
 * BY PATH internally (`agentAppendMessage`/`agentEnsureThread`/…) — as opposed
 * to the public thread queries + the two client-facing mutations
 * (`agentMessages`/`agentState`/`agentThread`/`agentRun`/`agentResolveApproval`),
 * which an app is allowed to shadow (the app's own definition silently wins).
 * Derived from the runtime component's own `visibility: "internal"` marker
 * (mirroring the drift test in `discover/agents.test.ts`) rather than a
 * hand-maintained list, so a newly added internal function is protected
 * automatically.
 */
const internalAgentRuntimeFunctionNames = (): ReadonlySet<string> =>
    new Set(
        Object.entries(agentComponent().functions)
            .filter(([, definition]) => definition.visibility === "internal")
            .map(([name]) => name),
    );

/**
 * Dispatch-table fragment for the auto-registered agent runtime functions.
 * Every string is empty when the project declares no agents (or the app shadows
 * every PUBLIC name), keeping agent-free output byte-identical.
 *
 * Shadowing a PUBLIC name (`agentMessages`/`agentState`/…) is a silent win for
 * the app's own definition — unremarkable, since nothing but a client reference
 * depends on it. Shadowing an INTERNAL name (`agentAppendMessage`/…) is instead
 * rejected: the durable loop dispatches those by path unconditionally, so an
 * app definition silently winning there would hijack the loop's own writes.
 */
const renderAgentFunctionRegistry = (
    agents: ReadonlyArray<AgentIR>,
    functions: ReadonlyArray<FunctionIR>,
): { importLine: string; lines: string; prelude: string } => {
    const empty = { importLine: "", lines: "", prelude: "" };

    if (agents.length === 0) {
        return empty;
    }

    const taken = takenAgentFunctionNames(functions);
    const internal = internalAgentRuntimeFunctionNames();
    const shadowedInternal = functions.find((definition) => sanitizeNamespace(definition.filePath) === "agents" && internal.has(definition.exportName));

    if (shadowedInternal) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/codegen: "agents:${shadowedInternal.exportName}" is reserved for the durable agent loop's internal dispatch — rename the "${shadowedInternal.exportName}" export in ${shadowedInternal.filePath}`,
        );
    }

    const names = agentRuntimeFunctionNames().filter((name) => !taken.has(name));

    if (names.length === 0) {
        return empty;
    }

    return {
        importLine: 'import { agentComponent } from "@lunora/agent/component";\n',
        lines: names.map((name) => `    "agents:${name}": lunoraAgentRuntimeFunctions.${name} as unknown as RegisteredLunoraFunction,`).join("\n"),
        prelude:
            "\n/**\n * The `@lunora/agent` runtime component — auto-registered because `lunora/agents.ts`\n * declares agents. The durable loop dispatches the internal mutations; clients\n * subscribe to the public queries (`agents:agentMessages` is the live thread view).\n */\nconst lunoraAgentRuntimeFunctions = agentComponent().functions;\n",
    };
};

/**
 * Dispatch-table fragment for the auto-registered sandbox dispatcher — the
 * single internal action the batteries-included `browserTool`/`containerTool`
 * dispatch to. Mirrors {@link renderAgentFunctionRegistry}: every string is
 * empty when the project imports no sandbox tool, keeping sandbox-free output
 * byte-identical. No synthetic `api.*` entry (the action is internal).
 *
 * Unlike the agents namespace (where an app-registered name silently wins),
 * `sandbox:invoke` is *required* for the tools to work, so a discovered function
 * at that exact path is a genuine conflict — reject it instead of letting the
 * auto entry silently shadow (last-key-wins) the app's `sandbox.invoke`.
 */
const renderSandboxFunctionRegistry = (usesSandbox: boolean, functions: ReadonlyArray<FunctionIR>): { importLine: string; lines: string; prelude: string } => {
    if (!usesSandbox) {
        return { importLine: "", lines: "", prelude: "" };
    }

    const collision = functions.find((definition) => sanitizeNamespace(definition.filePath) === "sandbox" && definition.exportName === "invoke");

    if (collision) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/codegen: "sandbox:invoke" is reserved for the batteries-included sandbox tool dispatcher (browserTool/containerTool) — rename the "invoke" export in ${collision.filePath}`,
        );
    }

    return {
        importLine: 'import { sandboxComponent } from "@lunora/agent/component";\n',
        lines: '    "sandbox:invoke": lunoraSandbox.invoke as unknown as RegisteredLunoraFunction,',
        prelude:
            "\n/**\n * The `@lunora/agent` sandbox dispatcher — auto-registered because `lunora/`\n * imports a sandbox tool (`browserTool`/`containerTool`). The batteries-included\n * tools dispatch to this internal action, which runs on an action ctx carrying\n * `ctx.browser` + `ctx.containers` (the durable tool step itself has neither).\n */\nconst lunoraSandbox = sandboxComponent();\n",
    };
};

/**
 * Synthetic `FunctionIR` entries for the auto-registered PUBLIC agent
 * functions, so `api.agents.agentMessages` / `api.agents.agentState` /
 * `api.agents.agentThread` / `api.agents.agentResolveApproval` /
 * `api.agents.agentRun` exist as typed references
 * (`useSubscription(api.agents.agentMessages, { key })`,
 * `useAgentState({ api, threadKey })` over `api.agents.agentState`,
 * `useMutation(api.agents.agentResolveApproval)`). The thread-write mutations
 * (`agentAppendMessage`/`agentDeleteMessage`/`agentEnsureThread`/
 * `agentPatchThread`/`agentSetState`) stay internal — the loop dispatches them by path over the
 * scheduler channel and nothing client- or caller-side needs a reference;
 * `agentResolveApproval` is public because a client resolves approvals with it,
 * and `agentRun` is public because an HTTP-only client (the `@lunora/mcp`
 * server) starts a durable run with it — both owner-gated inside the mutation.
 * App-registered names win (no duplicate members).
 *
 * KEEP IN SYNC with `@lunora/agent`'s `component.ts` (`agentMessages` /
 * `agentState` / `agentThread` / `agentResolveApproval` / `agentRun` inputs +
 * return shapes) — codegen cannot statically discover a
 * published package's function types, so these are pinned by hand. The drift
 * test in `discover/agents.test.ts` reduces each runtime arg validator to a
 * `{kind, optional, literals}` descriptor and asserts it against these shapes,
 * so an added/removed arg, an optionality flip, a scalar-kind change, or a
 * `decision` union-member change fails there. Only the RETURN types stay
 * unguarded and must be mirrored manually.
 */
const syntheticAgentApiFunctions = (agents: ReadonlyArray<AgentIR>, functions: ReadonlyArray<FunctionIR>): FunctionIR[] => {
    if (agents.length === 0) {
        return [];
    }

    const taken = takenAgentFunctionNames(functions);
    const definitions: FunctionIR[] = [
        {
            args: { key: { kind: "string" }, limit: { inner: { kind: "number" }, kind: "optional" } },
            exportName: "agentMessages",
            filePath: "agents",
            kind: "query",
            returnType: "Record<string, unknown>[]",
        },
        {
            args: {
                decision: {
                    kind: "union",
                    members: [
                        { kind: "literal", literalValue: '"approve"' },
                        { kind: "literal", literalValue: '"reject"' },
                    ],
                },
                instanceId: { kind: "string" },
                note: { inner: { kind: "string" }, kind: "optional" },
                threadKey: { kind: "string" },
                toolCallId: { kind: "string" },
            },
            exportName: "agentResolveApproval",
            filePath: "agents",
            kind: "mutation",
            returnType: "{ resolved: boolean }",
        },
        {
            args: {
                agent: { kind: "string" },
                input: { kind: "string" },
                threadKey: { kind: "string" },
                title: { inner: { kind: "string" }, kind: "optional" },
            },
            exportName: "agentRun",
            filePath: "agents",
            kind: "mutation",
            returnType: "{ id: string; threadKey: string }",
        },
        {
            args: { key: { kind: "string" } },
            exportName: "agentState",
            filePath: "agents",
            kind: "query",
            returnType: "Record<string, unknown> | undefined",
        },
        {
            args: { key: { kind: "string" } },
            exportName: "agentThread",
            filePath: "agents",
            kind: "query",
            returnType: "Record<string, unknown> | undefined",
        },
    ];

    // Per voice-enabled agent: a live `agents.<name>Voice` reference the
    // `useVoiceAgent` hook consumes (it reads the ref's `__lunoraRef` to open the
    // voice DO's WebSocket, keyed by `threadKey`). Modeled as a `stream` kind — a
    // voice session is exactly a live, bidirectional, WS-backed channel. Emitted
    // only for agents that declared a `voice` block, so voice-free (and agent-free)
    // projects keep a byte-identical `api`.
    for (const agent of agents) {
        if (agent.voice) {
            definitions.push({
                args: { threadKey: { kind: "string" } },
                exportName: `${agent.exportName}Voice`,
                filePath: "agents",
                kind: "stream",
                returnType: "Record<string, unknown>",
            });
        }
    }

    return definitions.filter((definition) => !taken.has(definition.exportName));
};

/**
 * Synthetic `FunctionIR` entries for the project's custom mutators, so
 * `api.mutators.<name>` exists as a typed reference and a client
 * `defineMutator({ serverRef: api.mutators.insertSibling })` binds the dispatch
 * path at COMPILE time — a rename, a typo, or a moved file becomes a type error
 * instead of a push that fails at runtime — while inferring its `args` from the
 * server mutator's own validators instead of restating them.
 *
 * A mutator dispatches through the same `LUNORA_FUNCTIONS` table as an ordinary
 * `mutation` (its `kind` IS `"mutation"`), and the `namespace:fn` ref matches the
 * `LUNORA_MUTATOR_PATHS` entry the DO's `isCustomMutator` override reads, so the
 * emitted reference is a real function reference — not a parallel shape.
 *
 * Mutators are client-pushed, so they land on the PUBLIC `api` surface. An
 * app-registered function in `lunora/mutators.ts` with the same export name wins
 * (no duplicate members), mirroring {@link syntheticAgentApiFunctions}.
 */
const syntheticMutatorApiFunctions = (mutators: ReadonlyArray<MutatorIR>, functions: ReadonlyArray<FunctionIR>): FunctionIR[] => {
    if (mutators.length === 0) {
        return [];
    }

    const taken = new Set(functions.filter((definition) => sanitizeNamespace(definition.filePath) === "mutators").map((definition) => definition.exportName));

    return mutators
        .filter((mutator) => !taken.has(mutator.exportName))
        .map((mutator) => {
            return {
                args: mutator.args,
                exportName: mutator.exportName,
                filePath: mutator.filePath,
                kind: "mutation" as const,
                returnType: mutator.returnType,
            };
        });
};

/**
 * Render the `httpStreams.*` typed-reference block for `_generated/api.ts` —
 * one entry per `httpRoute.<verb>(path).stream()` SSE route, grouped by source
 * file the way `api.*` is. Each reference carries the verb + path at runtime
 * (what the client needs to open the endpoint) and the chunk / searchParams /
 * params types via `HttpStreamRef`'s phantom parameter, so
 * `client.httpStream(httpStreams.http.tokens, …)` and the framework hooks
 * infer the chunk type end-to-end. Returns empty strings when the project
 * declares no streaming routes; `body` is the rendered type members (fed into
 * the `Doc`/`Id` import detection alongside the api bodies).
 */
const renderHttpStreamsRef = (httpRoutes: ReadonlyArray<HttpRouteIR>): { block: string; body: string } => {
    const streams = httpRoutes.filter((route) => route.stream);

    if (streams.length === 0) {
        return { block: "", body: "" };
    }

    const sortedNamespaces = groupByFileSorted(streams);

    const typeBody = sortedNamespaces
        .map(([file, list]) => {
            const members = list
                .map((route) => {
                    const chunkType = rebaseRelativeQualifiers(route.chunkType ?? "unknown", route.filePath);
                    const searchParams = rebaseRelativeQualifiers(renderArgsType(route.searchParams), route.filePath);
                    const params = rebaseRelativeQualifiers(renderArgsType(route.params), route.filePath);

                    return `        ${renderPropertyKey(route.exportName)}: HttpStreamRef<${chunkType}, ${searchParams}, ${params}>;`;
                })
                .join("\n");

            return `    ${renderPropertyKey(sanitizeNamespace(file))}: {\n${members}\n    };`;
        })
        .join("\n");

    const valueBody = sortedNamespaces
        .map(([file, list]) => {
            const members = list
                .map(
                    (route) =>
                        `        ${renderObjectKey(route.exportName)}: { method: ${JSON.stringify(route.method)}, path: ${JSON.stringify(route.path)} },`,
                )
                .join("\n");

            return `    ${renderObjectKey(sanitizeNamespace(file))}: {\n${members}\n    },`;
        })
        .join("\n");

    const block = `
/** This project's HTTP-SSE stream routes (\`httpRoute.<verb>(path).stream()\`), addressable as typed references for \`client.httpStream\` / \`useHttpStream\`. */
export interface HttpStreamsRef {
${typeBody}
}

export const httpStreams: HttpStreamsRef = {
${valueBody}
};
`;

    return { block, body: typeBody };
};

/**
 * Emit `_generated/api.ts` — the typed `api.*` registry (public functions), the
 * `internal.*` registry, and (when the project declares them) the typed
 * `workflows.*` / `agents.*` scheduler-target reference objects. `api`/`internal` are the same `anyApi` proxy
 * at runtime (the `__lunoraRef` is identical); visibility is enforced
 * server-side at dispatch, not in the reference. Splitting the *types* keeps
 * internal functions off the client-facing `api` surface.
 */
interface EmitApiOptions {
    agents?: ReadonlyArray<AgentIR>;
    functions: ReadonlyArray<FunctionIR>;
    /** Typed REST routes; only `.stream()` (SSE) routes emit a `httpStreams.*` reference. */
    httpRoutes?: ReadonlyArray<HttpRouteIR>;
    /** Custom mutators (`lunora/mutators.ts`) — emitted as `api.mutators.*` so a client `serverRef` is compile-checked. */
    mutators?: ReadonlyArray<MutatorIR>;
    useUmbrella?: boolean;
    workflows?: ReadonlyArray<WorkflowIR>;
}

const emitApi = (options: EmitApiOptions): string => {
    const { agents = [], functions, httpRoutes = [], mutators = [], useUmbrella = false, workflows = [] } = options;
    const base = baseSpecifiers(useUmbrella);
    const publicFunctions = [
        ...functions.filter((definition) => definition.visibility !== "internal"),
        ...syntheticAgentApiFunctions(agents, functions),
        ...syntheticMutatorApiFunctions(mutators, functions),
    ];
    const internalFunctions = functions.filter((definition) => definition.visibility === "internal");

    const publicBody = renderApiBody(publicFunctions);
    const internalBody = renderApiBody(internalFunctions);

    const httpStreamsRef = renderHttpStreamsRef(httpRoutes);

    // Import only the dataModel helpers the rendered arg/return types actually
    // reference: `Doc` appears when a function returns documents, `Id` when it
    // takes or returns an id. Importing an unused one trips noUnusedLocals.
    const combinedBody = `${publicBody}\n${internalBody}\n${httpStreamsRef.body}`;
    const dataModelImports = referencedDataModelImports(combinedBody);
    const dataModelImportLine = dataModelImports.length > 0 ? `\nimport type { ${dataModelImports.join(", ")} } from "./dataModel.js";\n` : "";

    const apiBlock = publicBody ? `\n${publicBody}\n` : "";
    const internalBlock = internalBody ? `\n${internalBody}\n` : "";

    const schedulerReferences = renderSchedulerReferences(workflows, agents);

    const fileBody = `export interface ApiTypes {${apiBlock}}

export const api = anyApi as unknown as ApiTypes;

/** Internal functions — callable only server-side via \`ctx.run*\`, never from a client. */
export interface InternalApiTypes {${internalBlock}}

export const internal = anyApi as unknown as InternalApiTypes;
${schedulerReferences.block}${httpStreamsRef.block}`;

    // Import only what the body references. `HttpStreamRef` needs a streaming
    // route; `FunctionReference` needs at least one registered function, and a
    // project with none (or one whose discovery found none) would otherwise
    // carry a dangling import that trips `noUnusedLocals`.
    const clientImportNames = [
        ...(fileBody.includes("FunctionReference<") ? ["FunctionReference"] : []),
        ...(httpStreamsRef.block === "" ? [] : ["HttpStreamRef"]),
    ];
    const clientImportLine = clientImportNames.length > 0 ? `import type { ${clientImportNames.join(", ")} } from "${base.client}";\n` : "";

    // `anyApi` comes from the CLIENT package, not the server one. `api.ts` is the
    // file a sibling package imports (a web app, another Worker), and its only
    // runtime import should be one that package already depends on — the server
    // specifier made a browser app resolve the server runtime for a proxy. Both
    // packages re-export the same shared implementation.
    return relocateBaseQualifiers(
        `${GENERATED_HEADER}import { anyApi } from "${base.client}";
${clientImportLine}${schedulerReferences.importLine}${dataModelImportLine}
${fileBody}`,
        useUmbrella,
    );
};

/**
 * Emit `_generated/seed.ts` — a project-bound `createSeedClient` with this
 * schema's `InsertModel` and runtime schema pre-applied, so a test or script
 * calls `createSeedClient({ seed: 1 }).users(5)` with full column types and no
 * manual wiring. The runtime schema is the default export of `lunora/schema.ts`
 * (the same import the generated ShardDO uses).
 *
 * Returns `""` when `@lunora/seed` is not a declared dependency, so projects
 * that don't use it keep a clean `_generated/` and never import the package.
 */
const emitSeed = (enabled: boolean): string => {
    if (!enabled) {
        return "";
    }

    return `${GENERATED_HEADER}import { createSeedClient as createSeedClientBase } from "@lunora/seed";
import type { SeedClient, SeedClientOptions } from "@lunora/seed";

import schema from "../schema.js";
import type { InsertModel } from "./dataModel.js";

/**
 * Schema-aware seed client with this project's \`InsertModel\` and runtime schema
 * pre-bound. Each table is a method; call it with a count, a range, explicit
 * partial rows, or per-field overrides. Foreign keys connect to rows seeded
 * earlier in the run, and FK-parent tables are seeded automatically.
 * @example
 * const seed = createSeedClient({ seed: 1 });
 * const { users } = await seed.users(5);
 * const { posts } = await seed.posts((x) => x([10, 20]));
 */
export const createSeedClient = (options?: SeedClientOptions): SeedClient<InsertModel> => createSeedClientBase<InsertModel>(schema, options);
`;
};

/**
 * Emit `_generated/collections.ts` — a typed TanStack DB binding per `defineShape`
 * in `lunora/shapes.ts` (the local-first partial-replication surface).
 *
 * Each shape emits **two** entry points.
 *
 * `<shape>CollectionOptions(options)` is the composable form: it returns the full
 * `LunoraCollectionOptions` — `config` for `createCollection`, plus `checkpoints`
 * (which `bindMutators` gates optimistic overlays on) and `scope`. This is what an app
 * with custom mutators needs, and what the old single-factory form made impossible: it
 * built the collection internally and dropped `checkpoints` on the floor, so there was
 * no way to wire mutators to the collection codegen produced.
 *
 * `<shape>Collection(options)` is the convenience form for a read-only collection: it
 * returns `{ checkpoints, collection, scope }` rather than a bare `Collection`, so the
 * sync controls stay reachable even from the short path.
 *
 * Both are typed: `args` comes from the shape's own validators (a parameterless
 * shape takes none), rows resolve to `Doc<"table">` when the shape names its table
 * with a literal, and `shardKey` / `getKey` / `load` / `onError` / `checkpoints` are
 * all threadable — a sharded table needs `shardKey` for its watermark to land in the
 * right bucket, and a server-minted `_id` that differs from the app's natural key
 * needs `getKey`.
 *
 * Returns `""` (so `writeIfPresent` skips the file) unless the project both
 * declares shapes AND installs `@lunora/db` — the add-on that ships
 * `lunoraCollectionOptions`. `@lunora/db` stays a scoped install even under the
 * `lunorash` umbrella (an opt-in add-on, like `@lunora/auth`), so its import is
 * always `@lunora/db/collections`; only the in-umbrella `@lunora/client` import
 * is remapped to `lunorash/client`.
 */
const emitCollections = (shapes: ReadonlyArray<ShapeIR>, hasDatabase: boolean, useUmbrella = false): string => {
    if (shapes.length === 0 || !hasDatabase) {
        return "";
    }

    const base = baseSpecifiers(useUmbrella);

    // `Doc<"table">` when the shape named its table with a string literal;
    // otherwise the permissive `Row` (the runtime object stays authoritative).
    const rowTypeOf = (shape: ShapeIR): string => (shape.table === undefined ? "Row" : `Doc<${JSON.stringify(shape.table)}> & Row`);

    const factories = shapes
        .map((shape) => {
            assertIdentifier(shape.exportName, "shape export name");

            const rowType = rowTypeOf(shape);
            // Rebased like every other argument-type site: `_generated/collections.ts`
            // is in the same directory as `api.ts`, so a relative qualifier reaching
            // a shape's args resolves one level too deep here too.
            const argsType = rebaseRelativeQualifiers(renderArgsType(shape.args), shape.filePath);
            const hasArgs = Object.keys(shape.args).length > 0;
            // A parameterless shape must not demand an empty object; a parameterized
            // one must not let the caller forget its partition selector.
            const argsField = hasArgs ? `        args: ${argsType};` : `        args?: ${argsType};`;
            // Mirror the options type: a parameterized shape must not accept `scope()`
            // with no selector, or an arbitrary `Record<string, unknown>`.
            const scopeType = hasArgs ? `(args: ${argsType}) => void` : `(args?: ${argsType}) => void`;
            const optionsType = `${shape.exportName}CollectionOptions`;

            return `/** Options for the \`${shape.exportName}\` shape binding. */
export interface ${pascalCase(optionsType)} {
${argsField}
    /**
     * Share the optimistic-overlay gate with other collections + mutators on this
     * shard. Defaults to the shared per-shard registry, which is almost always what
     * you want — pass one only to isolate this collection's gate.
     */
    checkpoints?: CheckpointRegistry;
    /** The Lunora client to subscribe through. */
    client: LunoraClient;
    /** Row key extractor — defaults to \`row._id\`. Override when the app keys rows by a natural column. */
    getKey?: (row: ${rowType}) => string;
    /** \`"eager"\` starts syncing at creation; \`"lazy"\` (default) on the first subscriber. */
    load?: "eager" | "lazy";
    /** Notified when the underlying subscription errors; the collection always leaves \`loading\`. */
    onError?: (error: SubscriptionError) => void;
    /** Routes the subscription to a shard's DO. **Required for a \`.shardBy()\` table** — without it the watermark lands in the default bucket. */
    shardKey?: string;
}

/**
 * Collection options for the \`${shape.exportName}\` replication shape: \`config\` for
 * \`createCollection\`, plus the \`checkpoints\` registry to hand \`bindMutators\` and
 * \`scope\` to re-point the subscription.
 */
export const ${shape.exportName}CollectionOptions = (options: ${pascalCase(optionsType)}): LunoraCollectionOptions<${rowType}> =>
    lunoraCollectionOptions<${rowType}>({
        client: options.client,
        ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
        ...(options.getKey === undefined ? {} : { getKey: options.getKey }),
        ...(options.load === undefined ? {} : { load: options.load }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
        ...(options.shardKey === undefined ? {} : { shardKey: options.shardKey }),
        shape: { args: options.args, name: ${JSON.stringify(shape.exportName)}, ...(options.shardKey === undefined ? {} : { shardKey: options.shardKey }) },
    });

/** Live collection for the \`${shape.exportName}\` shape, with its sync controls. */
export const ${shape.exportName}Collection = (
    options: ${pascalCase(optionsType)},
): { checkpoints: CheckpointRegistry; collection: Collection<${rowType}, string>; scope: ${scopeType} } => {
    const { checkpoints, config, scope } = ${shape.exportName}CollectionOptions(options);

    return { checkpoints, collection: createCollection(config), scope };
};`;
        })
        .join("\n\n");

    // Import only the dataModel helpers the rendered types actually reference —
    // `Doc` for a row type, `Id` when a shape's args carry a `v.id(...)`. Importing
    // an unused one trips noUnusedLocals in the consuming project.
    const dataModelImports = referencedDataModelImports(factories);
    const dataModelImportLine = dataModelImports.length > 0 ? `import type { ${dataModelImports.join(", ")} } from "./dataModel.js";\n` : "";

    return `${GENERATED_HEADER}import type { LunoraClient, SubscriptionError } from "${base.client}";
import { lunoraCollectionOptions } from "@lunora/db/collections";
import type { CheckpointRegistry, LunoraCollectionOptions, Row } from "@lunora/db";
import type { Collection } from "@tanstack/db";
import { createCollection } from "@tanstack/db";
${dataModelImportLine}
${factories}
`;
};

export { emitApi, emitCollections, emitSeed, groupByFileSorted, renderAgentFunctionRegistry, renderSandboxFunctionRegistry };
