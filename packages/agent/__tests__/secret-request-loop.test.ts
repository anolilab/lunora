import { createDispatchRunner } from "@lunora/dispatch";
import type { SecretValueHost } from "@lunora/platform";
import { createReferenceHost } from "@lunora/platform/conformance";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { agentComponent } from "../src/component";
import { defineAgent, defineAgentTool } from "../src/define-agent";
import { requestSecretTool, SecretUnavailableError, withSecret } from "../src/secret-request-tool";
import type { AgentDefinition, AgentStepLike, AgentToolContext } from "../src/types";
import { fakeDatabase, finalTurn, loopDefaults, memoryRuntime, scriptedGenerate, toolTurn } from "./loop-harness";

const SECRET = "sk_live_correct-horse-battery-staple";
const SECRET_WORKS = "charged";
const WORKFLOW_TIMEOUT = "WorkflowTimeoutError";
const TOOL_FAILED_PATTERN = /failed and will not be retried\. the secret is no longer available/u;
const THREAD = "thread-1";
const INSTANCE = "wf-1";
const OWNER = "user-a";
const WAIT_GRACE_MS = 60 * 1000;
/** The request's deadline, which the wait outlasts by the grace. The agent's default `approvalTimeout` is longer, so it is the host's value lifetime less the grace. */
const DEADLINE_MS = 24 * 60 * 60 * 1000 - WAIT_GRACE_MS;
/** Past the value's lifetime: it is takeable until the request's deadline plus the grace, within the store's ceiling. */
const PAST_VALUE_LIFETIME_MS = DEADLINE_MS + WAIT_GRACE_MS + 1;

/**
 * Durable-step double for the secret wait: a pre-delivered event resolves the
 * wait, an undelivered one hibernates (the promise never settles, as Cloudflare
 * freezes the instance), and `timeoutWaits` makes a named wait fail the way an
 * elapsed host timeout does. Records every wait's options and resolved payload.
 */
/** A wait's armed milestone: `promise` settles when the run parks on the wait, `fire` settles it. */
interface Armed {
    fire: () => void;
    promise: Promise<void>;
}

class WaitJournal implements AgentStepLike {
    public readonly invoked: string[] = [];

    public readonly payloads = new Map<string, unknown>();

    public readonly events = new Map<string, unknown>();

    public readonly timeoutWaits = new Set<string>();

    public readonly waitOptions = new Map<string, { timeout?: number | string; type: string }>();

    public readonly waitedNames: string[] = [];

    private readonly entries = new Map<string, { output: unknown }>();

    private readonly armedWaits = new Map<string, Armed>();

    /** Resolves once the run has armed a wait of this name, the point at which it is parked on it. */
    public armed(name: string): Promise<void> {
        return this.armedSignal(name).promise;
    }

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
            this.armedSignal(name).fire();

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

    private armedSignal(name: string): Armed {
        const existing = this.armedWaits.get(name);

        if (existing !== undefined) {
            return existing;
        }

        let fire: () => void = () => {};
        const promise = new Promise<void>((resolve) => {
            fire = () => {
                resolve();
            };
        });
        const signal: Armed = { fire, promise };

        this.armedWaits.set(name, signal);

        return signal;
    }
}

type Handler = { handler: (context: unknown, args: never) => unknown };

/**
 * The secret-request component over ONE database, as the shard runs it. The loop's
 * runtime double dispatches the internal functions here (`handlers`), and the owner's
 * supply and decline go through the same component. A wake-up lands in the journal the
 * way the workflow host would deliver it. Supply and decline also write the loop's
 * `awaiting_secret` marker into this database, which the loop writes into its own
 * runtime double; the supply reads it from here, so the test mirrors it.
 */
