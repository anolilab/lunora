import type { QueuesResult, WorkflowsResult } from "@lunora/shard-engine";

import type { AgentIR, ContainerIR, JurisdictionIR, QueueIR, ServiceBindingIR, TopicIR, WorkflowIR } from "../ir";
import { subscriptionsOf } from "../ir";
import renderJsonData from "../json-data";
import { renderThrowingStub } from "./shard-bindings";
import { assertIdentifier, GENERATED_HEADER } from "./shared";

/**
 * Emit `_generated/containers.ts` — one container-enabled Durable Object class
 * per `defineContainer` export, each a thin subclass of `LunoraContainer`
 * (`@lunora/container/do`) constructed with the user's definition object. The
 * worker entry must re-export these classes: wrangler requires every
 * `containers[].class_name` to be exported by the deployed worker. Returns ""
 * when the project declares no containers (the file is not written then).
 */
const emitContainers = (containers: ReadonlyArray<ContainerIR>, jurisdiction?: JurisdictionIR): string => {
    if (containers.length === 0) {
        return "";
    }

    // Schema `.jurisdiction("…")` pins the container's best-effort lifecycle
    // report to the same region as the root shard; emitted only when declared so
    // existing generated output is unchanged.
    const jurisdictionArgument = jurisdiction ? `, ${JSON.stringify(jurisdiction)}` : "";

    const classes = containers
        .map((container) => {
            assertIdentifier(container.exportName, `container export "${container.exportName}"`);
            assertIdentifier(container.className, `container class "${container.className}"`);

            // A `sandbox: true` container gets the Sandbox SDK helpers from its base.
            const base = container.sandbox === true ? "LunoraSandboxContainer" : "LunoraContainer";

            return `/** Container DO for the \`${container.exportName}\` definition (binding \`${container.bindingName}\`). */
export class ${container.className} extends ${base} {
    public constructor(ctx: ConstructorParameters<typeof ${base}>[0], env: Record<string, unknown>) {
        super(ctx, env, ${container.exportName}, "${container.exportName}"${jurisdictionArgument});
    }
}
`;
        })
        .join("\n");

    const imports = containers.map((container) => container.exportName).join(", ");
    // Only when a container opts in, so an app that never does neither exports
    // the gateways nor loads `@cloudflare/sandbox`.
    const hasSandbox = containers.some((container) => container.sandbox === true);
    const plainImport = containers.some((container) => container.sandbox !== true) ? `import { LunoraContainer } from "@lunora/container/do";\n` : "";
    const sandboxImport = hasSandbox ? `import { LunoraSandboxContainer } from "@lunora/container/sandbox";\n` : "";
    const sandboxExports = hasSandbox
        ? `
/**
 * \`DirectoryBackup\` and \`S3Mount\` route a \`sandbox: true\` container's storage
 * traffic through these WorkerEntrypoints, so the deployed worker must export them.
 */
export { DirectoryBackupGateway, S3Gateway } from "@lunora/container/sandbox";
`
        : "";

    return `${GENERATED_HEADER}/**
 * Container-enabled Durable Object classes for the containers declared in
 * \`lunora/containers.ts\`. Re-export them from your worker entry — wrangler
 * requires each \`containers[].class_name\` to be exported by the worker:
 *
 * \`export * from "./lunora/_generated/containers.js";\`
 *
 * \`ContainerProxy\` is re-exported alongside them: the egress-interception path
 * (\`allowedHosts\`/\`deniedHosts\`/\`interceptHttps\` and the runtime
 * \`handle.egress\` controls) routes container outbound traffic through this
 * WorkerEntrypoint, so it too must be exported by the deployed worker.
 */
${plainImport}${sandboxImport}
import { ${imports} } from "../containers.js";

export { ContainerProxy } from "@lunora/container/do";
${sandboxExports}
${classes}`;
};

/**
 * The `ctx.containers` code fragments woven into the generated ShardDO, or
 * empty strings when the project declares no containers. Mirrors the
 * capability fragment emitters in `shard-bindings.ts`: the gating lives here, not as inline ternaries in
 * `emitShard`. The spec list is emitted as a `LUNORA_CONTAINERS` const
 * and handed to `createContainerContext`, which resolves the `CONTAINER_*`
 * Durable Object bindings off `env` lazily (a missing binding only throws when
 * the handle is used).
 */
