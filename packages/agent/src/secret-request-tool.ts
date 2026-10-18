import { jsonSchema } from "@ai-sdk/provider-utils";
import { LunoraError } from "@lunora/errors";

import { DEFAULT_AGENT_FUNCTION_PATHS, toFunctionReference } from "./paths";
import type { AgentToolContext, AgentToolDefinition } from "./types";

/** The model's input to {@link requestSecretTool}: what the secret is for, shown to the person asked. */
interface SecretRequestInput {
    label: string;
}

/**
 * Thrown by {@link withSecret} when the value is no longer takeable. The loop
 * records it as a deterministic tool failure, so the model can recover rather
 * than the durable step retrying a read that can never succeed.
 */
class SecretUnavailableError extends Error {
    public readonly code = "SECRET_UNAVAILABLE";

    public constructor() {
        super("the secret is no longer available: it expired, was already used by another tool call, or was never supplied");
        this.name = "SecretUnavailableError";
    }
}

/**
 * An agent tool that asks the human for a secret value (an API key, a token) and
 * hands the model only an opaque `{ secretRef }` in return. The loop pauses the
 * run until the owner supplies the value through `agents:agentSupplySecret`, or
 * declines through `agents:agentDeclineSecret`. `execute` is never called: the
 * loop resolves this tool itself.
 *
 * `consumer` names the one tool allowed to read the value. The model can pass the
 * `secretRef` to any tool, but only the declared consumer's {@link withSecret} call
 * takes it, so a prompt-injected model cannot route the value elsewhere.
 *
 * Codegen detects a value import of this name from `@lunora/agent` and wires the
 * secret store; without it the supply mutation refuses. Requires a host that rates
 * `secretValues` as supported.
 *
 * ```ts
 * import { defineAgent, requestSecretTool } from "@lunora/agent";
 *
 * export const billing = defineAgent({
 *     tools: {
 *         requestApiKey: requestSecretTool({
 *             consumer: "chargeCard",
 *             description: "Ask the user for their payment-provider API key.",
 *         }),
 *         chargeCard: functionTool({ ... }), // reads the value with withSecret
 *     },
 * });
 * ```
 *
 * The value transits the supply mutation's arguments, which are marked
 * `v.sensitive`: the request log masks them. The run's history records only the
 * request id.
 * @experimental
 */
const requestSecretTool = (options: { consumer: string; description: string }): AgentToolDefinition<SecretRequestInput, { secretRef: string }> => {
    if (typeof options.description !== "string" || options.description.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: requestSecretTool requires a non-empty `description` (the model decides from it)");
    }

    if (typeof options.consumer !== "string" || options.consumer.length === 0) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/agent: requestSecretTool requires a non-empty `consumer`: the name of the one tool allowed to read the value",
        );
    }

    return {
        description: options.description,
        execute: () => {
            throw new LunoraError("INTERNAL", "@lunora/agent: requestSecretTool is resolved by the loop and must never be executed");
        },
        inputSchema: jsonSchema<SecretRequestInput>({
            properties: { label: { description: "What the secret is for, shown to the person asked.", type: "string" } },
            required: ["label"],
            type: "object",
        }),
        isLunoraAgentTool: true,
        secretRequest: { consumer: options.consumer },
    };
};

/**
 * Whether a value's serialized form carries the secret, including the JSON-escaped
 * spelling of it (a quote or backslash in the secret is escaped inside a string).
 * A value that cannot be serialized cannot be persisted as a step output either,
 * so it is not treated as a leak.
 */
const containsSecret = (value: unknown, secret: string): boolean => {
    // These have no JSON form at all, so they cannot be journalled as a step output either.
    if (secret.length === 0 || value === undefined || typeof value === "function" || typeof value === "symbol") {
        return false;
    }

    let serialized: string;

    try {
        serialized = JSON.stringify(value);
    } catch {
        return false;
    }

    return serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1));
};

/** What a redacted secret reads as in a message the caller, telemetry or the journal sees. */
const REDACTED = "[redacted]";

/** Replace the secret in `text`, both raw and JSON-escaped, the spelling a serialized copy carries. */
const redactText = (text: string, secret: string): string => {
    // An empty secret is in every string, so there is nothing that can be replaced.
    if (secret.length === 0) {
        return text;
    }

    return text.split(secret).join(REDACTED).split(JSON.stringify(secret).slice(1, -1)).join(REDACTED);
};

