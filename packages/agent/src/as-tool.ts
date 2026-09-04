import { LunoraError } from "@lunora/errors";
import { isDuplicateInstanceError } from "@lunora/workflow";
import { jsonSchema } from "ai";

import { agentBindingName } from "./naming";
import { DEFAULT_AGENT_FUNCTION_PATHS, toFunctionReference } from "./paths";
import isPositiveInteger from "./positive-integer";
import type {
    AgentAsToolOptions,
    AgentMessageRow,
    AgentRunInput,
    AgentSubToolInput,
    AgentToolContext,
    AgentToolDefinition,
    AgentWorkflowBindingLike,
    AgentWorkflowInstanceLike,
} from "./types";

/** Cloudflare Workflows instance statuses that mean the run has stopped. */
const TERMINAL_STATUSES = new Set(["complete", "errored", "terminated"]);

/**
 * Default cap on child-run status polls before the tool gives up. With
 * {@link DEFAULT_POLL_INTERVAL_MS} this is a **five-minute** wall-clock budget.
 *
 * The old 120 polls were 60 seconds, which is under one multi-turn child run: a
 * sub-agent that makes two or three tool-using LLM turns routinely passes it, so
 * the default terminated legitimate delegations and told the parent the child
 * "did not finish". Five minutes is inside a Workflow step's own bounds and
 * still stops a wedged child from holding the parent forever.
 */
const DEFAULT_MAX_POLLS = 600;

/**
 * How deep a chain of sub-agent delegations may go. A run started by a user is
 * depth 0 and each `asTool` call spawns its child one deeper, so at most three
 * levels of sub-agents run below any user-facing run.
 *
 * `maxTurns` bounds the turns of ONE level and nothing bounded the TREE: two
 * agents holding each other's `asTool` delegate back and forth forever, and
 * because every level derives a DISTINCT child `threadKey`, the per-thread
 * run-queue cap never applies across them. A timed-out parent does not stop its
 * child either, so an unbounded chain keeps spawning Workflow instances (and
 * billing model calls) long after the top-level run has answered.
 */
const MAX_DELEGATION_DEPTH = 3;

/** Default delay (ms) between child-run status polls. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Read the `status` string off a Cloudflare Workflows `InstanceStatus` (else `"unknown"`). */
const readStatus = (raw: unknown): string => {
    if (raw !== null && typeof raw === "object" && typeof (raw as { status?: unknown }).status === "string") {
        return (raw as { status: string }).status;
    }

    return "unknown";
};

/** Read the `output` off a Cloudflare Workflows `InstanceStatus` (`undefined` when absent). */
const readOutput = (raw: unknown): unknown => (raw !== null && typeof raw === "object" ? (raw as { output?: unknown }).output : undefined);

/** Sleep between polls; the default is a real timer, overridable for tests. */
const defaultWait = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

/**
 * Poll a child run's status until it reaches a terminal state, then return that
 * status (or `"timeout"` if the poll budget is exhausted). Cloudflare Workflows
 * exposes no await-instance primitive from within a step — completion is
 * observed via `status()` — so a sub-agent tool polls rather than awaits.
 */
const pollUntilTerminal = async (
    instance: AgentWorkflowInstanceLike,
    maxPolls: number,
    pollIntervalMs: number,
    wait: (ms: number) => Promise<void>,
): Promise<{ output: unknown; status: string }> => {
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential polling IS the model: read status, wait, read again
        const raw = await instance.status();
        const status = readStatus(raw);

        if (TERMINAL_STATUSES.has(status)) {
            return { output: readOutput(raw), status };
        }

        // eslint-disable-next-line no-await-in-loop -- deliberate back-off between status reads
        await wait(pollIntervalMs);
    }

    return { output: undefined, status: "timeout" };
};

/**
 * Why the child loop stopped, off the completed instance's `output` (the
 * `AgentRunResult` the agent workflow returns). `undefined` when the child ran
 * to a normal answer, or when the host reported no output.
 */
const readStopped = (output: unknown): string | undefined => {
    if (output !== null && typeof output === "object" && typeof (output as { stopped?: unknown }).stopped === "string") {
        return (output as { stopped: string }).stopped;
    }

    return undefined;
};

/** The last assistant answer (a turn with no pending tool calls) on the child thread. */
const finalAnswer = (history: ReadonlyArray<AgentMessageRow>): string => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const row = history[index];

        if (row?.role === "assistant" && (row.toolCalls === undefined || row.toolCalls.length === 0)) {
            return row.content;
        }
    }

    return "";
};

/**
 * Adapt a declared agent into a tool the parent's model can call: `execute`
 * starts a CHILD run on the child agent's Workflow binding, waits for it to
 * finish, and returns its final answer — so a supervisor agent can delegate to
 * specialists.
 *
 * Replay-safety: the whole `execute` runs inside the loop's `tool:NAME:CALL_ID`
 * durable step, so a completed sub-run is memoized and never re-run. The child
 * `threadKey` and Workflow instance id both DERIVE from the parent's
 * (replay-stable) `threadKey` + `toolCallId`, so a retried step reuses the same
 * child run rather than forking a new one (idempotent create-or-get). No
 * `Date.now()`/`Math.random()`.
 *
 * The child's completion is observed by POLLING `instance.status()` (Cloudflare
 * Workflows has no in-step await-instance primitive), and the answer is read
 * back from the child's persisted thread — the single source of truth — via the
 * shared `agents:agentMessages` runtime function.
 * @experimental
 */