const secretHost = async (journal: WaitJournal) => {
    const reference = createReferenceHost();

    if (reference.secretValues === undefined || reference.advanceClock === undefined) {
        throw new Error("the reference host must expose its secret store and clock");
    }

    const { secretValues, advanceClock } = reference;
    const puts: string[] = [];
    const store: SecretValueHost = {
        discard: (ref) => secretValues.discard(ref),
        put: async (value, options) => {
            const ref = await secretValues.put(value, options);

            puts.push(value);

            return ref;
        },
        take: (ref, options) => secretValues.take(ref, options),
    };
    const { database, rows } = fakeDatabase();
    const insert = database["insert"] as (table: string, document: Record<string, unknown>) => Promise<unknown>;
    const { functions } = agentComponent();
    const context = {
        agentSecrets: store,
        agents: {
            support: {
                sendEvent: (_id: string, event: { payload: unknown; type: string }) => {
                    journal.events.set(event.type.replace("agent-", ""), event.payload);

                    return Promise.resolve();
                },
            },
        },
        db: database,
    };
    const dispatch =
        (fn: unknown) =>
        (args?: Record<string, unknown>): unknown =>
            (fn as Handler).handler(context, args as never);

    await insert("agent_threads", {
        agent: "support",
        createdAt: 0,
        instanceId: INSTANCE,
        key: THREAD,
        messageCount: 0,
        owner: OWNER,
        status: "awaiting_input",
        updatedAt: 0,
    });

    const mirrorMarker = async (toolCallId: string): Promise<void> => {
        await insert("agent_messages", {
            content: "marker",
            createdAt: 0,
            messageKey: `${INSTANCE}:secret:${toolCallId}`,
            role: "tool",
            seq: 0,
            status: "awaiting_secret",
            threadKey: THREAD,
            toolCallId,
            toolName: "requestKey",
        });
    };

    const asOwner = (fn: unknown, args: Record<string, unknown>): unknown => (fn as Handler).handler({ ...context, auth: { userId: OWNER } }, args as never);

    return {
        advanceClock,
        /** Every dispatch the runtime double routes here, keyed by its function path. */
        handlers: {
            "agents:agentDiscardSecret": dispatch(functions.agentDiscardSecret),
            "agents:agentOpenSecretRequest": dispatch(functions.agentOpenSecretRequest),
            "agents:agentSettleSecretRequest": dispatch(functions.agentSettleSecretRequest),
            "agents:agentTakeSecret": dispatch(functions.agentTakeSecret),
        } as Record<string, (args?: Record<string, unknown>) => unknown>,
        puts,
        rows,
        decline: async (toolCallId: string): Promise<unknown> => {
            await mirrorMarker(toolCallId);

            return asOwner(functions.agentDeclineSecret, { threadKey: THREAD, toolCallId });
        },
        supply: async (toolCallId: string, secret: string): Promise<unknown> => {
            await mirrorMarker(toolCallId);

            return asOwner(functions.agentSupplySecret, { secret, threadKey: THREAD, toolCallId });
        },
    };
};

type SecretHost = Awaited<ReturnType<typeof secretHost>>;

/** A fresh journal, host and runtime wired together. */
const setup = async () => {
    const journal = new WaitJournal();
    const host = await secretHost(journal);
    const runtime = memoryRuntime({ handlers: host.handlers });

    return { host, journal, runtime };
};

/** Every value a record the run keeps can hold, as text, for the "no ref, no value" checks. */
const serialized = (values: unknown): string => JSON.stringify(values);

/** The host ref the request row holds, read the way a test may: from the table, never from a client. */
const storedRef = (host: SecretHost): string => {
    const [row] = host.rows.get("agent_secret_requests") ?? [];

    return String(row?.["ref"]);
};

const secretAgent = (used: string[], approvalTimeout?: string): AgentDefinition =>
    defineAgent({
        ...(approvalTimeout === undefined ? {} : { approvalTimeout: approvalTimeout as "7 days" }),
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
            // A second tool that is NOT the declared consumer. It tries to read the value and must be refused.
            other: defineAgentTool({
                description: "Tries to use a stored key it was never given.",
                execute: (input, context) =>
                    withSecret(context, (input as { secretRef: string }).secretRef, (secret) => {
                        used.push(`other:${secret}`);

                        return "leaked";
                    }),
                inputSchema: jsonSchema({ properties: { secretRef: { type: "string" } }, required: ["secretRef"], type: "object" }) as never,
            }),
            requestKey: requestSecretTool({ consumer: "charge", description: "Ask the user for their payment API key." }),
        },
    });