const emitContainerFragments = (
    containers: ReadonlyArray<ContainerIR>,
    jurisdiction?: JurisdictionIR,
): { build: string; contextField: string; importLines: string[]; specs: string } => {
    if (containers.length === 0) {
        return { build: "", contextField: "", importLines: [], specs: "" };
    }

    for (const container of containers) {
        assertIdentifier(container.exportName, `container export "${container.exportName}"`);
        assertIdentifier(container.bindingName, `container binding "${container.bindingName}"`);
    }

    const specEntries = containers
        .map((container) => {
            // The `.any()` pool size; a `durable_object` container has no cap to size it by.
            const maxInstances =
                container.schedulingPolicy !== undefined || container.maxInstances === undefined ? "" : `, maxInstances: ${String(container.maxInstances)}`;

            return `    { binding: "${container.bindingName}", exportName: "${container.exportName}"${maxInstances} },`;
        })
        .join("\n");

    return {
        // Schema `.jurisdiction("…")` pins every container DO this shard reaches
        // to the data-residency region (`undefined` when undeclared). The two
        // trailing arguments forward this dispatch's telemetry verdict onto
        // outbound container fetches: `getCurrentTraceparent()` so the
        // container's spans join the trace, and `getCurrentSampleErrors()` so it
        // exports on the verdict the worker settled rather than on its own
        // environment. The traceparent is the inbound one or, when the dispatch
        // carried none (an alarm, a non-Lunora caller), the shard's own minted
        // anchor, so it is `undefined` only outside a dispatch. The sample-errors
        // verdict is `undefined` whenever none was propagated (read as keep).
        build: `
            const containers = createContainerContext(env, LUNORA_CONTAINERS, ${jurisdiction ? JSON.stringify(jurisdiction) : "undefined"}, this.getCurrentTraceparent(), this.getCurrentSampleErrors());
`,
        contextField: `\n                containers,`,
        importLines: [`import type { ContainerBindingSpec } from "@lunora/container";`, `import { createContainerContext } from "@lunora/container";`],
        // eslint-disable-next-line no-secrets/no-secrets -- the emitted readonly-array type annotation is dense generated TS, not a credential
        specs: `
/** Wiring specs for \`ctx.containers\` (codegen-derived from \`lunora/containers.ts\`). */
const LUNORA_CONTAINERS: ReadonlyArray<ContainerBindingSpec> = [
${specEntries}
];
`,
    };
};

/**
 * Emit `_generated/workflows.ts` — one `WorkflowEntrypoint` class per
 * `defineWorkflow` export, each a thin subclass of `LunoraWorkflow`
 * (`@lunora/workflow/do`) constructed with the user's definition object. The
 * worker entry must re-export these classes: wrangler requires every
 * `workflows[].class_name` to be exported by the deployed worker. Returns ""
 * when the project declares no workflows (the file is not written then).
 */
/* eslint-disable no-secrets/no-secrets -- the emitted WorkflowEntrypoint subclasses and `WorkflowParamsOf`/`WorkflowOutputOf` generics are dense generated TS, not credentials */
const emitWorkflows = (workflows: ReadonlyArray<WorkflowIR>): string => {
    if (workflows.length === 0) {
        return "";
    }

    const classes = workflows
        .map((workflow) => {
            assertIdentifier(workflow.exportName, `workflow export "${workflow.exportName}"`);
            assertIdentifier(workflow.className, `workflow class "${workflow.className}"`);

            return `/** WorkflowEntrypoint for the \`${workflow.exportName}\` definition, reached as \`ctx.exports.${workflow.className}\`. */
export class ${workflow.className} extends LunoraWorkflow<WorkflowParamsOf<typeof ${workflow.exportName}>, WorkflowOutputOf<typeof ${workflow.exportName}>> {
    public constructor(ctx: ConstructorParameters<typeof LunoraWorkflow>[0], env: Record<string, unknown>) {
        super(ctx, env, ${workflow.exportName}, "${workflow.exportName}");
    }
}
`;
        })
        .join("\n");

    const imports = workflows.map((workflow) => workflow.exportName).join(", ");

    return `${GENERATED_HEADER}/**
 * WorkflowEntrypoint classes for the workflows declared in
 * \`lunora/workflows.ts\`. Re-export them from your worker entry — wrangler
 * requires each \`workflows[].class_name\` to be exported by the worker:
 *
 * \`export * from "./lunora/_generated/workflows.js";\`
 */
import LunoraWorkflow from "@lunora/workflow/do";

import { ${imports} } from "../workflows.js";

/** Params type carried by a \`defineWorkflow\` definition (its phantom \`__params\`), so each entrypoint keeps the authored \`ctx.params\` type. */
type WorkflowParamsOf<Definition> = Definition extends { __params?: infer Params }
    ? unknown extends Params
        ? Record<string, unknown>
        : NonNullable<Params>
    : Record<string, unknown>;

/** Output type carried by a \`defineWorkflow\` definition (its phantom \`__output\`), so each entrypoint keeps the authored return type. */
type WorkflowOutputOf<Definition> = Definition extends { __output?: infer Output } ? Output : unknown;

${classes}`;
};
/* eslint-enable no-secrets/no-secrets */

