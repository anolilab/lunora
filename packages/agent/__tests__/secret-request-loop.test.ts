import { createReferenceHost } from "@lunora/platform/conformance";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { agentComponent } from "../src/component";
import { defineAgent, defineAgentTool } from "../src/define-agent";
import { requestSecretTool, SecretUnavailableError, withSecret } from "../src/secret-request-tool";
import type { AgentDefinition, AgentStepLike, AgentToolContext } from "../src/types";
import { finalTurn, loopDefaults, memoryRuntime, scriptedGenerate, toolTurn } from "./loop-harness";

const SECRET = "sk_live_correct-horse-battery-staple";
const SECRET_WORKS = "charged";
const WORKFLOW_TIMEOUT = "WorkflowTimeoutError";
const TOOL_FAILED_PATTERN = /failed and will not be retried\. the secret is no longer available/u;

/**
 * Durable-step double for the secret wait: a pre-delivered event resolves the
 * wait, an undelivered one hibernates (the promise never settles, as Cloudflare
 * freezes the instance), and `timeoutWaits` makes a named wait fail the way an
 * elapsed host timeout does. Records every wait's options and resolved payload.
 */
class WaitJournal implements AgentStepLike {
    public readonly invoked: string[] = [];

    public readonly payloads = new Map<string, unknown>();

    public readonly events = new Map<string, unknown>();

    public readonly timeoutWaits = new Set<string>();

    public readonly waitOptions = new Map<string, { timeout?: number | string; type: string }>();

    public readonly waitedNames: string[] = [];

    private readonly entries = new Map<string, { output: unknown }>();

    public async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const existing = this.entries.get(name);

        if (existing) {
            return existing.output as T;
        }

        this.invoked.push(name);

        const output = await callback();

        this.entries.set(name, { output });

        return output;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- mirrors AgentStepLike.waitForEvent's generic host signature
    public async waitForEvent<T>(name: string, options: { timeout?: number | string; type: string }): Promise<{ payload: T; type: string }> {
        this.waitOptions.set(name, options);

        if (this.timeoutWaits.has(name)) {
            const error = new Error("Execution timed out");

            error.name = WORKFLOW_TIMEOUT;

            throw error;
        }

        if (!this.events.has(name)) {
            this.waitedNames.push(name);

            return new Promise<{ payload: T; type: string }>(() => {});
        }

        const payload = this.events.get(name);

        this.payloads.set(name, payload);

        return { payload: payload as T, type: options.type };
    }

    /** Every memoized step output, as the durable journal would persist it. */
    public persisted(): string {
        return JSON.stringify([...this.entries.values()].map((entry) => entry.output));
    }
}

const flushMicrotasks = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
};

/** The secret store the runtime's take/discard dispatches reach, through the real component mutations. */
const secretHost = () => {
    const host = createReferenceHost();

    if (host.secretValues === undefined || host.advanceClock === undefined) {
        throw new Error("the reference host must expose its secret store and clock");
    }

    const { functions } = agentComponent();
    const context = { agentSecrets: host.secretValues };
    const dispatch = (fn: unknown) => (args?: Record<string, unknown>) =>
        (fn as { handler: (c: unknown, a: never) => unknown }).handler(context, args as never);

    return {
        advanceClock: host.advanceClock,
        discard: dispatch(functions.agentDiscardSecret),
        host: { secretValues: host.secretValues },
        take: dispatch(functions.agentTakeSecret),
    };
};

const secretAgent = (used: string[]): AgentDefinition =>
    defineAgent({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        tools: {
            charge: defineAgentTool({
                description: "Charge the card with a stored key.",
                execute: (input, context) =>
                    withSecret(context, (input as { secretRef: string }).secretRef, (secret) => {
                        used.push(secret);

                        return SECRET_WORKS;
                    }),
                inputSchema: jsonSchema({ properties: { secretRef: { type: "string" } }, required: ["secretRef"], type: "object" }) as never,
            }),
            requestKey: requestSecretTool({ description: "Ask the user for their payment API key." }),
        },
    });

/** Run the paused request to its wait, then resolve it with `event`. */
const pauseAt = async (
    agent: AgentDefinition,
    journal: WaitJournal,
    runtime: ReturnType<typeof memoryRuntime>,
    generate: ReturnType<typeof scriptedGenerate>,
) => {
    const paused = runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

    paused.catch(() => {
        /* the paused invocation never settles */
    });
    await flushMicrotasks();
};

