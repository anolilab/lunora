import type { FunctionReference, LunoraClient } from "@lunora/client";

import type { ToolDefinition, ToolInputSchema, ToolResult } from "./tools";

/**
 * Agent exposure for the MCP server: a durable `@lunora/agent` run fronted as an
 * MCP tool an external agent can call. The capability boundary is the MCP-server
 * process + its token, so WHICH agents are exposed is config on the server (like
 * `allowWrites`), not on `defineAgent` — keeping `@lunora/agent` codegen
 * byte-identical.
 */
interface McpAgentExposure {
    /** What the agent does — shown to the calling model, which decides from it. */
    description: string;
    /** The agent's export name (its `ctx.agents.<name>` / `AGENT_<NAME>` binding). */
    name: string;
    /** Override the model-facing tool name (default `agent_<name>`). */
    toolName?: string;
}

/**
 * The runtime function paths this module dispatches against, HARDCODED as
 * contract constants rather than imported from `@lunora/agent` — importing that
 * package would pull the AI SDK into `@lunora/mcp` (which must stay light) and
 * add a dependency edge. These mirror `@lunora/agent`'s
 * `DEFAULT_AGENT_FUNCTION_PATHS` (`packages/agent/src/paths.ts`): `agentRun` is
 * the public run-start mutation, `agentThread`/`agentMessages` the public
 * owner-gated reads. KEEP IN SYNC if those paths ever change.
 */
const AGENT_RUN_PATH = "agents:agentRun";
const AGENT_THREAD_PATH = "agents:agentThread";
const AGENT_MESSAGES_PATH = "agents:agentMessages";

/** The generic status/poll tool advertised alongside the per-agent tools. */
const AGENT_STATUS_TOOL_NAME = "lunora_agent_status";

/**
 * Thread statuses that mean the run has stopped — every member of
 * `AgentThreadStatus` except `"running"`.
 *
 * `"awaiting_input"` belongs here: a run paused on a human-in-the-loop tool
 * approval is STOPPED, and nothing this server can do resumes it (MCP offers no
 * way to supply the approval). Treating it as still-running burned the whole
 * `maxWaitMs` budget on ~100 admin queries per call and then reported
 * `status: "running"` with a hint to poll a tool that would answer
 * `awaiting_input` forever.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["awaiting_input", "cancelled", "error", "idle"]);

/** Default wall-clock budget a single `tools/call` awaits before returning a pending result. */
const DEFAULT_MAX_WAIT_MS = 60_000;

/** Default delay between thread-status polls. */
const DEFAULT_POLL_INTERVAL_MS = 600;

/**
 * The uniform input schema every agent tool advertises. Agents share ONE run
 * input (`@lunora/agent` has no per-agent validator), so there is nothing to
 * derive per agent — a single static schema is reused for every agent tool.
 */
const AGENT_RUN_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        prompt: { description: "The task or message for the agent.", type: "string" },
        threadKey: { description: "Reuse to continue a conversation; omit to start a new thread.", type: "string" },
        title: { description: "Optional thread title (first run only).", type: "string" },
    },
    required: ["prompt"],
    type: "object",
};

/** The `{ threadKey }` schema of the generic status tool. */
const AGENT_STATUS_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        threadKey: { description: "The thread key returned by an agent tool call.", type: "string" },
    },
    required: ["threadKey"],
    type: "object",
};

/** The model-facing tool name for an exposure (`toolName` override or `agent_<name>`). */
const agentToolName = (exposure: McpAgentExposure): string => exposure.toolName ?? `agent_${exposure.name}`;

/**
 * Parse `LUNORA_MCP_AGENTS` — a `;`-separated list of `name:description` pairs,
 * e.g. `"support:Handles support questions;billing:Billing help"`. The
 * description may itself contain colons (only the FIRST colon splits). Blank
 * entries and entries with an empty name/description are skipped.
 */
const parseAgentsEnv = (raw: string | undefined): McpAgentExposure[] => {
    if (raw === undefined) {
        return [];
    }

    const exposures: McpAgentExposure[] = [];

    for (const entry of raw.split(";")) {
        const trimmed = entry.trim();

        if (trimmed.length === 0) {
            continue;
        }

        const separator = trimmed.indexOf(":");

        if (separator <= 0) {
            continue;
        }

        const name = trimmed.slice(0, separator).trim();
        const description = trimmed.slice(separator + 1).trim();

        if (name.length === 0 || description.length === 0) {
            continue;
        }

        exposures.push({ description, name });
    }

    return exposures;
};

/**
 * Polling a run's status touches no state; the call goes to the deployment.
 */
