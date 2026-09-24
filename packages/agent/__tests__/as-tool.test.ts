import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { agentAsTool } from "../src/as-tool";
import { defineAgent } from "../src/define-agent";
import type { AgentMessageRow, AgentToolContext, AgentWorkflowBindingLike, AgentWorkflowInstanceLike } from "../src/types";
import { DurableStepJournal, loopDefaults, memoryRuntime, passthroughStep, scriptedGenerate, toolTurn } from "./loop-harness";

/** No-op wait so poll loops run without wall-clock delay in tests. */
const immediate = async (): Promise<void> => {};

const SUB_AGENT_ERRORED = /Sub-agent "research" errored/u;
const SUB_AGENT_TERMINATED = /Sub-agent "research" terminated/u;
const DID_NOT_FINISH = /did not finish within/u;
const NO_WORKFLOW_BINDING = /no Workflow binding "AGENT_RESEARCH"/u;
const REQUIRES_NAME = /requires a `name`/u;
const NON_EMPTY_DESCRIPTION = /non-empty `description`/u;
const QUOTA_EXCEEDED = /quota exceeded/u;
const MAX_POLLS_PATTERN = /`maxPolls` must be a positive integer/u;
const DEPTH_EXCEEDED = /delegation depth/u;
const TURN_CAP_PATTERN = /Sub-agent "research" hit its turn cap \(maxTurns\)/u;

/**
 * The Workflows engine's own instance-id check, mirrored so the double rejects
 * what `binding.create` rejects: at most 100 characters (tested FIRST) matching
 * `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, in which `:` is not allowed. A double that
 * accepts any string is why a sub-agent id carrying a `:` looked fine here and
 * failed on every attempt in production.
 */
const ENGINE_INSTANCE_ID_PATTERN = /^\w[\w-]*$/u;

const engineRejectsInstanceId = (id: unknown): boolean => typeof id !== "string" || id.length > 100 || !ENGINE_INSTANCE_ID_PATTERN.test(id);

/**
 * A mock `AGENT_<NAME>` Workflow binding: `create` records the params + id, and
 * `get(id)` returns an instance whose `status()` walks a scripted sequence
 * (models a run progressing to a terminal state) and whose thread the caller
 * seeds via `finalMessages`.
 */
const mockAgentBinding = (statuses: ReadonlyArray<string>, output?: unknown): AgentWorkflowBindingLike & { created: { id?: string; params?: unknown }[] } => {
    const created: { id?: string; params?: unknown }[] = [];
    const remaining = [...statuses];

    const instance: AgentWorkflowInstanceLike = {
        sendEvent: async () => {},
        status: async () => {
            // A real `InstanceStatus` carries the workflow's return value — for an
            // agent run, the `AgentRunResult` saying why the loop stopped.
            return { output, status: remaining.length > 1 ? remaining.shift() : remaining[0] };
        },
        terminate: async () => {},
    };

    return {
        created,
        create: async (options) => {
            if (engineRejectsInstanceId(options?.id)) {
                // The engine's exact rejection: `throw new WorkflowError("Workflow instance has invalid id")`.
                throw new Error("Workflow instance has invalid id");
            }

            created.push({ id: options?.id, params: options?.params });

            return { id: options?.id ?? "generated-id" };
        },
        get: async () => instance,
    };
};

/**
 * A mock `AGENT_<NAME>` Workflow binding whose `create` always rejects with the
 * given error (a duplicate-instance-id rejection, or any other failure); `get`
 * still resolves to a normal instance walking the scripted status sequence.
 */
const mockRejectingBinding = (createError: unknown, statuses: ReadonlyArray<string>): AgentWorkflowBindingLike => {
    const instance: AgentWorkflowInstanceLike = {
        sendEvent: async () => {},
        status: async () => {
            return { status: statuses[0] };
        },
        terminate: async () => {},
    };

    return {
        create: async () => {
            throw createError;
        },
        get: async () => instance,
    };
};

const context = (env: Record<string, unknown>, run: AgentToolContext["run"], overrides?: Partial<AgentToolContext>): AgentToolContext => {
    return {
        env,
        getState: async () => undefined,
        idempotencyKey: "tool:research:call_9",
        reportProgress: () => {},
        run,
        setState: async () => {},
        step: passthroughStep,
        threadKey: "thread-1",
        toolCallId: "call_9",
        ...overrides,
    };
};