/**
 * Emit `_generated/agents.ts` — one `WorkflowEntrypoint` class per `defineAgent`
 * export, each a thin subclass of `LunoraWorkflow` (`@lunora/workflow/do`)
 * constructed with the compiled agent tool-loop (`compileAgentWorkflow`). Like
 * `_generated/workflows.ts`, the worker entry must re-export these classes:
 * wrangler requires every `workflows[].class_name` to be exported by the
 * deployed worker. Returns "" when the project declares no agents (the file is
 * not written then).
 */
const emitAgents = (agents: ReadonlyArray<AgentIR>): string => {
    if (agents.length === 0) {
        return "";
    }

    const voiceAgents = agents.filter((agent) => agent.voice);
    const hasVoice = voiceAgents.length > 0;

    const classes = agents
        .map((agent) => {
            assertIdentifier(agent.exportName, `agent export "${agent.exportName}"`);
            assertIdentifier(agent.className, `agent class "${agent.className}"`);

            const workflowClass = `/** WorkflowEntrypoint for the \`${agent.exportName}\` agent, reached as \`ctx.exports.${agent.className}\`. */
export class ${agent.className} extends LunoraWorkflow<AgentRunInput, AgentRunResult> {
    public constructor(ctx: ConstructorParameters<typeof LunoraWorkflow>[0], env: Record<string, unknown>) {
        super(ctx, env, compileAgentWorkflow(${agent.exportName}, "${agent.exportName}"), "${agent.exportName}");
    }
}
`;

            if (!agent.voice) {
                return workflowClass;
            }

            const voiceClassName = agent.voiceClassName ?? "";
            const voiceBindingName = agent.voiceBindingName ?? "";

            assertIdentifier(voiceClassName, `agent voice class "${voiceClassName}"`);

            // The voice session is a Durable Object (not a Workflow): a thin
            // VoiceSessionDO subclass constructed with the same agent definition +
            // export name the runtime pipeline reads. Bound as `${voiceBindingName}`.
            const voiceClass = `
/** Voice-session Durable Object for the \`${agent.exportName}\` agent (binding \`${voiceBindingName}\`). */
export class ${voiceClassName} extends VoiceSessionDO {
    public constructor(ctx: ConstructorParameters<typeof VoiceSessionDO>[0], env: Record<string, unknown>) {
        super(ctx, env, ${agent.exportName}, "${agent.exportName}");
    }
}
`;

            return `${workflowClass}${voiceClass}`;
        })
        .join("\n");

    const imports = agents.map((agent) => agent.exportName).join(", ");
    const runtimeImport = hasVoice
        ? `import { compileAgentWorkflow, VoiceSessionDO } from "@lunora/agent";`
        : `import { compileAgentWorkflow } from "@lunora/agent";`;
    const voiceHeaderNote = hasVoice
        ? `\n *\n * Voice-enabled agents ALSO get a \`VoiceSessionDO\` subclass here — a real\n * Durable Object (unlike the Workflow), so wrangler needs both its\n * \`durable_objects\` binding and its \`class_name\` export (the same re-export\n * line covers it).`
        : "";

    return `${GENERATED_HEADER}/**
 * WorkflowEntrypoint classes for the agents declared in \`lunora/agents.ts\`.
 * Each \`defineAgent\` compiles a replay-safe tool-loop onto a Cloudflare
 * Workflow. Re-export them from your worker entry — wrangler requires each
 * \`workflows[].class_name\` to be exported by the worker:
 *
 * \`export * from "./lunora/_generated/agents.js";\`${voiceHeaderNote}
 */
import LunoraWorkflow from "@lunora/workflow/do";
${runtimeImport}
import type { AgentRunInput, AgentRunResult } from "@lunora/agent";

import { ${imports} } from "../agents.js";

${classes}`;
};