/**
 * Run the paused request (`call_1`) to its wait. The paused invocation never settles, so it is
 * left pending; the wait being armed is the milestone that the marker and the request row are written.
 */
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
    await journal.armed("secret:call_1");
};

describe("requestSecretTool — the loop pauses and resumes", () => {
    it("pauses on the request, resumes on the request id, consumes the value once, and keeps it out of every record", async () => {
        expect.assertions(23);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: "call_1" }),
            finalTurn("done"),
        ]);

        // Phase A — the run stops on the secret wait, with the request row and the marker written.
        await pauseAt(agent, journal, runtime, generate);

        expect(journal.waitedNames).toStrictEqual(["secret:call_1"]);
        expect(journal.waitOptions.get("secret:call_1")).toStrictEqual({ timeout: DEADLINE_MS + WAIT_GRACE_MS, type: "agent-secret:call_1" });
        expect([...runtime.messages.values()].some((message) => message.status === "awaiting_secret")).toBe(true);
        expect(used).toStrictEqual([]);

        // Phase B — the supply lands. The wake-up is payload-free, and the same instance replays into the consuming tool.
        await host.supply("call_1", SECRET);

        expect(journal.events.get("secret:call_1")).toStrictEqual({});

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "done", turns: 3 });
        expect(used).toStrictEqual([SECRET]);

        // The tool result the model sees is the request id, not the host ref.
        const requestRow = [...runtime.messages.values()].find((message) => message.toolCallId === "call_1" && message.role === "tool");

        expect(requestRow?.content).toBe(JSON.stringify({ secretRef: "call_1" }));
        expect(runtime.messages.has("thread-1:wf-1:secret:call_1")).toBe(false);

        // The consuming call claimed the value under its own step name, and discarded it after use.
        const takes = runtime.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret");

        expect(takes.map((dispatch) => dispatch.args)).toStrictEqual([
            { claimant: "tool:charge:call_2", consumerCallId: "call_2", instanceId: INSTANCE, threadKey: THREAD, toolCallId: "call_1" },
        ]);
        expect(runtime.dispatches.some((dispatch) => dispatch.path === "agents:agentDiscardSecret")).toBe(true);

        // Neither the value nor the host ref is in any record the run keeps.
        const ref = storedRef(host);

        for (const record of [runtime.messages.values(), runtime.dispatches, runtime.threads.values(), journal.events.values(), journal.payloads.values()]) {
            expect(serialized([...record])).not.toContain(SECRET);
            expect(serialized([...record])).not.toContain(ref);
        }

        expect(journal.persisted()).not.toContain(SECRET);
        expect(journal.invoked.join("\n")).not.toContain(ref);
    });

    it("holds a request open for less than the host keeps a supplied value, however long approvalTimeout is", async () => {
        expect.assertions(2);

        const agent = secretAgent([], "7 days");
        const { journal, runtime } = await setup();

        await pauseAt(agent, journal, runtime, scriptedGenerate([toolTurn("call_1", "requestKey", { label: "API key" }), finalTurn("done")]));

        const request = runtime.dispatches.find((dispatch) => dispatch.path === "agents:agentOpenSecretRequest");

        expect(journal.waitOptions.get("secret:call_1")?.timeout).toBe(DEADLINE_MS + WAIT_GRACE_MS);
        expect((request?.args as { expiresAt: number }).expiresAt - Date.now()).toBeLessThanOrEqual(DEADLINE_MS);
    });

    it("changes the thread's status around the wait only while this run still owns the thread", async () => {
        expect.assertions(1);

        const agent = secretAgent([]);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: "call_1" }),
            finalTurn("done"),
        ]);

        await pauseAt(agent, journal, runtime, generate);
        await host.supply("call_1", SECRET);
        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        const waitPatches = runtime.dispatches
            .filter((dispatch) => dispatch.path === "agents:agentPatchThread")
            .map((dispatch) => dispatch.args as { ifInstanceId?: string; status?: string })
            .filter((args) => args.status === "awaiting_input" || args.status === "running");

        // A replacement run that took the thread over while this one waited must keep its own status.
        expect(waitPatches.filter((args) => args.ifInstanceId !== INSTANCE)).toStrictEqual([]);
    });

    it("does not re-run the consuming tool, or re-take the value, when the instance replays", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: "call_1" }),
            finalTurn("done"),
        ]);

        await pauseAt(agent, journal, runtime, generate);
        await host.supply("call_1", SECRET);
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
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: "call_1" }),
            finalTurn("could not charge"),
        ]);

        await pauseAt(agent, journal, runtime, generate);
        await host.supply("call_1", SECRET);
        host.advanceClock(PAST_VALUE_LIFETIME_MS);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "could not charge", turns: 3 });
        expect(used).toStrictEqual([]);
        expect(runtime.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret")).toHaveLength(1);

        const failed = [...runtime.messages.values()].find((message) => message.toolCallId === "call_2");

        expect(failed?.content).toMatch(TOOL_FAILED_PATTERN);
    });

    it("refuses a call from a tool that was not declared as the consumer, and leaves the value for the declared one", async () => {
        expect.assertions(4);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "other", { secretRef: "call_1" }),
            toolTurn("call_3", "charge", { secretRef: "call_1" }),
            finalTurn("done"),
        ]);

        await pauseAt(agent, journal, runtime, generate);
        await host.supply("call_1", SECRET);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "done", turns: 4 });
        // The wrong tool never saw the value, and the declared consumer still got it.
        expect(used).toStrictEqual([SECRET]);

        const takes = runtime.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret");

        expect(takes.map((dispatch) => (dispatch.args as { claimant: string }).claimant)).toStrictEqual(["tool:other:call_2", "tool:charge:call_3"]);
        // Only the successful consume discards: a refused call cannot burn the value.
        expect(runtime.dispatches.filter((dispatch) => dispatch.path === "agents:agentDiscardSecret")).toHaveLength(1);
    });

    it("records a decline as a deterministic tool result and never takes a value", async () => {
        expect.assertions(4);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key")]);

        await pauseAt(agent, journal, runtime, generate);
        await host.decline("call_1");
        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        const row = [...runtime.messages.values()].find((message) => message.toolCallId === "call_1" && message.role === "tool");

        expect(row?.content).toBe('Error: tool "requestKey" was not run: the user declined to supply it.');
        expect(used).toStrictEqual([]);
        expect(runtime.dispatches.some((dispatch) => dispatch.path === "agents:agentTakeSecret")).toBe(false);
        expect(runtime.messages.has("thread-1:wf-1:secret:call_1")).toBe(false);
    });

    it("treats a timed-out wait as no value supplied, retires the marker, and lets the run go on", async () => {
        expect.assertions(4);

        const agent = secretAgent([]);
        const { host, journal, runtime } = await setup();

        journal.timeoutWaits.add("secret:call_1");

        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key")]);
        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "no key", turns: 2 });
        expect([...runtime.messages.values()].find((message) => message.toolCallId === "call_1")?.content).toContain("not supplied before the timeout");
        expect(runtime.messages.has("thread-1:wf-1:secret:call_1")).toBe(false);
        expect(host.rows.get("agent_secret_requests")?.[0]?.["status"]).toBe("expired");
    });

    it("honours a supply that landed before the timeout was settled, and runs the consumer on it", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const agent = secretAgent(used);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: "call_1" }),
            finalTurn("done"),
        ]);

        await pauseAt(agent, journal, runtime, generate);
        await host.supply("call_1", SECRET);

        // The wait reports an elapsed timeout even though the supply committed: the settle step must read the row.
        journal.timeoutWaits.add("secret:call_1");

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "done", turns: 3 });
        expect(used).toStrictEqual([SECRET]);
        expect([...runtime.messages.values()].find((message) => message.toolCallId === "call_1")?.content).toBe(JSON.stringify({ secretRef: "call_1" }));
    });

    it("refuses a supply that arrives after the timeout settled the request, with CONFLICT and nothing stored", async () => {
        expect.assertions(4);

        const agent = secretAgent([]);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key")]);

        await pauseAt(agent, journal, runtime, generate);
        journal.timeoutWaits.add("secret:call_1");
        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        await expect(host.supply("call_1", SECRET)).rejects.toMatchObject({ code: "CONFLICT" });
        expect(host.puts).toStrictEqual([]);
        expect(host.rows.get("agent_secret_requests")?.[0]?.["status"]).toBe("expired");
        expect(serialized([...runtime.messages.values()])).not.toContain(SECRET);
    });
});

