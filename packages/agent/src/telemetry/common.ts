/**
 * Privacy options shared by every telemetry integration in this package.
 *
 * Both flags default to **FALSE**. Without an explicit opt-in, no prompt,
 * message, tool input, generated model text, or tool output is ever forwarded
 * to a downstream tracer — only structural metadata (model id, finish reason,
 * token counts, tool name, timing, success/failure) is recorded. This is the
 * privacy-safe default: turn recording on deliberately, per integration.
 * @experimental
 */
export interface CommonOptions {
    /**
     * When `true`, record model/tool **input** — prompts, messages, and tool
     * call arguments. Default `false`.
     */
    recordInputs?: boolean;

    /**
     * When `true`, record model/tool **output** — generated text and tool
     * results. Default `false`.
     */
    recordOutputs?: boolean;
}

/**
 * Defensive property read. The AI SDK telemetry events are `readonly`
 * discriminated unions whose members diverge (an `onEnd` event has no
 * `operationId`, an embed event has no `toolCall`, …), and a malformed runtime
 * payload may omit fields the type claims are present. Reading through this
 * helper never throws and never trips the `no-unsafe-*` lint rules: it returns
 * `unknown`, which callers route into a structured fields record or narrow
 * before use.
 */
export const readField = (source: unknown, key: string): unknown => {
    if (source === null || typeof source !== "object") {
        return undefined;
    }

    return (source as Record<string, unknown>)[key];
};

/**
 * Project a raw AI SDK `LanguageModelUsage`-shaped value onto a compact,
 * defined-only token summary. Missing or non-numeric fields are dropped;
 * returns `undefined` when nothing usable is present.
 */
export const summarizeUsage = (usage: unknown): Record<string, number> | undefined => {
    const summary: Record<string, number> = {};

    for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
        const value = readField(usage, key);

        if (typeof value === "number") {
            summary[key] = value;
        }
    }

    return Object.keys(summary).length > 0 ? summary : undefined;
};

/**
 * Cloudflare AI Gateway telemetry, projected off a language-model call result.
 * Every field is optional — the gateway only runs when routing is configured, so
 * a direct-provider call yields `undefined` and no gateway attribute is emitted.
 */
export interface GatewayTelemetry {
    /** Whether the gateway served this response from cache. */
    cached?: boolean;
    /** The gateway-computed request cost, in USD. */
    cost?: number;
    /** The gateway log id for this request (`cf-aig-log-id`). */
    logId?: string;
}

/**
 * Extract Cloudflare AI Gateway telemetry (cost, cache status, log id) from a
 * language-model call result. Reads two additive, defensively-probed locations
 * so it survives AI SDK shape churn: the provider-metadata `gateway` namespace
 * (`result.providerMetadata.gateway`) and the gateway's `cf-aig-*` response
 * headers (`result.response.headers`). Returns `undefined` when the gateway did
 * not run (nothing to attach), keeping the span attributes purely additive.
 */
export const summarizeGatewayTelemetry = (result: unknown): GatewayTelemetry | undefined => {
    const gateway = readField(readField(result, "providerMetadata"), "gateway");
    const headers = readField(readField(result, "response"), "headers");

    // Read a header by name from a `Headers` instance (case-insensitive `.get`)
    // or a plain record (proxied response headers keyed by the lowercased name).
    const readHeader = (name: string): string | undefined => {
        const getter = readField(headers, "get");
        const value = typeof getter === "function" ? (getter as (key: string) => unknown).call(headers, name) : readField(headers, name);

        return typeof value === "string" && value.length > 0 ? value : undefined;
    };

    const summary: GatewayTelemetry = {};

    const cost = readField(gateway, "cost");

    if (typeof cost === "number" && Number.isFinite(cost)) {
        summary.cost = cost;
    }

    const cachedField = readField(gateway, "cached");
    const cacheStatusField = readField(gateway, "cacheStatus");
    const cacheStatus = typeof cacheStatusField === "string" ? cacheStatusField : readHeader("cf-aig-cache-status");

    if (typeof cachedField === "boolean") {
        summary.cached = cachedField;
    } else if (typeof cacheStatus === "string") {
        summary.cached = cacheStatus.toUpperCase() === "HIT";
    }

    const metadataLogId = readField(gateway, "logId") ?? readField(gateway, "log_id");
    const logId = typeof metadataLogId === "string" && metadataLogId.length > 0 ? metadataLogId : readHeader("cf-aig-log-id");

    if (typeof logId === "string" && logId.length > 0) {
        summary.logId = logId;
    }

    return Object.keys(summary).length > 0 ? summary : undefined;
};

/** The outcome of a tool execution, normalized from the end-event union. */
export interface ToolOutcome {
    /** The error value (defined only when `success` is `false`). */
    error: unknown;
    /** The tool name, when discoverable on the event. */
    name: string | undefined;
    /** The tool output value (defined only when `success` is `true`). */
    output: unknown;
    /** Whether the tool executed successfully. */
    success: boolean;
    /** Wall-clock execution time in milliseconds, when reported. */
    toolExecutionMs: number | undefined;
}

/**
 * Normalize a `ToolExecutionEndEvent` onto a stable {@link ToolOutcome}.
 *
 * The ai@7 end event discriminates on `toolOutput.type` (`"tool-result"` vs
 * `"tool-error"`); some runtimes/versions surface a boolean `success` field
 * instead. This reads both defensively (the boolean wins when present) so the
 * outcome is correct across shapes, and pulls `output`/`error` from whichever
 * discriminant applies.
 */
export const describeToolOutcome = (event: unknown): ToolOutcome => {
    const toolCall = readField(event, "toolCall");
    const nameValue = readField(toolCall, "toolName");
    const name = typeof nameValue === "string" ? nameValue : undefined;

    const toolOutput = readField(event, "toolOutput");
    const outputType = readField(toolOutput, "type");

    const successField = readField(event, "success");
    const success = typeof successField === "boolean" ? successField : outputType !== "tool-error";

    const executionMs = readField(event, "toolExecutionMs");

    return {
        error: success ? undefined : (readField(toolOutput, "error") ?? readField(event, "error")),
        name,
        output: success ? readField(toolOutput, "output") : undefined,
        success,
        toolExecutionMs: typeof executionMs === "number" ? executionMs : undefined,
    };
};

/**
 * Extract the tool name from a tool **start** event (`toolCall.toolName`),
 * falling back to `undefined` when absent.
 */
export const toolNameOf = (event: unknown): string | undefined => {
    const nameValue = readField(readField(event, "toolCall"), "toolName");

    return typeof nameValue === "string" ? nameValue : undefined;
};

/**
 * Extract the tool input (`toolCall.input`) from a tool start/end event. Only
 * ever forwarded when the caller has opted into input recording.
 */
export const toolInputOf = (event: unknown): unknown => readField(readField(event, "toolCall"), "input");

/**
 * Concatenate the text of a model-call `content` array (the `type: "text"`
 * parts). Returns `undefined` when there is no textual content. Only ever
 * forwarded when the caller has opted into output recording.
 */
export const contentText = (content: unknown): string | undefined => {
    if (!Array.isArray(content)) {
        return undefined;
    }

    let text = "";

    for (const part of content) {
        if (readField(part, "type") === "text") {
            const value = readField(part, "text");

            if (typeof value === "string") {
                text += value;
            }
        }
    }

    return text.length > 0 ? text : undefined;
};

/** Normalize an unknown thrown value into a compact log-friendly shape. */
export const describeError = (error: unknown): unknown => {
    if (error instanceof Error) {
        return { message: error.message, name: error.name };
    }

    return error;
};