/**
 * Emit `_generated/queues.ts` — the push-consumer registry the worker `queue()`
 * handler dispatches through. Maps each push queue's stable wrangler name (which
 * `batch.queue` carries) to its `defineQueue` definition + export name. Pull
 * queues are consumed by an external worker, so they carry no handler and are
 * omitted here. Returns "" (and the file is not written) when no push queues are
 * declared — a pull-only or queue-free app keeps a clean `_generated/`.
 */
const emitQueues = (queues: ReadonlyArray<QueueIR>): string => {
    const pushQueues = queues.filter((queue) => queue.mode === "push");

    if (pushQueues.length === 0) {
        return "";
    }

    for (const queue of pushQueues) {
        assertIdentifier(queue.exportName, `queue export "${queue.exportName}"`);
    }

    const imports = pushQueues.map((queue) => queue.exportName).join(", ");
    const entries = pushQueues
        .map(
            (queue) =>
                `    ${JSON.stringify(queue.name)}: { binding: ${JSON.stringify(queue.bindingName)}, definition: ${queue.exportName}, exportName: ${JSON.stringify(queue.exportName)} },`,
        )
        .join("\n");

    return `${GENERATED_HEADER}/**
 * Push-consumer registry for the queues declared in \`lunora/queues.ts\`. The
 * composed worker's \`queue(batch, env, ctx)\` entry routes each delivered batch
 * by \`batch.queue\` to the matching \`defineQueue\` handler. Wired automatically
 * by \`defineApp\` — you don't import this directly.
 */
import type { QueueRegistry } from "@lunora/queue";

import { ${imports} } from "../queues.js";

/** Stable wrangler queue name → { binding, definition, exportName } for batch routing. */
export const LUNORA_QUEUE_REGISTRY: QueueRegistry = {
${entries}
};
`;
};

/**
 * The `ctx.workflows` code fragments woven into the generated ShardDO, or empty
 * strings when the project declares no workflows. Mirrors
 * {@link emitContainerFragments}: the spec list is emitted as a
 * `LUNORA_WORKFLOWS` const and handed to `createWorkflowContext` with the shard
 * DO's `ctx.exports`, which resolves each workflow by its class name lazily (a
 * missing one only throws when the handle is used).
 */
const emitWorkflowFragments = (workflows: ReadonlyArray<WorkflowIR>): { build: string; contextField: string; importLines: string[]; specs: string } => {
    if (workflows.length === 0) {
        return { build: "", contextField: "", importLines: [], specs: "" };
    }

    for (const workflow of workflows) {
        assertIdentifier(workflow.exportName, `workflow export "${workflow.exportName}"`);
        assertIdentifier(workflow.className, `workflow class "${workflow.className}"`);
    }

    const specEntries = workflows.map((workflow) => `    { className: "${workflow.className}", exportName: "${workflow.exportName}" },`).join("\n");

    return {
        build: `
            const workflows = createWorkflowContext(env, LUNORA_WORKFLOWS, this.state.exports);
`,
        contextField: `\n                workflows,`,
        importLines: [`import type { WorkflowBindingSpec } from "@lunora/workflow";`, `import { createWorkflowContext } from "@lunora/workflow";`],
        // eslint-disable-next-line no-secrets/no-secrets -- the emitted readonly-array type annotation is dense generated TS, not a credential
        specs: `
/** Wiring specs for \`ctx.workflows\` (codegen-derived from \`lunora/workflows.ts\`). */
const LUNORA_WORKFLOWS: ReadonlyArray<WorkflowBindingSpec> = [
${specEntries}
];
`,
    };
};

