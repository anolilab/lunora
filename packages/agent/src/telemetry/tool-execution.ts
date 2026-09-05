import type { DynamicToolCall, Telemetry, TelemetryOptions } from "ai";

import { combineTelemetry } from "./combine";

/** The identity of one tool call the agent loop is about to run. */
interface TracedToolCall {
    /** The provider's tool-call id (also the durable step's identity). */
    id: string;
    /** The arguments the model produced for the call. */
    input: unknown;
    /** The declared tool's name. */
    name: string;
}

/** Normalize `TelemetryOptions.integrations` (a single integration OR an array) into one integration. */
const resolveIntegration = (telemetry: TelemetryOptions | undefined): Telemetry | undefined => {
    if (telemetry === undefined || telemetry.isEnabled === false) {
        return undefined;
    }

    const { integrations } = telemetry;

    if (integrations === undefined) {
        return undefined;
    }

    const list = Array.isArray(integrations) ? integrations : [integrations];

    return list.length === 0 ? undefined : combineTelemetry(...list);
};

/**
 * Report one tool execution to the agent's telemetry integrations, from the
 * place the tool actually runs.
 *
 * **Why the loop and not the AI SDK.** `prepareAgentTurn` exposes each tool to
 * the model SCHEMA-ONLY (no `execute`), because execution belongs in the durable
 * loop as its own named `step.do` — memoized, resumable, and re-runnable across a
 * deploy. `ai@7` skips its whole tool-telemetry path for a tool it cannot
 * execute (`isExecutableTool`), so the SDK never fires `onToolExecutionStart`,
 * `executeTool` or `onToolExecutionEnd` for a Lunora agent: every bridge's tool
 * span was unreachable code. Handing the SDK an executable tool would fix the
 * telemetry by moving execution back INSIDE the model call and throwing away
 * durability, which is the wrong trade — so the loop emits the events itself.
 *
 * The events carry a `DynamicToolCall`, which is what the tool genuinely is from
 * the SDK's point of view: named and typed by us, not by its tool set.
 *
 * Called from INSIDE the tool's `step.do` body, so a workflow replay that serves
 * a memoized tool result emits no span — one span per real execution, the same
 * rule the model-call spans follow.
 * @param telemetry The agent's configured `telemetry` option; disabled or
 * integration-less telemetry runs `execute` untouched.
 * @param call The tool call's id, name, and arguments.
 * @param execute The real execution — its value is returned and its failure
 * re-thrown untouched, so telemetry is never flow control.
 */
const traceToolExecution = async <T>(telemetry: TelemetryOptions | undefined, call: TracedToolCall, execute: () => Promise<T>): Promise<T> => {
    const integration = resolveIntegration(telemetry);

    if (integration === undefined) {
        return execute();
    }

    const toolCall: DynamicToolCall = { dynamic: true, input: call.input, toolCallId: call.id, toolName: call.name, type: "tool-call" };
    // The SDK correlates a generation's events by `callId`; the loop's stable
    // per-call identity is the tool-call id itself, which is also what the
    // durable step is keyed on — so a replayed run reports the same id.
    const base = { callId: call.id, messages: [], toolCall, toolContext: undefined };
    const startedAt = Date.now();

    await integration.onToolExecutionStart?.(base);

    try {
        const output = await (integration.executeTool === undefined ? execute() : integration.executeTool({ ...base, execute, toolCallId: call.id }));

        await integration.onToolExecutionEnd?.({
            ...base,
            toolExecutionMs: Date.now() - startedAt,
            toolOutput: { dynamic: true, input: call.input, output, toolCallId: call.id, toolName: call.name, type: "tool-result" },
        });

        return output;
    } catch (error) {
        await integration.onToolExecutionEnd?.({
            ...base,
            toolExecutionMs: Date.now() - startedAt,
            toolOutput: { dynamic: true, error, input: call.input, toolCallId: call.id, toolName: call.name, type: "tool-error" },
        });

        throw error;
    }
};

export type { TracedToolCall };
export { traceToolExecution };