/**
 * Scrub the secret from a callback's error in place, so the error the step and the loop
 * see is safe. Mutated rather than copied, so its class, `code`, `status` and dispatch
 * brand still decide whether the step retries it or the loop records it as a
 * deterministic failure. A non-error throw is replaced outright, since it cannot be
 * checked for the secret without running its own `toString`.
 */
const redactCallbackError = (error: unknown, secret: string, seen: Set<unknown> = new Set()): unknown => {
    if (!(error instanceof Error)) {
        return new LunoraError("INTERNAL", "@lunora/agent: withSecret's callback threw a value that is withheld, in case it carries the secret");
    }

    if (seen.has(error)) {
        return error;
    }

    seen.add(error);

    // In place on purpose: a copy would lose the class and brand that classify the error.
    // eslint-disable-next-line no-param-reassign -- the error is rewritten in place, see above
    error.message = redactText(error.message, secret);

    if (typeof error.stack === "string") {
        // eslint-disable-next-line no-param-reassign -- the error is rewritten in place, see above
        error.stack = redactText(error.stack, secret);
    }

    const fields = error as unknown as Record<string, unknown>;

    for (const key of Object.getOwnPropertyNames(error)) {
        if (key === "message" || key === "stack") {
            continue;
        }

        const value = fields[key];

        if (value instanceof Error) {
            redactCallbackError(value, secret, seen);
        } else if (containsSecret(value, secret)) {
            fields[key] = JSON.parse(redactText(JSON.stringify(value), secret));
        }
    }

    return error;
};

/**
 * Read a human-supplied secret inside the tool that the request declared as its
 * `consumer`, hand it to `use`, and return only what `use` returns. The value never
 * leaves the callback: it is not a step output, not a tool result and not a message.
 * The read is its own durable step named for this call, so a retry of the same step
 * re-takes the value (the claimant is this step's name), while a different call
 * cannot.
 *
 * Call it from inside a tool's `execute`. The discard runs as a separate durable step
 * only after the take succeeded and `use` returned, so a call that is refused (the
 * wrong tool, another thread, an expired request) cannot burn a value the declared
 * consumer still needs. If `use` keeps failing, the value stays until its TTL expires,
 * which is the backstop for a crash between the take and the discard. `use` must not
 * return or log the value. A result that carries it is refused (the call fails with
 * `LunoraError`) rather than journalled. An error that carries it is redacted before
 * it propagates, so the step's retry, the failure the loop records and telemetry never
 * see the value; `traceToolExecution` records the tool's input and output.
 * @throws {SecretUnavailableError} when the request is unknown, not supplied, declared for another consumer, or from another thread
 * @experimental
 */
const withSecret = async <Result>(context: AgentToolContext, secretRef: string, use: (secret: string) => Promise<Result> | Result): Promise<Result> => {
    const consumed = await context.step.do(`secret:consume:${context.idempotencyKey}:${secretRef}`, async () => {
        const secret = await context.run(toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.takeSecret), {
            claimant: context.idempotencyKey,
            consumerCallId: context.toolCallId,
            instanceId: context.instanceId,
            threadKey: context.threadKey,
            toolCallId: secretRef,
        });

        if (typeof secret !== "string") {
            return { unavailable: true } as const;
        }

        let result: Result;

        try {
            result = await use(secret);
        } catch (error: unknown) {
            // The step retries this error and the loop records its message, so the value must not survive into either.
            throw redactCallbackError(error, secret);
        }

        // The step's return value is what the durable journal keeps. A callback that
        // returns the credential (an echoed token, a signed header) would write it
        // there, so the result is withheld and the call fails instead.
        if (containsSecret(result, secret)) {
            return { leaked: true } as const;
        }

        return { result } as const;
    });

    if ("unavailable" in consumed) {
        throw new SecretUnavailableError();
    }

    await context.step.do(`secret:discard:${context.idempotencyKey}:${secretRef}`, async () => {
        await context.run(toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.discardSecret), {
            instanceId: context.instanceId,
            threadKey: context.threadKey,
            toolCallId: secretRef,
        });
    });

    if ("leaked" in consumed) {
        throw new LunoraError("INTERNAL", "@lunora/agent: withSecret's callback returned the secret, so its result was not recorded");
    }

    return consumed.result;
};

export type { SecretRequestInput };
export { requestSecretTool, SecretUnavailableError, withSecret };