/** A `run` seam that answers `agents:agentMessages` with a seeded child thread. */
const runWithChildThread = (history: ReadonlyArray<AgentMessageRow>): { keys: string[]; run: AgentToolContext["run"] } => {
    const keys: string[] = [];

    const run: AgentToolContext["run"] = async (reference, args) => {
        if (reference["__lunoraRef"] === "agents:agentMessages") {
            keys.push(args?.["key"] as string);

            return history;
        }

        throw new Error(`unexpected dispatch ${reference["__lunoraRef"]}`);
    };

    return { keys, run };
};

describe(agentAsTool, () => {
    it("starts a child run with a derived, replay-stable thread key + instance id", async () => {
        const binding = mockAgentBinding(["complete"]);
        const { run } = runWithChildThread([{ content: "the answer", role: "assistant", seq: 3 }]);

        const tool = agentAsTool({ description: "Delegate research.", name: "research", wait: immediate });
        const output = await tool.execute({ prompt: "find X" }, context({ AGENT_RESEARCH: binding }, run));

        expect(output).toBe("the answer");
        expect(binding.created).toHaveLength(1);
        // Derived from the parent's threadKey + toolCallId — same inputs replay
        // identically. The call id is hashed into the instance id (the thread key
        // keeps it raw), so no caller's id shape can make it unacceptable to `create`.
        expect(binding.created[0]?.id).toBe("sub-research-97062c995ebfee41");
        expect(binding.created[0]?.params).toStrictEqual({ depth: 1, input: "find X", threadKey: "thread-1::sub::research::call_9" });
    });

    it("starts the child under an id the engine accepts when the caller is codeTool", async () => {
        const binding = mockAgentBinding(["complete"]);
        const { run } = runWithChildThread([{ content: "the answer", role: "assistant", seq: 3 }]);

        // `codeTool` hands each script step a per-step tool-call id built as
        // `${context.toolCallId}:${step.id}` (pinned by code-tool.test.ts's
        // `toolCallId: "call_1:a"`), and its `tools` map takes any `AnyAgentTool`
        // — `agentAsTool`'s result included. Spliced straight into the instance
        // id, that colon is rejected by `create`; the rejection is not a
        // duplicate, so it rethrows, the enclosing `step.do` burns its retries,
        // and `codeTool` + `asTool` never worked together at all.
        const tool = agentAsTool({ description: "Delegate research.", name: "research", wait: immediate });
        const output = await tool.execute({ prompt: "find X" }, context({ AGENT_RESEARCH: binding }, run, { toolCallId: "call_9:fetch" }));

        expect(output).toBe("the answer");
        expect(binding.created[0]?.id).toStrictEqual(expect.stringMatching(ENGINE_INSTANCE_ID_PATTERN));
        // The thread key is not an instance id and keeps carrying the raw call id.
        expect(binding.created[0]?.params).toStrictEqual({ depth: 1, input: "find X", threadKey: "thread-1::sub::research::call_9:fetch" });
    });

    it("polls the child run's status until it reaches a terminal state", async () => {
        const binding = mockAgentBinding(["queued", "running", "complete"]);
        const { keys, run } = runWithChildThread([{ content: "done", role: "assistant", seq: 1 }]);

        const tool = agentAsTool({ description: "Delegate.", name: "research", wait: immediate });
        const output = await tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run));

        expect(output).toBe("done");
        // The child answer is read from its persisted thread (the source of truth).
        expect(keys).toStrictEqual(["thread-1::sub::research::call_9"]);
    });

    it("returns a recovery message when the child run errors or is terminated", async () => {
        const errored = agentAsTool({ description: "d", name: "research", wait: immediate });
        const { run } = runWithChildThread([]);

        await expect(errored.execute({ prompt: "go" }, context({ AGENT_RESEARCH: mockAgentBinding(["errored"]) }, run))).resolves.toMatch(SUB_AGENT_ERRORED);
        await expect(errored.execute({ prompt: "go" }, context({ AGENT_RESEARCH: mockAgentBinding(["terminated"]) }, run))).resolves.toMatch(
            SUB_AGENT_TERMINATED,
        );
    });

    it("gives up with a message after the poll budget is exhausted", async () => {
        const binding = mockAgentBinding(["running"]);
        const { run } = runWithChildThread([]);

        const tool = agentAsTool({ description: "d", maxPolls: 3, name: "research", wait: immediate });

        await expect(tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run))).resolves.toMatch(DID_NOT_FINISH);
    });

    it("throws a clear error when the child agent's binding is absent", async () => {
        const { run } = runWithChildThread([]);
        const tool = agentAsTool({ description: "d", name: "research", wait: immediate });

        await expect(tool.execute({ prompt: "go" }, context({}, run))).rejects.toThrow(NO_WORKFLOW_BINDING);
    });

    it("rethrows a non-duplicate create error instead of silently taking over an unrelated instance", async () => {
        const { run } = runWithChildThread([{ content: "unrelated instance's answer", role: "assistant", seq: 0 }]);
        const tool = agentAsTool({ description: "d", name: "research", wait: immediate });
        const binding = mockRejectingBinding(new Error("Workflow creation quota exceeded"), ["complete"]);

        // A real create failure (quota/config/service error) must surface, not
        // fall through to `binding.get()` and return some other instance's
        // (possibly stale/empty) answer.
        await expect(tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run))).rejects.toThrow(QUOTA_EXCEEDED);
    });

    it("takes over the existing instance on a genuine duplicate-instance-id error", async () => {
        const { run } = runWithChildThread([{ content: "already running answer", role: "assistant", seq: 0 }]);
        const tool = agentAsTool({ description: "d", name: "research", wait: immediate });
        const binding = mockRejectingBinding(new Error("instance already exists"), ["complete"]);

        // A duplicate-instance-id rejection means a prior attempt already
        // created this child run — take it over rather than failing.
        await expect(tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run))).resolves.toBe("already running answer");
    });

    it("is exposed as `agent.asTool` and drives a durable sub-run inside the loop", async () => {
        const child = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });

        expect(child.asTool).toBeTypeOf("function");

        const binding = mockAgentBinding(["complete"]);
        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();

        // The sub-agent tool reads the child thread through the loop's own `run`
        // seam; the harness runtime resolves `agents:agentMessages`, so seed the
        // child thread there before the parent loop runs.
        runtime.threads.set("thread-1::sub::research::call_9", {
            agent: "research",
            key: "thread-1::sub::research::call_9",
            messageCount: 1,
            status: "idle",
        });
        runtime.messages.set("thread-1::sub::research::call_9:child", {
            content: "child result",
            messageKey: "child",
            role: "assistant",
            seq: 0,
            threadKey: "thread-1::sub::research::call_9",
        } as never);

        const supervisor = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: { research: child.asTool({ description: "Delegate research.", name: "research", wait: immediate }) },
        });

        const generate = scriptedGenerate([toolTurn("call_9", "research", { prompt: "find X" }, "delegating…"), { text: "Done.", toolCalls: [] }]);

        const result = await runAgentLoop(loopDefaults(supervisor, { env: { AGENT_RESEARCH: binding }, generate, run: runtime.run, step: journal }));

        expect(result.stopped).toBe("final");
        expect(journal.invoked).toStrictEqual(["llm:turn:0", "tool:research:call_9", "llm:turn:1"]);
        expect(binding.created[0]?.id).toBe("sub-research-97062c995ebfee41");

        const toolRow = [...runtime.messages.values()].find((message) => message.role === "tool" && message.toolName === "research");

        expect(toolRow?.content).toBe("child result");
    });

    it("rejects a missing name or description", () => {
        expect(() => agentAsTool({ description: "d", name: "" })).toThrow(REQUIRES_NAME);
        expect(() => agentAsTool({ description: "", name: "research" })).toThrow(NON_EMPTY_DESCRIPTION);
    });

    it.each([0, -1, 1.5, Number.NaN])("rejects a non-positive-integer maxPolls at declaration time (%s)", (maxPolls) => {
        // `maxPolls: 0` made `pollUntilTerminal` return without a single status
        // read while still reporting a timeout — the child run is left going and
        // the parent reports it never finished.
        expect(() => agentAsTool({ description: "d", maxPolls, name: "research" })).toThrow(MAX_POLLS_PATTERN);
    });
});

