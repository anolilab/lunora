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
 * re-thrown untouched, so telemetry is never flow control. An integration that
 * throws is reported as a telemetry fault and the tool's own outcome stands; it
 * never turns into a failed (and then retried) durable step.
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

    // The tool's real outcome, recorded as it happens. `integration.executeTool`
    // is host SDK code — a Sentry `startSpan`, a Braintrust `traced` — running
    // inside the tool's durable `step.do`, and a throw from IT must never become
    // the TOOL's failure: the step would retry a tool that already ran, or report
    // a successful tool as failed. So the recorded outcome always wins over the
    // wrapper's, and the tool is executed here only if the wrapper threw without
    // ever reaching it. The lifecycle callbacks need no such guard — `combine.ts`
    // fans those out through `Promise.allSettled`.
    let ran: { output: T } | undefined;
    let failed: { error: unknown } | undefined;

    const guarded = async (): Promise<T> => {
        try {
            const output = await execute();

            ran = { output };

            return output;
        } catch (error) {
            failed = { error };

            throw error;
        }
    };

    try {
        let output: T;

        try {
            output = await (integration.executeTool === undefined ? guarded() : integration.executeTool({ ...base, execute: guarded, toolCallId: call.id }));
        } catch {
            if (failed !== undefined) {
                throw failed.error;
            }

            // Never ran: running it here is the tool's first and only execution,
            // not a retry. Already ran: the wrapper threw around a success (ending
            // a span, say), so the tool's own outcome stands.
            output = ran === undefined ? await guarded() : ran.output;
        }

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