/**
 * The `ctx.queues` producer fragments, mirroring {@link emitWorkflowFragments}.
 * Every queue passed here (push or pull) gets a producer binding, so all of them
 * land in `LUNORA_QUEUES` and are resolved off `env` by `createQueueContext`. The
 * caller passes `plainQueues(queues)`: a topic subscription is published to only
 * through `ctx.topics` ({@link emitTopicFragments}). `ctx.queues` rides Mutation +
 * Action contexts (enqueue is a side effect — the type omits it from QueryCtx),
 * but at runtime it is woven onto the shared ctx literal exactly like `ctx.workflows`.
 */
const emitQueueFragments = (queues: ReadonlyArray<QueueIR>): { build: string; contextField: string; importLines: string[]; specs: string } => {
    if (queues.length === 0) {
        return { build: "", contextField: "", importLines: [], specs: "" };
    }

    for (const queue of queues) {
        assertIdentifier(queue.exportName, `queue export "${queue.exportName}"`);
        assertIdentifier(queue.bindingName, `queue binding "${queue.bindingName}"`);
    }

    const specEntries = queues
        .map((queue) => `    { binding: "${queue.bindingName}", exportName: "${queue.exportName}", name: ${JSON.stringify(queue.name)} },`)
        .join("\n");

    return {
        build: `
            const queues = createQueueContext(env, LUNORA_QUEUES);
`,
        contextField: `\n                queues,`,
        importLines: [`import type { QueueBindingSpec } from "@lunora/queue";`, `import { createQueueContext } from "@lunora/queue";`],
        // eslint-disable-next-line no-secrets/no-secrets -- the emitted readonly-array type annotation is dense generated TS, not a credential
        specs: `
/** Wiring specs for \`ctx.queues\` (codegen-derived from \`lunora/queues.ts\`). */
const LUNORA_QUEUES: ReadonlyArray<QueueBindingSpec> = [
${specEntries}
];
`,
    };
};

/**
 * The `ctx.topics` publisher fragments, mirroring {@link emitQueueFragments}: one
 * `LUNORA_TOPICS` spec per topic, listing the binding of every subscription queue
 * a publish fans out to. Same contexts as `ctx.queues`.
 */
const emitTopicFragments = (
    topics: ReadonlyArray<TopicIR>,
    queues: ReadonlyArray<QueueIR>,
): { build: string; contextField: string; importLines: string[]; specs: string } => {
    if (topics.length === 0) {
        return { build: "", contextField: "", importLines: [], specs: "" };
    }

    const specEntries = topics
        .map((topic) => {
            assertIdentifier(topic.exportName, `topic export "${topic.exportName}"`);

            const subscriptions = subscriptionsOf(queues, topic.exportName)
                .map((queue) => `{ binding: "${queue.bindingName}", exportName: "${queue.exportName}" }`)
                .join(", ");

            return `    { exportName: "${topic.exportName}", subscriptions: [${subscriptions}] },`;
        })
        .join("\n");

    return {
        build: `
            const topics = createTopicContext(env, LUNORA_TOPICS);
`,
        contextField: `\n                topics,`,
        importLines: [`import type { TopicBindingSpec } from "@lunora/queue";`, `import { createTopicContext } from "@lunora/queue";`],
        // eslint-disable-next-line no-secrets/no-secrets -- the emitted readonly-array type annotation is dense generated TS, not a credential
        specs: `
/** Wiring specs for \`ctx.topics\` (codegen-derived from \`lunora/queues.ts\`): each topic's subscription queues. */
const LUNORA_TOPICS: ReadonlyArray<TopicBindingSpec> = [
${specEntries}
];
`,
    };
};

/**
 * The `ctx.services` fragments (plan 457): a `LUNORA_SERVICES` spec list and the
 * `createServices` build, woven onto the action ctx only — a cross-Worker call
 * is non-deterministic I/O, the same reason `ctx.browser` is action-only.
 */