describe("sub-agent recursion bound", () => {
    it("stamps the child's delegation depth on the run params", async () => {
        const binding = mockAgentBinding(["complete"]);
        const { run } = runWithChildThread([{ content: "the answer", role: "assistant", seq: 0 }]);
        const tool = agentAsTool({ description: "d", name: "research", wait: immediate });

        await tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run));

        // A top-level run is depth 0, so its child runs at depth 1.
        expect(binding.created[0]?.params).toStrictEqual({ depth: 1, input: "go", threadKey: "thread-1::sub::research::call_9" });
    });

    it("increments the parent's depth rather than restarting from zero", async () => {
        const binding = mockAgentBinding(["complete"]);
        const { run } = runWithChildThread([{ content: "the answer", role: "assistant", seq: 0 }]);
        const tool = agentAsTool({ description: "d", name: "research", wait: immediate });

        await tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run, { depth: 2 }));

        expect((binding.created[0]?.params as { depth?: number }).depth).toBe(3);
    });

    it("refuses to spawn a child at the depth bound — no Workflow instance is created", async () => {
        const binding = mockAgentBinding(["complete"]);
        const { run } = runWithChildThread([]);
        const tool = agentAsTool({ description: "d", name: "research", wait: immediate });

        // Two agents that hold each other's `asTool` delegate back and forth
        // forever: every level mints a DISTINCT child threadKey, so the per-thread
        // run-queue cap never applies across them and `maxTurns` only bounds each
        // level. The depth counter is what bounds the TREE.
        const answer = await tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run, { depth: 3 }));

        expect(answer).toMatch(DEPTH_EXCEEDED);
        expect(binding.created).toStrictEqual([]);
    });

    it("threads the run's depth through the loop onto the tool context", async () => {
        const child = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const binding = mockAgentBinding(["complete"]);
        const runtime = memoryRuntime();
        const supervisor = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: { research: child.asTool({ description: "Delegate research.", name: "research", wait: immediate }) },
        });
        const generate = scriptedGenerate([toolTurn("call_9", "research", { prompt: "find X" }, "delegating…"), { text: "Done.", toolCalls: [] }]);

        await runAgentLoop(
            loopDefaults(supervisor, {
                env: { AGENT_RESEARCH: binding },
                generate,
                params: { depth: 3, input: "hello", threadKey: "thread-1" },
                run: runtime.run,
                step: new DurableStepJournal(),
            }),
        );

        // The loop must carry `params.depth` onto every tool context, or the bound
        // resets to zero at each level and bounds nothing.
        expect(binding.created).toStrictEqual([]);

        const toolRow = [...runtime.messages.values()].find((message) => message.role === "tool" && message.toolName === "research");

        expect(toolRow?.content).toMatch(DEPTH_EXCEEDED);
    });

    it("terminates the child run when the poll budget is exhausted", async () => {
        let terminated = 0;
        const instance: AgentWorkflowInstanceLike = {
            sendEvent: async () => {},
            status: async () => {
                return { status: "running" };
            },
            terminate: async () => {
                terminated += 1;
            },
        };
        const binding: AgentWorkflowBindingLike = {
            create: async (options) => {
                return { id: options?.id ?? "generated-id" };
            },
            get: async () => instance,
        };
        const { run } = runWithChildThread([]);
        const tool = agentAsTool({ description: "d", maxPolls: 2, name: "research", wait: immediate });

        // Giving up on the poll did NOT stop the child: the parent reported "did
        // not finish" while the subtree kept running (and billing) invisibly.
        await expect(tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run))).resolves.toMatch(DID_NOT_FINISH);
        expect(terminated).toBe(1);
    });

    it("still answers when terminating an abandoned child fails", async () => {
        const instance: AgentWorkflowInstanceLike = {
            sendEvent: async () => {},
            status: async () => {
                return { status: "running" };
            },
            terminate: async () => {
                throw new Error("instance already gone");
            },
        };
        const binding: AgentWorkflowBindingLike = {
            create: async () => {
                return { id: "sub-research-call_9" };
            },
            get: async () => instance,
        };
        const { run } = runWithChildThread([]);
        const tool = agentAsTool({ description: "d", maxPolls: 2, name: "research", wait: immediate });

        await expect(tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run))).resolves.toMatch(DID_NOT_FINISH);
    });
});