describe("withSecret — the consuming step", () => {
    /** An open request on `toolCallId`, supplied with `secret`, as the loop and the owner would leave it. */
    const suppliedRequest = async (host: SecretHost, toolCallId: string, secret: string): Promise<string> => {
        await host.handlers["agents:agentOpenSecretRequest"]?.({
            consumerTool: "charge",
            expiresAt: Date.now() + DEADLINE_MS,
            instanceId: INSTANCE,
            threadKey: THREAD,
            toolCallId,
            toolName: "requestKey",
        });
        await host.supply(toolCallId, secret);

        return toolCallId;
    };

    /** A consuming tool's context whose dispatches reach the real component. */
    const consumerContext = (host: SecretHost, step: AgentStepLike, claims: string[], idempotencyKey: string, toolCallId: string): AgentToolContext =>
        ({
            idempotencyKey,
            instanceId: INSTANCE,
            run: (reference: { __lunoraRef: string }, args?: Record<string, unknown>) => {
                if (reference["__lunoraRef"] === "agents:agentTakeSecret") {
                    claims.push(String(args?.["claimant"]));
                }

                return Promise.resolve(host.handlers[reference["__lunoraRef"]]?.(args));
            },
            step,
            threadKey: THREAD,
            toolCallId,
        }) as unknown as AgentToolContext;

    it("replays a completed consume from its journal entry when the enclosing tool step runs again", async () => {
        expect.assertions(3);

        const host = await secretHost(new WaitJournal());
        const ref = await suppliedRequest(host, "call_1", SECRET);
        const claims: string[] = [];
        const journal = new WaitJournal();
        const context = consumerContext(host, journal, claims, "tool:charge:call_2", "call_2");

        // The enclosing tool step failed after `withSecret` returned, so the outer
        // step re-runs against the same journal: the consume must not re-take.
        await expect(withSecret(context, ref, (secret) => secret.length)).resolves.toBe(SECRET.length);
        await expect(withSecret(context, ref, (secret) => secret.length)).resolves.toBe(SECRET.length);
        expect(claims).toStrictEqual(["tool:charge:call_2"]);
    });

    it("re-takes on a retry of the same call, and refuses a different call", async () => {
        expect.assertions(4);

        const host = await secretHost(new WaitJournal());
        const ref = await suppliedRequest(host, "call_1", SECRET);
        const claims: string[] = [];
        let attempts = 0;
        const flaky = consumerContext(host, new WaitJournal(), claims, "tool:charge:call_2", "call_2");

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
        await expect(withSecret(consumerContext(host, new WaitJournal(), claims, "tool:other:call_3", "call_3"), ref, () => "never")).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
    });

    it("refuses to journal a callback result that echoes the secret, discards the value, and fails the call", async () => {
        expect.assertions(3);

        const host = await secretHost(new WaitJournal());
        const ref = await suppliedRequest(host, "call_1", SECRET);
        const journalled: unknown[] = [];
        const step = {
            do: async (_name: string, callback: () => Promise<unknown>) => {
                const output = await callback();

                journalled.push(output);

                return output;
            },
        } as unknown as AgentStepLike;
        const context = consumerContext(host, step, [], "tool:charge:call_2", "call_2");

        await expect(
            withSecret(context, ref, (secret) => {
                return { header: `Bearer ${secret}` };
            }),
        ).rejects.toThrow("withSecret's callback returned the secret");
        expect(JSON.stringify(journalled)).not.toContain(SECRET);

        // The credential is no longer needed once the call is refused, so it is not left until its TTL.
        await expect(withSecret(consumerContext(host, new WaitJournal(), [], "tool:charge:call_2", "call_2"), ref, () => "again")).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
    });
});