const emitServiceFragments = (services: ReadonlyArray<ServiceBindingIR>, serverSpecifier: string): { build: string; importLines: string[]; specs: string } => {
    if (services.length === 0) {
        return { build: "", importLines: [], specs: "" };
    }

    const specEntries = services
        .map((service) => {
            assertIdentifier(service.name, `service "${service.name}"`);
            assertIdentifier(service.binding, `service binding "${service.binding}"`);

            return `    { binding: "${service.binding}", name: "${service.name}"${service.rpcEntrypoint === undefined ? "" : ", rpc: true"} },`;
        })
        .join("\n");

    return {
        build: `
            const services = createServices(env, LUNORA_SERVICES);
`,
        importLines: [`import type { ServiceBindingSpec } from "${serverSpecifier}";`, `import { createServices } from "${serverSpecifier}";`],
        // eslint-disable-next-line no-secrets/no-secrets -- the emitted readonly-array type annotation is dense generated TS, not a credential
        specs: `
/** Wiring specs for \`ctx.services\` (codegen-derived from \`lunora.config\` \`services\`). */
const LUNORA_SERVICES: ReadonlyArray<ServiceBindingSpec> = [
${specEntries}
];
`,
    };
};

/**
 * The `ctx.agents` producer fragments, mirroring {@link emitQueueFragments}.
 * Every declared agent resolves off the shard DO's `ctx.exports` lazily
 * (via `createAgentContext`), so a missing binding only throws when that agent
 * is actually started. `ctx.agents` rides Mutation + Action contexts (starting a
 * run is a side effect — the type omits it from QueryCtx), but at runtime it is
 * woven onto the shared ctx literal exactly like `ctx.workflows` / `ctx.queues`.
 */
const emitAgentFragments = (agents: ReadonlyArray<AgentIR>): { build: string; contextField: string; importLines: string[]; specs: string } => {
    if (agents.length === 0) {
        return { build: "", contextField: "", importLines: [], specs: "" };
    }

    for (const agent of agents) {
        assertIdentifier(agent.exportName, `agent export "${agent.exportName}"`);
        assertIdentifier(agent.className, `agent class "${agent.className}"`);
    }

    const specEntries = agents
        .map((agent) => `    { className: "${agent.className}", exportName: "${agent.exportName}"${agent.publicRun === true ? ", publicRun: true" : ""} },`)
        .join("\n");

    return {
        build: `
            const agents = createAgentContext(env, LUNORA_AGENTS, { exports: this.state.exports });
`,
        contextField: `\n                agents,`,
        importLines: [`import { createAgentContext } from "@lunora/agent";`, `import type { AgentBindingSpec } from "@lunora/agent";`],
        // eslint-disable-next-line no-secrets/no-secrets -- the emitted readonly-array type annotation is dense generated TS, not a credential
        specs: `
/** Wiring specs for \`ctx.agents\` (codegen-derived from \`lunora/agents.ts\`). */
const LUNORA_AGENTS: ReadonlyArray<AgentBindingSpec> = [
${specEntries}
];
`,
    };
};

/**
 * The shared skeleton of the studio metadata fragments: a doc'd
 * `const <name>: <Type> = <JSON>` constant plus the `<method>()` override that
 * returns it.
 */
const renderMetadataFragments = (name: string, type: string, method: string, metadata: unknown, document_: string): { constant: string; override: string } => {
    return {
        constant: `
${document_}
const ${name} = ${renderJsonData(metadata, type)};
`,
        override: `
        protected override ${method}(): ${type} {
            return ${name};
        }
`,
    };
};

/**
 * Read-only declared-workflow metadata fragments for the studio's workflows view:
 * the `LUNORA_WORKFLOWS_INFO` constant (the discovered {@link WorkflowIR} set
 * mapped to the DO's `WorkflowMetadata` wire shape) and the `workflowsMetadata()`
 * override that returns it. Both are empty strings unless the project declares
 * workflows — when it has none the base-class hook (an empty list) stands, so the
 * generated shard stays byte-identical to a workflow-free app.
 */
const emitWorkflowsMetadataFragments = (workflows: ReadonlyArray<WorkflowIR>): { constant: string; override: string } => {
    if (workflows.length === 0) {
        return { constant: "", override: "" };
    }

    const metadata: WorkflowsResult = {
        workflows: workflows.map((workflow) => {
            return {
                className: workflow.className,
                exportName: workflow.exportName,
                name: workflow.name,
            };
        }),
    };

    return renderMetadataFragments(
        "LUNORA_WORKFLOWS_INFO",
        "WorkflowsResult",
        "workflowsMetadata",
        metadata,
        `/** Read-only declared-workflow metadata (discovered from \`lunora/workflows.ts\`) served via \`__lunora_admin__:listWorkflows\` for the studio's workflows view. */`,
    );
};