describe("requestSecretTool — the loop pauses and resumes", () => {
    it("pauses on the request, resumes on the ref, consumes the value once, and keeps it out of every record", async () => {
        expect.assertions(15);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { host, take, discard } = secretHost();
        const ref = await host.secretValues.put(SECRET, { scope: "thread-1", ttlMs: 60_000 });
        const runtime = memoryRuntime({ handlers: { "agents:agentTakeSecret": take, "agents:agentDiscardSecret": discard } });
        const journal = new WaitJournal();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: ref }),
            finalTurn("done"),
        ]);

        // Phase A — the run stops on the secret wait with the marker persisted.
        await pauseAt(agent, journal, runtime, generate);

        expect(journal.waitedNames).toStrictEqual(["secret:call_1"]);
        expect(journal.waitOptions.get("secret:call_1")).toStrictEqual({ timeout: 3 * 24 * 60 * 60 * 1000, type: "agent-secret:call_1" });
        expect([...runtime.messages.values()].some((message) => message.status === "awaiting_secret")).toBe(true);
        expect(used).toStrictEqual([]);

        // Phase B — the supply lands: the wake-up carries the ref, and the same
        // instance replays into the consuming tool.
        journal.events.set("secret:call_1", { ref });
        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "done", turns: 3 });
        expect(used).toStrictEqual([SECRET]);

        // The tool result the model sees is the ref, not the value.
        const requestRow = [...runtime.messages.values()].find((message) => message.toolCallId === "call_1" && message.role === "tool");

        expect(requestRow?.content).toBe(JSON.stringify({ secretRef: ref }));
        expect(runtime.messages.has("thread-1:wf-1:secret:call_1")).toBe(false);

        // The consuming call claimed the value under its own step name and discarded it after use.
        const takes = runtime.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret");

        expect(takes.map((dispatch) => dispatch.args)).toStrictEqual([{ claimant: "tool:charge:call_2", ref, threadKey: "thread-1" }]);
        expect(runtime.dispatches.some((dispatch) => dispatch.path === "agents:agentDiscardSecret")).toBe(true);

        // The value is in no record the run keeps.
        expect(JSON.stringify([...runtime.messages.values()])).not.toContain(SECRET);
        expect(JSON.stringify(runtime.dispatches)).not.toContain(SECRET);
        expect(JSON.stringify([...journal.payloads.values()])).not.toContain(SECRET);
        expect(journal.persisted()).not.toContain(SECRET);
        expect(JSON.stringify([...runtime.threads.values()])).not.toContain(SECRET);
    });

    it("does not re-run the consuming tool, or re-take the value, when the instance replays", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { host, take, discard } = secretHost();
        const ref = await host.secretValues.put(SECRET, { scope: "thread-1", ttlMs: 60_000 });
        const runtime = memoryRuntime({ handlers: { "agents:agentTakeSecret": take, "agents:agentDiscardSecret": discard } });
        const journal = new WaitJournal();
        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", {}), toolTurn("call_2", "charge", { secretRef: ref }), finalTurn("done")]);

        await pauseAt(agent, journal, runtime, generate);
        journal.events.set("secret:call_1", { ref });
        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        // A replay of the completed instance serves every step from the journal.
        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(used).toStrictEqual([SECRET]);
        expect(runtime.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret")).toHaveLength(1);
        expect(runtime.dispatches.filter((dispatch) => dispatch.path === "agents:agentDiscardSecret")).toHaveLength(1);
    });

    it("fails the consuming call deterministically, with one take and no retry, once the value has expired", async () => {
        expect.assertions(4);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { host, take, discard, advanceClock } = secretHost();
        const ref = await host.secretValues.put(SECRET, { scope: "thread-1", ttlMs: 60_000 });
        const runtime = memoryRuntime({ handlers: { "agents:agentTakeSecret": take, "agents:agentDiscardSecret": discard } });
        const journal = new WaitJournal();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", {}),
            toolTurn("call_2", "charge", { secretRef: ref }),
            finalTurn("could not charge"),
        ]);

        await pauseAt(agent, journal, runtime, generate);
        advanceClock(2 * 60_000);
        journal.events.set("secret:call_1", { ref });
        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "could not charge", turns: 3 });
        expect(used).toStrictEqual([]);
        expect(runtime.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret")).toHaveLength(1);

        const failed = [...runtime.messages.values()].find((message) => message.toolCallId === "call_2");

        expect(failed?.content).toMatch(TOOL_FAILED_PATTERN);
    });

    it("records a decline as a deterministic tool result and never takes a value", async () => {
        expect.assertions(4);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { take, discard } = secretHost();
        const runtime = memoryRuntime({ handlers: { "agents:agentTakeSecret": take, "agents:agentDiscardSecret": discard } });
        const journal = new WaitJournal();
        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", {}), finalTurn("no key")]);

        await pauseAt(agent, journal, runtime, generate);
        journal.events.set("secret:call_1", { declined: true });
        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        const row = [...runtime.messages.values()].find((message) => message.toolCallId === "call_1" && message.role === "tool");

        expect(row?.content).toBe('Error: tool "requestKey" was not run: the user declined to supply it.');
        expect(used).toStrictEqual([]);
        expect(runtime.dispatches.some((dispatch) => dispatch.path === "agents:agentTakeSecret")).toBe(false);
        expect(runtime.messages.has("thread-1:wf-1:secret:call_1")).toBe(false);
    });

    it("treats a timed-out wait as no value supplied, retires the marker, and lets the run go on", async () => {
        expect.assertions(3);

        const agent = secretAgent([]);
        const runtime = memoryRuntime();
        const journal = new WaitJournal();

        journal.timeoutWaits.add("secret:call_1");

        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", {}), finalTurn("no key")]);
        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "no key", turns: 2 });
        expect([...runtime.messages.values()].find((message) => message.toolCallId === "call_1")?.content).toContain("not supplied before the timeout");
        expect(runtime.messages.has("thread-1:wf-1:secret:call_1")).toBe(false);
    });
});