const READ_ONLY_ANNOTATIONS = { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true } as const;

/**
 * The tools this module advertises. Fail-closed: only the boolean `true` opts
 * in (an env-plumbed caller could pass a truthy string), and the tools appear
 * ONLY when at least one agent is exposed — so an agent-free or non-opted-in
 * server never lists them.
 */
const agentToolDefinitions = (exposures: ReadonlyArray<McpAgentExposure>, allowAgents: boolean): ReadonlyArray<ToolDefinition> => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- intentional runtime guard at an exported API boundary against non-boolean callers
    if (allowAgents !== true || exposures.length === 0) {
        return [];
    }

    const perAgent: ToolDefinition[] = exposures.map((exposure) => {
        return {
            annotations: {
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
                readOnlyHint: false,
                title: `Run the ${exposure.name} agent (starts a durable run)`,
            },
            description: `${exposure.description} Starts a durable agent run and returns its final answer.`,
            inputSchema: AGENT_RUN_INPUT_SCHEMA,
            name: agentToolName(exposure),
        };
    });

    return [
        ...perAgent,
        {
            annotations: { ...READ_ONLY_ANNOTATIONS, title: "Check a durable agent run" },
            description: "Check the status of a durable agent run (and its answer if finished) by its threadKey.",
            inputSchema: AGENT_STATUS_INPUT_SCHEMA,
            name: AGENT_STATUS_TOOL_NAME,
        },
    ];
};

/** True when `name` is one of the agent tools this module handles (given the exposures). */
const isAgentToolName = (name: string, exposures: ReadonlyArray<McpAgentExposure>): boolean =>
    name === AGENT_STATUS_TOOL_NAME || exposures.some((exposure) => agentToolName(exposure) === name);

/** Options threaded into a single agent tool dispatch. */
interface CallAgentToolOptions {
    /** Opt-in gate — must be exactly `true` or the call is refused fail-closed. */
    allowAgents: boolean;
    /** The exposures advertised by this server. */
    exposures: ReadonlyArray<McpAgentExposure>;
    /** Wall-clock budget a single call awaits before returning a pending result. */
    maxWaitMs?: number;
    /** Delay between thread-status polls. */
    pollIntervalMs?: number;
    /** Test seam replacing the between-poll wait; production uses a real timer. */
    wait?: (ms: number) => Promise<void>;
}

/** A durable `crypto.randomUUID`-backed thread key (Node side — never workerd). */
const freshThreadKey = (): string => `mcp-${crypto.randomUUID()}`;

/** Build a dispatchable reference from a hardcoded path. */
const reference = (path: string): FunctionReference => {
    return { __lunoraRef: path };
};

/** Sleep between polls; the default is a real timer, overridable for tests. */
const defaultWait = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

const ok = (value: unknown): ToolResult => {
    return { content: [{ text: JSON.stringify(value, undefined, 2), type: "text" }] };
};

const fail = (text: string): ToolResult => {
    return { content: [{ text, type: "text" }], isError: true };
};

/** Read a non-empty string field off an MCP `arguments` bag (else `undefined`). */
const readString = (input: Record<string, unknown>, key: string): string | undefined => {
    const value = input[key];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * The last assistant answer (a turn with NO pending tool calls) on the thread —
 * the same reduction `@lunora/agent`'s `agentAsTool` applies, reimplemented
 * locally (~10 lines) so `@lunora/mcp` gains no dependency on `@lunora/agent`.
 */
const finalAnswer = (messages: ReadonlyArray<Record<string, unknown>>): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const row = messages[index];
        const toolCalls = row?.["toolCalls"];
        const pending = Array.isArray(toolCalls) && toolCalls.length > 0;

        if (row?.["role"] === "assistant" && !pending) {
            return typeof row["content"] === "string" ? row["content"] : "";
        }
    }

    return "";
};

/** The `status` string off a thread row (else `"unknown"` — includes an unreadable/owner-gated thread). */
const readThreadStatus = (thread: unknown): string => {
    if (thread !== null && typeof thread === "object" && typeof (thread as { status?: unknown }).status === "string") {
        return (thread as { status: string }).status;
    }

    return "unknown";
};