/**
 * Read-only declared-queue metadata fragments for the studio's queues view: the
 * `LUNORA_QUEUES_INFO` constant (the discovered {@link QueueIR} set mapped to the
 * DO's `QueueMetadata` wire shape) and the `queuesMetadata()` override that
 * returns it. Both are empty strings unless the project declares queues — when it
 * has none the base-class hook (an empty list) stands, so the generated shard
 * stays byte-identical to a queue-free app.
 */
const emitQueuesMetadataFragments = (queues: ReadonlyArray<QueueIR>): { constant: string; override: string } => {
    if (queues.length === 0) {
        return { constant: "", override: "" };
    }

    const metadata: QueuesResult = {
        queues: queues.map((queue) => {
            return {
                binding: queue.bindingName,
                ...(queue.tuning.deadLetterQueue === undefined ? {} : { deadLetterQueue: queue.tuning.deadLetterQueue }),
                exportName: queue.exportName,
                mode: queue.mode,
                name: queue.name,
                ...(queue.topic === undefined ? {} : { topic: queue.topic }),
            };
        }),
    };

    return renderMetadataFragments(
        "LUNORA_QUEUES_INFO",
        "QueuesResult",
        "queuesMetadata",
        metadata,
        `/** Read-only declared-queue metadata (discovered from \`lunora/queues.ts\`) served via \`__lunora_admin__:listQueues\` for the studio's queues view. */`,
    );
};

/**
 * The `ctx.payments` code fragments woven into the generated ShardDO, or empty strings when the
 * project doesn't use payments. Unlike `ctx.ai` (a stateless binding), the facade is stateful —
 * its store rides the request's `ctx.db` — so `build` is emitted *after* `db` is constructed and
 * uses `paymentsFromContext` (the per-context wiring lives in `@lunora/payment`, not this string).
 */
const emitPaymentFragments = (
    hasPayments: boolean,
): { build: string; configField: string; contextField: string; imports: ReadonlyArray<string>; stub: string } => {
    if (!hasPayments) {
        return { build: "", configField: "", contextField: "", imports: [], stub: "" };
    }

    const missing = `throw new Error("ctx.payments: no payment configured. Pass \\\`payment\\\` to createShardDO().");`;

    return {
        imports: [
            `import type { LunoraDatabaseLike as LunoraPaymentDbLike, LunoraPayment, PaymentsFromContextOptions } from "@lunora/payment";`,
            `import { paymentsFromContext } from "@lunora/payment";`,
        ],
        // Built after `db` (the store rides ctx.db) and `userId` (the default authorizer ties a
        // referenceId to the caller). The adapter — which carries provider secrets — comes from
        // the `config.payment` thunk over env. Falls back to `paymentStub`.
        build: `
            const payments: LunoraPayment = config.payment
                ? paymentsFromContext({ auth: { userId: userId ?? null }, db: db as unknown as LunoraPaymentDbLike }, config.payment(env))
                : paymentStub;
`,
        configField: `\n    payment?: (env: Record<string, unknown>) => PaymentsFromContextOptions;`,
        contextField: `\n                payments,`,
        stub: renderThrowingStub(
            "paymentStub: LunoraPayment",
            missing,
            ["attach", "cancelSubscription", "check", "createCheckout", "createPortalSession", "handleWebhook", "listBalances", "listSubscriptions", "track"],
            {
                cast: " as unknown as LunoraPayment",
                sync: [
                    "attach",
                    "cancelSubscription",
                    "check",
                    "createCheckout",
                    "createPortalSession",
                    "handleWebhook",
                    "listBalances",
                    "listSubscriptions",
                    "track",
                ],
            },
        ),
    };
};

