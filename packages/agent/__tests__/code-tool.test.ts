import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { codeTool, resolveReferences, runToolScript } from "../src/code-tool";
import type { AgentToolContext, AgentToolDefinition, AnyAgentTool } from "../src/types";
import { DurableStepJournal, passthroughStep } from "./loop-harness";

const UNKNOWN_REF_PATTERN = /unknown result "missing"/u;
const UNKNOWN_TOOL_PATTERN = /unknown tool "nope"/u;
const EMPTY_TOOLS_PATTERN = /non-empty map of tools/u;
const GATED_TOOL_PATTERN = /cannot compose "gated"/u;
const DUPLICATE_ID_PATTERN = /duplicate code step id "dup"/u;
const BOOM_PATTERN = /boom/u;
const MAX_STEPS_PATTERN = /`maxSteps` must be a positive integer/u;
const TOO_MANY_STEPS_PATTERN = /code_tool_too_many_steps — the script has 10 steps, over the cap of 3/u;
const INVALID_STEP_INPUT_PATTERN = /code step "a" input is invalid for tool "charge": amount must be a number/u;
const INHERITED_REF_PATTERNS = [/unknown result "constructor"/u, /unknown result "__proto__"/u, /unknown result "hasOwnProperty"/u];

// `step` is required on AgentToolContext — production always threads a real
// durable handle — so a hand-built context supplies the pass-through double.
const context = { step: passthroughStep } as AgentToolContext;

/** A fake tool that records the input it was called with and returns `output`. */
const fakeTool = (output: unknown, calls: unknown[] = []): AgentToolDefinition => {
    return {
        description: "fake",
        execute: (input) => {
            calls.push(input);

            return output;
        },
        inputSchema: jsonSchema({ additionalProperties: true, type: "object" }),
        isLunoraAgentTool: true,
    };
};

describe(resolveReferences, () => {
    it("passes non-ref values through and recurses into objects/arrays", () => {
        expect(resolveReferences({ a: 1, b: [2, "x"] }, {})).toStrictEqual({ a: 1, b: [2, "x"] });
    });

    it("resolves a `$from` to a full earlier result and `$path` to a nested field", () => {
        const results = { user: { id: "u1", profile: { city: "Berlin" } } };

        expect(resolveReferences({ $from: "user" }, results)).toStrictEqual({ id: "u1", profile: { city: "Berlin" } });
        expect(resolveReferences({ who: { $from: "user", $path: "id" }, where: { $from: "user", $path: "profile.city" } }, results)).toStrictEqual({
            where: "Berlin",
            who: "u1",
        });
    });

    it("throws on an unknown `$from` reference", () => {
        expect(() => resolveReferences({ $from: "missing" }, {})).toThrow(UNKNOWN_REF_PATTERN);
    });

    it("does not resolve a `$path` onto the prototype chain", () => {
        const resolved = resolveReferences({ x: { $from: "u", $path: "__proto__" }, y: { $from: "u", $path: "constructor" } }, { u: { a: 1 } }) as {
            x: unknown;
            y: unknown;
        };

        expect(resolved.x).toBeUndefined();
        expect(resolved.y).toBeUndefined();
    });

    it("does not resolve a `$from` onto the prototype chain", () => {
        // `"constructor" in {}` is true, so an inherited name resolved to a real
        // `Function`/`Object.prototype` and was handed to the composed tool as an
        // argument — instead of the documented hard error for an unknown ref.
        for (const [index, name] of ["constructor", "__proto__", "hasOwnProperty"].entries()) {
            expect(() => resolveReferences({ $from: name }, {})).toThrow(INHERITED_REF_PATTERNS[index]);
        }
    });

    it("skips a `__proto__` own key when rebuilding input objects", () => {
        const input = JSON.parse(String.raw`{"__proto__": {"isAdmin": true}, "a": 1}`) as Record<string, unknown>;
        const resolved = resolveReferences(input, {}) as Record<string, unknown>;

        expect(Object.keys(resolved)).toStrictEqual(["a"]);
        expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
        expect(resolved.isAdmin).toBeUndefined();
    });

    it("keeps `constructor`/`prototype` — they are ordinary own keys, and dropping them would lose a real tool argument", () => {
        // Neither name is a setter on a plain object literal, so assigning them
        // pollutes nothing; a tool whose input genuinely has a `constructor`
        // field must still receive it.
        const resolved = resolveReferences({ constructor: { c: 1 }, prototype: { p: 1 } }, {}) as Record<string, unknown>;

        expect(Object.keys(resolved).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["constructor", "prototype"]);
        expect(resolved.constructor).toStrictEqual({ c: 1 });
        expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    });
});