/** Read the thread row + its final answer, returning the terminal payload for `threadKey`. */
const readTerminal = async (client: LunoraClient, threadKey: string, status: string, thread: unknown): Promise<ToolResult> => {
    const messages = (await client.query(reference(AGENT_MESSAGES_PATH), { key: threadKey })) as Record<string, unknown>[];

    if (status === "error") {
        const error = thread !== null && typeof thread === "object" ? (thread as { error?: unknown }).error : undefined;

        return ok({ error: typeof error === "string" ? error : "the agent run failed", status, threadKey });
    }

    if (status === "awaiting_input") {
        // Not an error — the run is healthy and paused on a human-in-the-loop
        // tool approval. Say so plainly, including that MCP is not the surface
        // that can unblock it, so the caller stops polling instead of waiting
        // out a budget that can never expire into an answer.
        return ok({
            hint: "This run is paused on a human-in-the-loop tool approval. Approve or reject it in the app that owns the agent; MCP cannot supply the input. Poll lunora_agent_status with this threadKey afterwards.",
            status,
            text: finalAnswer(messages),
            threadKey,
        });
    }

    return ok({ status, text: finalAnswer(messages), threadKey });
};

/**
 * The generic `lunora_agent_status` poll tool: read the current thread status
 * and, once terminal, its final answer — the caller's resume path after a
 * pending result.
 */
const callAgentStatus = async (client: LunoraClient, input: Record<string, unknown>): Promise<ToolResult> => {
    const threadKey = readString(input, "threadKey");

    if (threadKey === undefined) {
        return fail('"threadKey" is required and must be a non-empty string');
    }

    const thread = await client.query(reference(AGENT_THREAD_PATH), { key: threadKey });
    const status = readThreadStatus(thread);

    if (TERMINAL_STATUSES.has(status)) {
        return readTerminal(client, threadKey, status, thread);
    }

    return ok({ status: status === "unknown" ? "running" : status, threadKey });
};

/**
 * Dispatch an agent tool call: start a durable run via `agents:agentRun`, then
 * await-with-timeout — poll `agents:agentThread` until terminal (returning the
 * final answer from `agents:agentMessages`) or, on budget exhaustion, return a
 * NON-error pending payload the caller resumes with `lunora_agent_status`.
 *
 * Fail-closed: refused at dispatch unless `allowAgents === true`, mirroring the
 * `allowWrites` guard — starting a run is a side effect and must not ride the
 * read-only default.
 */
const callAgentTool = async (client: LunoraClient, name: string, input: Record<string, unknown>, options: CallAgentToolOptions): Promise<ToolResult> => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- intentional runtime guard at an exported API boundary against non-boolean callers
        if (options.allowAgents !== true) {
            return fail(`tool "${name}" is disabled: agent tools are off. Enable them with the LUNORA_MCP_ALLOW_AGENTS env var.`);
        }

        if (name === AGENT_STATUS_TOOL_NAME) {
            return await callAgentStatus(client, input);
        }

        const exposure = options.exposures.find((candidate) => agentToolName(candidate) === name);

        if (exposure === undefined) {
            return fail(`agent tool "${name}" is not exposed by this MCP server`);
        }

        const prompt = readString(input, "prompt");

        if (prompt === undefined) {
            return fail('"prompt" is required and must be a non-empty string');
        }

        const threadKey = readString(input, "threadKey") ?? freshThreadKey();
        const title = readString(input, "title");

        const { id } = (await client.mutation(reference(AGENT_RUN_PATH), {
            agent: exposure.name,
            input: prompt,
            threadKey,
            ...(title === undefined ? {} : { title }),
        })) as { id: string; threadKey: string };

        const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
        const wait = options.wait ?? defaultWait;
        // Deterministic budget: poll a bounded number of times (so an injected
        // immediate-wait terminates), one poll per interval across the budget.
        const maxPolls = Math.max(1, Math.ceil(maxWaitMs / pollIntervalMs));

        for (let attempt = 0; attempt < maxPolls; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential polling IS the model: read status, wait, read again
            const thread = await client.query(reference(AGENT_THREAD_PATH), { key: threadKey });
            const status = readThreadStatus(thread);

            if (TERMINAL_STATUSES.has(status)) {
                // eslint-disable-next-line no-await-in-loop -- terminal read happens once, then we return
                return await readTerminal(client, threadKey, status, thread);
            }

            // eslint-disable-next-line no-await-in-loop -- deliberate back-off between status reads
            await wait(pollIntervalMs);
        }

        // Budget exhausted while still running: a valid pending result, NOT an
        // error — the caller resumes by polling with the threadKey.
        return ok({ hint: "call lunora_agent_status with this threadKey to poll for the answer", runId: id, status: "running", threadKey });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return fail(message);
    }
};

export type { CallAgentToolOptions, McpAgentExposure };
export { AGENT_RUN_INPUT_SCHEMA, AGENT_STATUS_TOOL_NAME, agentToolDefinitions, callAgentTool, finalAnswer, isAgentToolName, parseAgentsEnv };