describe("withSecret — two secrets in one call", () => {
    it("runs each callback with its own value, because each request names its own durable step", async () => {
        expect.assertions(2);

        const host = await secretHost(new WaitJournal());

        await host.handlers["agents:agentOpenSecretRequest"]?.({
            consumerTool: "charge",
            expiresAt: Date.now() + DEADLINE_MS,
            instanceId: INSTANCE,
            threadKey: THREAD,
            toolCallId: "call_a",
            toolName: "requestKey",
        });
        await host.handlers["agents:agentOpenSecretRequest"]?.({
            consumerTool: "charge",
            expiresAt: Date.now() + DEADLINE_MS,
            instanceId: INSTANCE,
            threadKey: THREAD,
            toolCallId: "call_b",
            toolName: "requestKey",
        });
        await host.supply("call_a", "alpha-key-123");
        await host.supply("call_b", "beta-signing-secret-xyz");

        const journal = new WaitJournal();
        const context = {
            idempotencyKey: "tool:charge:call_2",
            instanceId: INSTANCE,
            run: (reference: { __lunoraRef: string }, args?: Record<string, unknown>) => Promise.resolve(host.handlers[reference["__lunoraRef"]]?.(args)),
            step: journal,
            threadKey: THREAD,
            toolCallId: "call_2",
        } as unknown as AgentToolContext;

        const keyLength = await withSecret(context, "call_a", (secret) => secret.length);
        const signingLength = await withSecret(context, "call_b", (secret) => secret.length);

        expect(keyLength).toBe("alpha-key-123".length);
        expect(signingLength).toBe("beta-signing-secret-xyz".length);
    });
});