describe("child-run reporting", () => {
    it("says the child hit its turn cap instead of returning an empty answer", async () => {
        // A run that stops on `maxTurns` still COMPLETES its workflow, and it has no
        // assistant turn without pending tool calls — so `finalAnswer` came back "".
        const binding = mockAgentBinding(["complete"], { stopped: "maxTurns", turns: 8 });
        const { run } = runWithChildThread([{ content: "", role: "assistant", seq: 1, toolCalls: [{ id: "c", input: {}, name: "t" }] }]);

        const tool = agentAsTool({ description: "d", name: "research", wait: immediate });

        await expect(tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run))).resolves.toMatch(TURN_CAP_PATTERN);
    });

    it("creates the child thread under the PARENT run's owner", async () => {
        const binding = mockAgentBinding(["complete"]);
        const { run } = runWithChildThread([{ content: "the answer", role: "assistant", seq: 1 }]);

        const tool = agentAsTool({ description: "d", name: "research", wait: immediate });

        await tool.execute({ prompt: "go" }, context({ AGENT_RESEARCH: binding }, run, { owner: "user-7" }));

        // Created ownerless, the sub-thread of an owned conversation was readable by
        // anyone who knew its (derivable) key.
        expect(binding.created[0]?.params).toStrictEqual({
            depth: 1,
            input: "go",
            owner: "user-7",
            threadKey: "thread-1::sub::research::call_9",
        });
    });
});