/**
 * The bespoke `ctx.x402` fragments (mirrors {@link emitPaymentFragments}). The
 * pay rail signs and settles USDC per request, so — like `ctx.payments` — it is
 * built inline rather than from a capability row's `serverCtxField`.
 *
 * `lazyX402Pay` keeps `buildCtx` synchronous: it returns immediately and builds
 * the real (async, secret-reading, signer-importing) rail on the first `fetch`,
 * memoising it so one spend-policy state is shared for the ctx's lifetime. The
 * wallet secret is read through `ctx.secrets` (a Secrets Store binding), which is
 * why `getSecret` closes over the in-scope `secrets` facade. Falls back to
 * `x402Stub` — a rail whose `fetch` throws — when no `x402` config is passed.
 */
const emitX402Fragments = (hasX402: boolean): { build: string; configField: string; imports: ReadonlyArray<string>; stub: string } => {
    if (!hasX402) {
        return { build: "", configField: "", imports: [], stub: "" };
    }

    const x402Missing = `throw new Error("ctx.x402: no pay rail configured. Pass \\\`x402\\\` to createShardDO().");`;

    return {
        imports: [`import type { X402Pay, X402PayConfig } from "@lunora/x402/pay";`, `import { lazyX402Pay } from "@lunora/x402/pay";`],
        // Built lazily off `secrets` (the Secrets Store facade already in scope) and
        // the `config.x402` thunk over env; falls back to `x402Stub`.
        build: `
            const x402: X402Pay = config.x402
                ? lazyX402Pay(config.x402(env), { getSecret: (name: string) => secrets.get(name) })
                : x402Stub;
`,
        configField: `\n    x402?: (env: Record<string, unknown>) => X402PayConfig;`,
        stub: renderThrowingStub("x402Stub: X402Pay", x402Missing, ["fetch"], { cast: " as unknown as X402Pay", sync: ["fetch"] }),
    };
};

/**
 * The `@lunora/do` type names the generated shard imports. The base set is always
 * present; `WorkflowsResult` / `QueuesResult` are added only when the project
 * declares workflows / queues (their `*Metadata()` overrides reference them),
 * `SearchBackfillProgress` only when it has shard-local search indexes (the
 * `backfillSearch` override's return type) and `WriteHook` only when it has
 * vector indexes (the auto-sync write hook), so a workflow-/queue-/search-/
 * vector-free app's import line stays minimal.
 */
const buildDoTypeImports = (hasVectors: boolean, hasWorkflows: boolean, hasQueues: boolean, hasFlags: boolean, hasShardSearchIndexes: boolean): string[] => [
    "AdvisorProcedure",
    "AdvisoryFinding",
    "DatabaseWriterLike",
    "DataMigrationLike",
    "DispatchBookmark",
    "ExportRow",
    ...(hasFlags ? ["FlagsResult"] : []),
    "ImportShardResult",
    "KeyRange",
    "MaskPoliciesResult",
    "MigrationRunResult",
    "QueryReadScope",
    ...(hasQueues ? ["QueuesResult"] : []),
    "RelatedPage",
    "RunShardApplyCdcArgs",
    "RunShardExportArgs",
    "RunShardFindRelatedArgs",
    "RunShardImportArgs",
    "RunShardMigrationArgs",
    "RlsPoliciesResult",
    "RunShardRankBeforeArgs",
    "RunShardRankPageArgs",
    "RunShardWriteArgs",
    "RunShardWriteResult",
    "SchedulerLike",
    ...(hasShardSearchIndexes ? ["SearchBackfillProgress"] : []),
    "TransactionHeadroomTracker",
    "SchemaLike",
    "ShardDOState",
    "ShardRankPageResult",
    "SqlExec",
    "StorageRulesResult",
    "StudioFeaturesResult",
    "SubscriptionIdentity",
    "SystemReaderStorageLike",
    "TelemetrySink",
    ...(hasVectors ? ["VectorBackfillProgress"] : []),
    ...(hasWorkflows ? ["WorkflowsResult"] : []),
    ...(hasVectors ? ["WriteHook"] : []),
];

export {
    buildDoTypeImports,
    emitAgentFragments,
    emitAgents,
    emitContainerFragments,
    emitContainers,
    emitPaymentFragments,
    emitQueueFragments,
    emitQueues,
    emitQueuesMetadataFragments,
    emitServiceFragments,
    emitTopicFragments,
    emitWorkflowFragments,
    emitWorkflows,
    emitWorkflowsMetadataFragments,
    emitX402Fragments,
};