/** A consumer whose callback runs `use`, so a test chooses how the callback fails. */
const consumerAgent = (use: (secret: string) => string, telemetry?: AgentDefinition["telemetry"]): AgentDefinition =>
    defineAgent({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        telemetry,
        tools: {
            charge: defineAgentTool({
                description: "Charge the card with a stored key.",
                execute: (input, context) => withSecret(context, (input as { secretRef: string }).secretRef, use),
                inputSchema: jsonSchema({ properties: { secretRef: { type: "string" } }, required: ["secretRef"], type: "object" }) as never,
            }),
            requestKey: requestSecretTool({ consumer: "charge", description: "Ask the user for their payment API key." }),
        },
    });

describe("withSecret — a callback that throws never exposes the value", () => {
    it("hands telemetry and the caller a failure with the value redacted", async () => {
        expect.assertions(3);

        const ended: unknown[] = [];
        const agent = consumerAgent(
            () => {
                throw new Error(`the gateway rejected ${SECRET}`);
            },
            {
                integrations: {
                    onToolExecutionEnd: (event) => {
                        ended.push(event);
                    },
                },
            },
        );
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: "call_1" }),
            finalTurn("done"),
        ]);

        await pauseAt(agent, journal, runtime, generate);
        await host.supply("call_1", SECRET);

        const failure: unknown = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal })).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(Error);
        expect(serialized([(failure as Error).message, (failure as Error).stack])).not.toContain(SECRET);

        // Telemetry gets the error object itself, which JSON would flatten to `{}`, so its message is read directly.
        const [event] = ended as { toolOutput: { error: Error } }[];

        expect(event?.toolOutput.error.message).toBe("the gateway rejected [redacted]");
    });

    it("withholds an error whose field getter throws the value", async () => {
        expect.assertions(2);

        const agent = consumerAgent((secret) => {
            const error = new Error("the gateway rejected the key");

            Object.defineProperty(error, "detail", {
                enumerable: true,
                get: () => {
                    throw new Error(`could not read ${secret}`);
                },
            });

            throw error;
        });
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: "call_1" }),
            finalTurn("done"),
        ]);

        await pauseAt(agent, journal, runtime, generate);
        await host.supply("call_1", SECRET);

        const failure: unknown = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal })).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect((failure as Error).message).toContain("withheld");
        expect(serialized([(failure as Error).message, (failure as Error).stack, runtime.messages])).not.toContain(SECRET);
    });

    it("persists a deterministic failure's message without the value", async () => {
        expect.assertions(2);

        // A dispatch rejection built the way production builds it, so it carries the brand
        // `isDeterministicDispatchFailure` keys on and the loop records its message.
        const dispatch = createDispatchRunner({
            env: { LUNORA_ADMIN_TOKEN: "tok", LUNORA_ORIGIN_URL: "https://app.example.com/" },
            fetchImpl: async () => Response.json({ error: { code: "BAD_REQUEST", message: `the key ${SECRET} was refused` } }, { status: 400 }),
            label: "@lunora/agent",
        });
        const deterministic = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card with a stored key.",
                    execute: (input, context) =>
                        withSecret(context, (input as { secretRef: string }).secretRef, () => dispatch({ __lunoraRef: "billing:charge" } as never)),
                    inputSchema: jsonSchema({ properties: { secretRef: { type: "string" } }, required: ["secretRef"], type: "object" }) as never,
                }),
                requestKey: requestSecretTool({ consumer: "charge", description: "Ask the user for their payment API key." }),
            },
        });
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([
            toolTurn("call_1", "requestKey", { label: "API key" }),
            toolTurn("call_2", "charge", { secretRef: "call_1" }),
            finalTurn("refused"),
        ]);

        await pauseAt(deterministic, journal, runtime, generate);
        await host.supply("call_1", SECRET);
        await runAgentLoop(loopDefaults(deterministic, { generate, run: runtime.run, step: journal }));

        const row = [...runtime.messages.values()].find((message) => message.toolCallId === "call_2" && message.role === "tool");

        expect(row?.content).toContain("the key [redacted] was refused");
        expect(row?.content).not.toContain(SECRET);
    });
});