const agentAsTool = (options: AgentAsToolOptions): AgentToolDefinition<AgentSubToolInput, string> => {
    if (typeof options.name !== "string" || options.name.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: agent.asTool requires a `name` (the child agent's export name, selecting its AGENT_* binding)");
    }

    if (typeof options.description !== "string" || options.description.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: agent.asTool requires a non-empty `description` (the parent model decides from it)");
    }

    if (options.maxPolls !== undefined && !isPositiveInteger(options.maxPolls)) {
        // `slice`-style leniency has no place here: `maxPolls: 0` returned
        // "timeout" without a single status read, so the parent reported the
        // child had not finished before the child had even been looked at.
        throw new LunoraError("INTERNAL", "@lunora/agent: agent.asTool `maxPolls` must be a positive integer");
    }

    const { name } = options;
    const bindingName = agentBindingName(name);
    const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const wait = options.wait ?? defaultWait;
    const listMessages = toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.listMessages);

    const execute = async (input: AgentSubToolInput, context: AgentToolContext): Promise<string> => {
        // Recursion bound, checked BEFORE the binding is touched so a cycle
        // costs nothing at the last level. Returned as the tool's answer rather
        // than thrown: a throw fails (and retries) the parent's durable step,
        // while a message lets the parent's model recover and answer directly.
        const depth = (isPositiveInteger(context.depth) ? context.depth : 0) + 1;

        if (depth > MAX_DELEGATION_DEPTH) {
            return `Sub-agent "${name}" was not started: the maximum delegation depth of ${String(MAX_DELEGATION_DEPTH)} is already reached. Answer with what you have instead of delegating further.`;
        }

        const binding = context.env[bindingName] as AgentWorkflowBindingLike | undefined;

        if (!binding || typeof binding.create !== "function" || typeof binding.get !== "function") {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: agent.asTool("${name}") found no Workflow binding "${bindingName}" on env — declare the "${name}" agent so codegen wires its binding`,
            );
        }

        // Derived, replay-stable identifiers: the same parent step re-running
        // (only on failure — a completed step is memoized) reuses the same child
        // run instead of starting a second one.
        //
        // `childInstanceId` must satisfy Cloudflare's instance-id grammar —
        // `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, at most 100 characters, NO `:` — which
        // `create` rejects deterministically. Both parts hold today (`name` is an
        // export name, `toolCallId` a provider/AI-SDK id, both alphanumeric), so
        // this is a note for whoever changes the shape, not a live hazard.
        const childThreadKey = `${context.threadKey}::sub::${name}::${context.toolCallId}`;
        const childInstanceId = `sub-${name}-${context.toolCallId}`;
        // The child thread inherits the PARENT's verified owner. Created without
        // one it was ownerless, so `agents:agentThread`/`agentMessages` admitted
        // any caller who knew the (derivable) key — a sub-thread of an owned
        // conversation, world-readable.
        const params: AgentRunInput = {
            depth,
            input: input.prompt,
            threadKey: childThreadKey,
            ...(context.owner === undefined ? {} : { owner: context.owner }),
        };

        let instance: AgentWorkflowInstanceLike;

        try {
            const handle = await binding.create({ id: childInstanceId, params });

            instance = await binding.get(handle.id);
        } catch (error) {
            // Only a genuine duplicate-instance-id rejection means a prior
            // attempt already created this child run — take it over. Any other
            // failure (Workflows service error, quota, bad params) must
            // surface so the durable step retries or fails visibly, rather
            // than silently attaching to (and returning the stale/empty
            // answer of) an unrelated instance that errored on its own first
            // attempt. Mirrors the channel path's same idempotency check.
            if (!isDuplicateInstanceError(error)) {
                throw error;
            }

            instance = await binding.get(childInstanceId);
        }

        const { output, status: terminal } = await pollUntilTerminal(instance, maxPolls, pollIntervalMs, wait);

        if (terminal === "errored" || terminal === "terminated") {
            return `Sub-agent "${name}" ${terminal} before producing an answer.`;
        }

        if (terminal === "timeout") {
            // Giving up on the poll is abandoning the child, so stop it: the
            // parent already reports it never finished, and a child left running
            // keeps spawning turns (and its own sub-agents) that nothing will
            // ever read. Best-effort — an instance that already finished or was
            // reaped rejects `terminate`, which must not mask the answer.
            try {
                await instance.terminate();
            } catch {
                /* the child is already gone (or unreachable) — the answer below stands either way */
            }

            return `Sub-agent "${name}" did not finish within the allotted time.`;
        }

        // A child that ran out of turns still COMPLETES its workflow, and it has
        // no assistant turn without pending tool calls — so `finalAnswer` came
        // back empty and the parent got a blank tool result with no hint why.
        // Say so instead, so the parent's model can narrow the sub-task.
        if (readStopped(output) === "maxTurns") {
            return `Sub-agent "${name}" hit its turn cap (maxTurns) before producing a final answer. Ask it something narrower, or answer with what you have.`;
        }

        const history = (await context.run(listMessages, { key: childThreadKey })) as AgentMessageRow[];

        return finalAnswer(history);
    };

    return {
        description: options.description,
        execute,
        inputSchema: jsonSchema<AgentSubToolInput>({
            properties: {
                prompt: { description: "The task or question to delegate to the sub-agent.", type: "string" },
            },
            required: ["prompt"],
            type: "object",
        }),
        isLunoraAgentTool: true,
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export { agentAsTool };