describe(runToolScript, () => {
    it("runs steps in order, flowing an earlier output into a later input", async () => {
        const ordersCalls: unknown[] = [];
        const tools: Record<string, AnyAgentTool> = {
            lookup: fakeTool({ id: "u1", name: "Alice" }),
            orders: fakeTool(["o1", "o2"], ordersCalls),
        };

        const result = await runToolScript(
            {
                steps: [
                    { id: "u", input: { email: "a@b.c" }, tool: "lookup" },
                    { id: "o", input: { userId: { $from: "u", $path: "id" } }, tool: "orders" },
                ],
            },
            tools,
            context,
            16,
        );

        // The second step received the first step's resolved output.
        expect(ordersCalls).toStrictEqual([{ userId: "u1" }]);
        expect(result.results).toStrictEqual([
            { id: "u", output: { id: "u1", name: "Alice" } },
            { id: "o", output: ["o1", "o2"] },
        ]);
        expect(result.final).toStrictEqual(["o1", "o2"]);
    });

    it("throws on a step calling an unknown tool", async () => {
        await expect(runToolScript({ steps: [{ id: "x", tool: "nope" }] }, { real: fakeTool(1) }, context, 16)).rejects.toThrow(UNKNOWN_TOOL_PATTERN);
    });

    it("throws on a step naming an inherited property instead of a composed tool", async () => {
        // `tools["constructor"]` is `Object` — truthy, so the unknown-tool guard
        // waved it through and the step died on `tool.execute is not a function`
        // (a TypeError the host retries) rather than the documented BAD_REQUEST.
        for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
            // eslint-disable-next-line no-await-in-loop -- each name is its own assertion; the loop is the fixture
            await expect(runToolScript({ steps: [{ id: "x", tool: name }] }, { real: fakeTool(1) }, context, 16)).rejects.toThrow(
                new RegExp(`unknown tool "${name === "__proto__" ? String.raw`__proto__` : name}"`, "u"),
            );
        }
    });

    it("rejects duplicate step ids up front, before running any tool", async () => {
        const calls: unknown[] = [];
        const tools = { t: fakeTool("ok", calls) };

        await expect(
            runToolScript(
                {
                    steps: [
                        { id: "dup", tool: "t" },
                        { id: "dup", tool: "t" },
                    ],
                },
                tools,
                context,
                16,
            ),
        ).rejects.toThrow(DUPLICATE_ID_PATTERN);
        // Fail-fast: neither step executed (no partial side effects).
        expect(calls).toStrictEqual([]);
    });

    it("caps a large step output in the returned results while the full value still flows to refs", async () => {
        const big = "z".repeat(5000);
        let echoInput: unknown;
        const echo: AgentToolDefinition = {
            description: "echo",
            execute: (input) => {
                echoInput = input;

                return "done";
            },
            inputSchema: jsonSchema({ additionalProperties: true, type: "object" }),
            isLunoraAgentTool: true,
        };

        const result = await runToolScript(
            {
                steps: [
                    { id: "b", tool: "big" },
                    { id: "e", input: { data: { $from: "b" } }, tool: "echo" },
                ],
            },
            { big: fakeTool(big), echo },
            context,
            16,
        );

        // The returned result for step "b" is truncated…
        expect((result.results[0]?.output as string).endsWith("… [truncated]")).toBe(true);
        // …but the FULL value flowed into step "e" via `$from`.
        expect((echoInput as { data: string }).data).toBe(big);
    });

    it("rejects a script over `maxSteps` instead of running its prefix", async () => {
        const calls: unknown[] = [];
        const tools = { t: fakeTool("ok", calls) };
        const steps = Array.from({ length: 10 }, (_, index) => {
            return { id: `s${String(index)}`, tool: "t" };
        });

        // Truncating ran the first 3 steps and reported SUCCESS, silently dropping
        // the trailing 7 — typically the writes the earlier reads were gathered for.
        await expect(runToolScript({ steps }, tools, context, 3)).rejects.toThrow(TOO_MANY_STEPS_PATTERN);
        expect(calls).toHaveLength(0);
    });

    it("validates a step's resolved input against the composed tool's own inputSchema", async () => {
        const calls: unknown[] = [];
        const tools = {
            charge: {
                description: "charge",
                execute: (input: unknown) => {
                    calls.push(input);

                    return "ok";
                },
                inputSchema: jsonSchema<{ amount: number }>(
                    { additionalProperties: false, properties: { amount: { type: "number" } }, required: ["amount"], type: "object" },
                    {
                        validate: (value) => {
                            if (typeof (value as { amount?: unknown }).amount === "number") {
                                return { success: true, value: value as { amount: number } };
                            }

                            return { error: new Error("amount must be a number"), success: false };
                        },
                    },
                ),
                isLunoraAgentTool: true,
            } as AnyAgentTool,
        };

        // The model-facing step schema is `additionalProperties: true`, so nothing in
        // the script shape can reject this — only the composed tool's own schema can,
        // and until now nothing consulted it between `resolveReferences` and `execute`.
        await expect(
            runToolScript({ steps: [{ id: "a", input: { amount: "NaN-string", drop_table: true }, tool: "charge" }] }, tools, context, 4),
        ).rejects.toThrow(INVALID_STEP_INPUT_PATTERN);
        expect(calls).toStrictEqual([]);
    });

    it("gives each step its own idempotency key / tool-call id derived from the code tool's", async () => {
        const seen: { idempotencyKey: string; toolCallId: string }[] = [];
        const tool: AgentToolDefinition = {
            description: "t",
            execute: (_input, ctx) => {
                seen.push({ idempotencyKey: ctx.idempotencyKey, toolCallId: ctx.toolCallId });

                return "ok";
            },
            inputSchema: jsonSchema({ additionalProperties: true, type: "object" }),
            isLunoraAgentTool: true,
        };
        const baseContext = { idempotencyKey: "tool:code:call_1", step: passthroughStep, toolCallId: "call_1" } as AgentToolContext;

        await runToolScript(
            {
                steps: [
                    { id: "a", tool: "t" },
                    { id: "b", tool: "t" },
                ],
            },
            { t: tool },
            baseContext,
            16,
        );

        expect(seen).toStrictEqual([
            { idempotencyKey: "tool:code:call_1:a", toolCallId: "call_1:a" },
            { idempotencyKey: "tool:code:call_1:b", toolCallId: "call_1:b" },
        ]);
    });

    it("gives each script step its own durable boundary: a mid-script failure retries only the failed step, not steps already committed", async () => {
        // A faithful in-memory model of Cloudflare Workflows' step.do memoization
        // (shared with agent-loop.test.ts via loop-harness) — reusing the SAME
        // journal across two `runToolScript` calls models a crash + resume of the
        // same workflow instance.
        const journal = new DurableStepJournal();
        const callsA: unknown[] = [];
        const callsB: unknown[] = [];
        let cAttempts = 0;

        const failsOnce: AgentToolDefinition = {
            description: "c",
            execute: () => {
                cAttempts += 1;

                if (cAttempts === 1) {
                    throw new Error("boom");
                }

                return "c-ok";
            },
            inputSchema: jsonSchema({ additionalProperties: true, type: "object" }),
            isLunoraAgentTool: true,
        };

        const tools: Record<string, AnyAgentTool> = { a: fakeTool("a-ok", callsA), b: fakeTool("b-ok", callsB), c: failsOnce };
        const script = {
            steps: [
                { id: "a", tool: "a" },
                { id: "b", tool: "b" },
                { id: "c", tool: "c" },
            ],
        };
        const replayContext = { idempotencyKey: "tool:code:call_1", step: journal, toolCallId: "call_1" } as unknown as AgentToolContext;

        // First attempt: step "c" throws — the whole script call rejects.
        await expect(runToolScript(script, tools, replayContext, 16)).rejects.toThrow(BOOM_PATTERN);

        expect(callsA).toHaveLength(1);
        expect(callsB).toHaveLength(1);
        expect(cAttempts).toBe(1);

        // Retry on the SAME journal (a workflow replay after the failure): "a"
        // and "b"'s nested steps are memoized and are NOT re-run — only "c" (the
        // step that failed mid-body) retries, at-least-once.
        const result = await runToolScript(script, tools, replayContext, 16);

        expect(callsA).toHaveLength(1);
        expect(callsB).toHaveLength(1);
        expect(cAttempts).toBe(2);
        expect(result.final).toBe("c-ok");
    });

    it("still resolves $from references across steps when each step runs inside its own nested step.do", async () => {
        const ordersCalls: unknown[] = [];
        const tools: Record<string, AnyAgentTool> = {
            lookup: fakeTool({ id: "u1", name: "Alice" }),
            orders: fakeTool(["o1", "o2"], ordersCalls),
        };
        const stepContext = { idempotencyKey: "tool:code:call_1", step: new DurableStepJournal(), toolCallId: "call_1" } as unknown as AgentToolContext;

        const result = await runToolScript(
            {
                steps: [
                    { id: "u", input: { email: "a@b.c" }, tool: "lookup" },
                    { id: "o", input: { userId: { $from: "u", $path: "id" } }, tool: "orders" },
                ],
            },
            tools,
            stepContext,
            16,
        );

        // The nested durable boundary doesn't break sequencing: the second step
        // still receives the first step's resolved output.
        expect(ordersCalls).toStrictEqual([{ userId: "u1" }]);
        expect(result.final).toStrictEqual(["o1", "o2"]);
    });
});