describe("a request is settled only by the run that opened it", () => {
    it("leaves a request that a newer run reopened under the same tool-call id pending", async () => {
        expect.assertions(2);

        const host = await secretHost(new WaitJournal());
        const open = (instanceId: string): unknown =>
            host.handlers["agents:agentOpenSecretRequest"]?.({
                consumerTool: "charge",
                expiresAt: Date.now() + DEADLINE_MS,
                instanceId,
                threadKey: THREAD,
                toolCallId: "call_1",
                toolName: "requestKey",
            });

        await open(INSTANCE);
        // A later run reuses the provider-issued call id, so it reopens the same request row.
        await open("wf-2");

        // The older run's wait ends late, and its settle must not expire the newer run's request.
        const settled = await host.handlers["agents:agentSettleSecretRequest"]?.({ instanceId: INSTANCE, threadKey: THREAD, toolCallId: "call_1" });

        expect(settled).toStrictEqual({ status: "expired" });
        expect(host.rows.get("agent_secret_requests")?.[0]).toMatchObject({ instanceId: "wf-2", status: "pending" });
    });
});

describe("the label a secret request carries to its owner", () => {
    it("records the label the model gave on the request row and on its marker", async () => {
        expect.assertions(2);

        const agent = secretAgent([]);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", { label: "Stripe live key" }), finalTurn("done")]);

        await pauseAt(agent, journal, runtime, generate);

        expect(host.rows.get("agent_secret_requests")?.[0]?.["label"]).toBe("Stripe live key");
        expect([...runtime.messages.values()].find((message) => message.status === "awaiting_secret")?.content).toBe(
            'Awaiting a secret for tool "requestKey": Stripe live key',
        );
    });

    it("trims and bounds the label, and keeps it as text", async () => {
        expect.assertions(1);

        const agent = secretAgent([]);
        const { host, journal, runtime } = await setup();
        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", { label: `  <b>${"k".repeat(400)}</b>  ` }), finalTurn("done")]);

        await pauseAt(agent, journal, runtime, generate);

        expect(host.rows.get("agent_secret_requests")?.[0]?.["label"]).toBe(`<b>${"k".repeat(197)}`);
    });

    it("refuses a blank label as a tool error, without pausing the run", async () => {
        expect.assertions(3);

        const agent = secretAgent([]);
        const { journal, runtime } = await setup();
        const generate = scriptedGenerate([toolTurn("call_1", "requestKey", { label: "   " }), finalTurn("no key")]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "no key", turns: 2 });
        expect(journal.waitedNames).toStrictEqual([]);
        expect([...runtime.messages.values()].find((message) => message.toolCallId === "call_1")?.content).toContain('invalid input for tool "requestKey"');
    });
});