describe("withSecret — the consuming step", () => {
    it("replays a completed consume from its journal entry when the enclosing tool step runs again", async () => {
        expect.assertions(3);

        const { host, take, discard } = secretHost();
        const ref = await host.secretValues.put(SECRET, { scope: "thread-1", ttlMs: 60_000 });
        const claims: string[] = [];
        const journal = new WaitJournal();
        const context = {
            idempotencyKey: "tool:charge:call_2",
            run: (reference: { __lunoraRef: string }, args?: Record<string, unknown>) => {
                if (reference["__lunoraRef"] === "agents:agentTakeSecret") {
                    claims.push(String(args?.["claimant"]));

                    return Promise.resolve(take(args));
                }

                return Promise.resolve(discard(args));
            },
            step: journal,
            threadKey: "thread-1",
        } as unknown as AgentToolContext;

        // The enclosing tool step failed after `withSecret` returned, so the outer
        // step re-runs against the same journal: the consume must not re-take.
        await expect(withSecret(context, ref, (secret) => secret.length)).resolves.toBe(SECRET.length);
        await expect(withSecret(context, ref, (secret) => secret.length)).resolves.toBe(SECRET.length);
        expect(claims).toStrictEqual(["tool:charge:call_2"]);
    });

    it("re-takes on a retry of the same call, and refuses a different call", async () => {
        expect.assertions(4);

        const { host, take, discard } = secretHost();
        const ref = await host.secretValues.put(SECRET, { scope: "thread-1", ttlMs: 60_000 });
        const claims: string[] = [];
        const context = (idempotencyKey: string): AgentToolContext =>
            ({
                idempotencyKey,
                run: (reference: { __lunoraRef: string }, args?: Record<string, unknown>) => {
                    if (reference["__lunoraRef"] === "agents:agentTakeSecret") {
                        claims.push(String(args?.["claimant"]));

                        return Promise.resolve(take(args));
                    }

                    return Promise.resolve(discard(args));
                },
                step: new WaitJournal(),
                threadKey: "thread-1",
            }) as unknown as AgentToolContext;

        let attempts = 0;
        const flaky = context("tool:charge:call_2");

        // The first attempt fails inside `use`, after the take; the retry re-takes with the same claimant.
        const value = await withSecret(flaky, ref, (secret) => {
            attempts += 1;

            if (attempts === 1) {
                throw new Error("transient");
            }

            return secret.length;
        }).catch((error: unknown) => (error as Error).message);

        expect(value).toBe("transient");

        const retried = await withSecret(flaky, ref, (secret) => secret.length);

        expect(retried).toBe(SECRET.length);
        expect(claims).toStrictEqual(["tool:charge:call_2", "tool:charge:call_2"]);
        await expect(withSecret(context("tool:other:call_3"), ref, () => "never")).rejects.toBeInstanceOf(SecretUnavailableError);
    });
});

describe("withSecret — two secrets in one call", () => {
    it("runs each callback with its own value, because each ref names its own durable step", async () => {
        expect.assertions(2);

        const { host, take, discard } = secretHost();
        const keyRef = await host.secretValues.put("alpha-key-123", { scope: "thread-1", ttlMs: 60_000 });
        const signingRef = await host.secretValues.put("beta-signing-secret-xyz", { scope: "thread-1", ttlMs: 60_000 });
        const journal = new WaitJournal();
        const context = {
            idempotencyKey: "tool:charge:call_2",
            run: (reference: { __lunoraRef: string }, args?: Record<string, unknown>) =>
                Promise.resolve(reference["__lunoraRef"] === "agents:agentTakeSecret" ? take(args) : discard(args)),
            step: journal,
            threadKey: "thread-1",
        } as unknown as AgentToolContext;

        const keyLength = await withSecret(context, keyRef, (secret) => secret.length);
        const signingLength = await withSecret(context, signingRef, (secret) => secret.length);

        expect(keyLength).toBe("alpha-key-123".length);
        expect(signingLength).toBe("beta-signing-secret-xyz".length);
    });
});