describe(codeTool, () => {
    it("mints a tool whose execute runs the script and whose description lists the tools", async () => {
        const tool = codeTool({ search: fakeTool(["hit"]) });

        expect(tool.isLunoraAgentTool).toBe(true);
        expect(tool.description).toContain('"search"');

        const result = (await tool.execute({ steps: [{ id: "s", input: { q: "x" }, tool: "search" }] }, context)) as { final: unknown };

        expect(result.final).toStrictEqual(["hit"]);
    });

    it("throws without any tools to compose", () => {
        expect(() => codeTool({})).toThrow(EMPTY_TOOLS_PATTERN);
    });

    it("rejects composing an approval-gated tool (a script can't pause for HITL)", () => {
        const gated: AgentToolDefinition = { ...fakeTool("x"), needsApproval: true };

        expect(() => codeTool({ gated })).toThrow(GATED_TOOL_PATTERN);
    });

    it.each([0, -1, 0.5, Number.NaN])("rejects a non-positive-integer maxSteps at declaration time (%s)", (maxSteps) => {
        // `slice(0, maxSteps)` swallowed these silently: `0`/`0.5`/`NaN` ran NO
        // step and still reported success, `-1` dropped the LAST step — a script
        // that looks like it committed its final side effect and did not.
        expect(() => codeTool({ search: fakeTool(["hit"]) }, { maxSteps })).toThrow(MAX_STEPS_PATTERN);
    });

    it("keeps running every step under a valid maxSteps", async () => {
        const calls: unknown[] = [];
        const tool = codeTool({ search: fakeTool("hit", calls) }, { maxSteps: 2 });

        await tool.execute(
            {
                steps: [
                    { id: "a", tool: "search" },
                    { id: "b", tool: "search" },
                ],
            },
            context,
        );

        expect(calls).toHaveLength(2);
    });
});
