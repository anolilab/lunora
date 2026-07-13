import type { Telemetry } from "ai";
import { describe, expect, it, vi } from "vitest";

import { combineTelemetry } from "../../src/telemetry/combine";

/**
 * The ai@7 `Telemetry` event shapes are broad and churn across patch releases;
 * these tests intentionally pass minimal fixtures to exercise the fan-out and
 * isolation behaviour. `evt` widens a fixture to the callback's event type
 * without fabricating (and then having to maintain) every unrelated field.
 */
const evt = (fixture: Record<string, unknown>): never => fixture as unknown as never;

/** A tool-execution wrapper that brackets `execute` with named markers. */
const bracketTool = (order: string[], label: string): Telemetry => {
    return {
        executeTool: async (options) => {
            order.push(`${label}-before`);

            const result = await options.execute();

            order.push(`${label}-after`);

            return result;
        },
    };
};

describe(combineTelemetry, () => {
    it("fans a value callback out to every integration", async () => {
        const a = vi.fn();
        const b = vi.fn();
        const combined = combineTelemetry({ onStepEnd: a }, { onStepEnd: b });

        const event = evt({ finishReason: "stop", stepNumber: 1 });

        await combined.onStepEnd?.(event);

        expect(a).toHaveBeenCalledWith(event);
        expect(b).toHaveBeenCalledWith(event);
    });

    it("wires the deprecated-alias and object-generation value callbacks", async () => {
        const onStepFinish = vi.fn();
        const onObjectStepStart = vi.fn();
        const onObjectStepEnd = vi.fn();
        const combined = combineTelemetry({ onObjectStepEnd, onObjectStepStart, onStepFinish });

        const event = evt({ stepNumber: 0 });

        await combined.onStepFinish?.(event);
        await combined.onObjectStepStart?.(event);
        await combined.onObjectStepEnd?.(event);

        expect(onStepFinish).toHaveBeenCalledWith(event);
        expect(onObjectStepStart).toHaveBeenCalledWith(event);
        expect(onObjectStepEnd).toHaveBeenCalledWith(event);
    });

    it("isolates a synchronously-throwing integration from its siblings", async () => {
        const sibling = vi.fn();
        const buggy: Telemetry = {
            onError: () => {
                throw new Error("boom");
            },
        };
        const combined = combineTelemetry(buggy, { onError: sibling });

        // The combined value callback must not throw/reject even when one
        // integration throws synchronously…
        await expect(combined.onError?.("evt")).resolves.toBeUndefined();
        // …and the sibling must still be invoked.
        expect(sibling).toHaveBeenCalledWith("evt");
    });

    it("isolates a rejecting integration from its siblings", async () => {
        const sibling = vi.fn();
        const buggy: Telemetry = {
            onStepEnd: () => Promise.reject(new Error("boom")),
        };
        const combined = combineTelemetry(buggy, { onStepEnd: sibling });

        await expect(combined.onStepEnd?.(evt({ stepNumber: 1 }))).resolves.toBeUndefined();
        expect(sibling).toHaveBeenCalledTimes(1);
    });

    it("awaits async callbacks across all integrations (Promise.allSettled)", async () => {
        const seen: string[] = [];
        const slow: Telemetry = {
            onError: async (error) => {
                await Promise.resolve();
                seen.push(`slow:${String(error)}`);
            },
        };
        const fast: Telemetry = {
            onError: (error) => {
                seen.push(`fast:${String(error)}`);
            },
        };

        await combineTelemetry(slow, fast).onError?.("boom");

        expect(seen).toContain("slow:boom");
        expect(seen).toContain("fast:boom");
    });

    it("skips integrations that do not define a given callback", async () => {
        const onlyB = vi.fn();

        // First integration has no onStepEnd; must not throw when fanning out.
        const combined = combineTelemetry({}, { onStepEnd: onlyB });

        await expect(combined.onStepEnd?.(evt({ stepNumber: 0 }))).resolves.toBeUndefined();
        expect(onlyB).toHaveBeenCalledTimes(1);
    });

    it("nests execution wrappers right-to-left (first integration outermost)", async () => {
        const order: string[] = [];
        const combined = combineTelemetry(bracketTool(order, "A"), bracketTool(order, "B"));

        const result = await combined.executeTool?.({
            callId: "call-1",
            execute: () => {
                order.push("run");

                return Promise.resolve("tool-result");
            },
            toolCallId: "tc-1",
        });

        expect(order).toStrictEqual(["A-before", "B-before", "run", "B-after", "A-after"]);
        expect(result).toBe("tool-result");
    });

    it("runs the plain execute when no integration defines the wrapper", async () => {
        let ran = false;
        const combined = combineTelemetry({}, {});

        const result = await combined.executeTool?.({
            callId: "call-1",
            execute: () => {
                ran = true;

                return Promise.resolve("plain");
            },
            toolCallId: "tc-1",
        });

        expect(ran).toBe(true);
        expect(result).toBe("plain");
    });

    it("still nests the single defined wrapper when others omit it", async () => {
        const order: string[] = [];
        const combined = combineTelemetry({}, bracketTool(order, "only"), {});

        const result = await combined.executeTool?.({
            callId: "call-1",
            execute: () => {
                order.push("run");

                return Promise.resolve("v");
            },
            toolCallId: "tc-1",
        });

        expect(order).toStrictEqual(["only-before", "run", "only-after"]);
        expect(result).toBe("v");
    });

    it("composes the language-model wrapper the same way", async () => {
        const order: string[] = [];
        const wrap = (label: string): Telemetry => {
            return {
                executeLanguageModelCall: async (options) => {
                    order.push(`${label}-before`);

                    const result = await options.execute();

                    order.push(`${label}-after`);

                    return result;
                },
            };
        };

        const combined = combineTelemetry(wrap("A"), wrap("B"));

        await combined.executeLanguageModelCall?.({
            callId: "call-1",
            execute: () => {
                order.push("run");

                return Promise.resolve("text");
            },
        });

        expect(order).toStrictEqual(["A-before", "B-before", "run", "B-after", "A-after"]);
    });
});
