import { LunoraError } from "@lunora/errors";
import { jsonSchema } from "ai";

import { isDuplicateInstanceError } from "./channels";
import { agentBindingName } from "./naming";
import { DEFAULT_AGENT_FUNCTION_PATHS, toFunctionReference } from "./paths";
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

/** Default cap on child-run status polls before the tool gives up. */
const DEFAULT_MAX_POLLS = 120;

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
): Promise<string> => {
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential polling IS the model: read status, wait, read again
        const status = readStatus(await instance.status());

        if (TERMINAL_STATUSES.has(status)) {
            return status;
        }

        // eslint-disable-next-line no-await-in-loop -- deliberate back-off between status reads
        await wait(pollIntervalMs);
    }

    return "timeout";
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

    if (options.maxPolls !== undefined && (!Number.isInteger(options.maxPolls) || options.maxPolls < 1)) {
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
        const depth = (Number.isInteger(context.depth) ? (context.depth as number) : 0) + 1;

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
        const childThreadKey = `${context.threadKey}::sub::${name}::${context.toolCallId}`;
        const childInstanceId = `sub-${name}-${context.toolCallId}`;
        const params: AgentRunInput = { depth, input: input.prompt, threadKey: childThreadKey };

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

        const terminal = await pollUntilTerminal(instance, maxPolls, pollIntervalMs, wait);

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
