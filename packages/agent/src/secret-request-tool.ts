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
 * run on a `awaiting_secret` marker until the owner supplies the value through
 * `agents:agentSupplySecret`, or declines through `agents:agentDeclineSecret`.
 * `execute` is never called: the loop resolves this tool itself.
 *
 * Another tool consumes the value with {@link withSecret}, passing it the
 * `secretRef` the model received. Codegen detects a value import of this name
 * from `@lunora/agent` and wires the secret store; without it the supply
 * mutation refuses. Requires a host that rates `secretValues` as supported.
 *
 * ```ts
 * import { defineAgent, requestSecretTool } from "@lunora/agent";
 *
 * export const billing = defineAgent({
 *     tools: { requestApiKey: requestSecretTool({ description: "Ask the user for their payment-provider API key." }) },
 * });
 * ```
 *
 * The value transits the supply mutation's arguments (named `secret`, which the
 * request log masks). Only the opaque ref is recorded in the run's history.
 * @experimental
 */
const requestSecretTool = (options: { description: string }): AgentToolDefinition<SecretRequestInput, { secretRef: string }> => {
    if (typeof options.description !== "string" || options.description.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: requestSecretTool requires a non-empty `description` (the model decides from it)");
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
        secretRequest: true,
    };
};

/**
 * Read a human-supplied secret inside a tool step, hand it to `use`, and return
 * only what `use` returns. The value never leaves the callback: it is not a step
 * output, not a tool result and not a message. The read is its own durable step
 * named for this call, so a retry of the same step re-takes the value (the claimant
 * is this step's name), while a different call cannot.
 *
 * Call it from inside a tool's `execute`. The discard runs as a separate durable
 * step after `use` succeeds. If `use` keeps failing, the value stays until its TTL
 * expires, which is the backstop for a crash between the take and the discard.
 * `use` must not return, log, or throw the value; `traceToolExecution` records the
 * tool's input and output.
 * @throws {SecretUnavailableError} when the ref is expired, unknown, already bound to another call, or from another thread
 * @experimental
 */
const withSecret = async <Result>(context: AgentToolContext, secretRef: string, use: (secret: string) => Promise<Result> | Result): Promise<Result> => {
    const consumed = await context.step.do(`secret:consume:${context.idempotencyKey}:${secretRef}`, async () => {
        const secret = await context.run(toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.takeSecret), {
            claimant: context.idempotencyKey,
            ref: secretRef,
            threadKey: context.threadKey,
        });

        if (typeof secret !== "string") {
            return { unavailable: true } as const;
        }

        return { result: await use(secret) } as const;
    });

    await context.step.do(`secret:discard:${context.idempotencyKey}:${secretRef}`, async () => {
        await context.run(toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.discardSecret), { ref: secretRef });
    });

    if ("unavailable" in consumed) {
        throw new SecretUnavailableError();
    }

    return consumed.result;
};

export type { SecretRequestInput };
export { requestSecretTool, SecretUnavailableError, withSecret };
