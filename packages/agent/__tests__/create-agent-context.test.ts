import { describe, expect, it } from "vitest";

import createAgentContext from "../src/create-agent-context";
import type { AgentFunctionReference, AgentRunInput } from "../src/types";

const MISSING_BINDING_PATTERN = /AGENT_SUPPORT/u;
const BRANCH_MARKER_PATTERN = /reserved workflow branch-marker key/u;

const fakeBinding = (): {
    binding: {
        create: (options?: { id?: string; params?: unknown }) => Promise<{ id: string }>;
        get: (id: string) => Promise<{ status: () => Promise<unknown>; terminate: () => Promise<void> }>;
    };
    createCalls: { id?: string; params?: unknown }[];
    statusCalls: string[];
    terminateCalls: string[];
} => {
    const createCalls: { id?: string; params?: unknown }[] = [];
    const statusCalls: string[] = [];
    const terminateCalls: string[] = [];

    return {
        binding: {
            create: async (options?: { id?: string; params?: unknown }) => {
                createCalls.push(options ?? {});

                return { id: options?.id ?? "generated-id" };
            },
            get: async (id: string) => {
                statusCalls.push(id);

                return {
                    status: async () => {
                        return { status: "running" };
                    },
                    terminate: async () => {
                        terminateCalls.push(id);
                    },
                };
            },
        },
        createCalls,
        statusCalls,
        terminateCalls,
    };
};

describe(createAgentContext, () => {
    it("starts a run through the agent's Workflow binding", async () => {
        const { binding, createCalls } = fakeBinding();
        const agents = createAgentContext({ AGENT_SUPPORT: binding }, [{ binding: "AGENT_SUPPORT", exportName: "support" }]);

        const handle = await agents["support"]!.run({ input: "hello", threadKey: "t-1", title: "Support" });

        expect(handle.id).toBe("generated-id");
        expect(createCalls).toStrictEqual([{ params: { input: "hello", threadKey: "t-1", title: "Support" } }]);
    });

    it("forwards an explicit instance id and reads status", async () => {
        const { binding, statusCalls } = fakeBinding();
        const agents = createAgentContext({ AGENT_SUPPORT: binding }, [{ binding: "AGENT_SUPPORT", exportName: "support" }]);

        const handle = await agents["support"]!.run({ input: "hi", threadKey: "t-1" }, { id: "run-42" });

        expect(handle.id).toBe("run-42");

        await agents["support"]!.status("run-42");

        expect(statusCalls).toStrictEqual(["run-42"]);
    });

    it("throws a directed error when the binding is missing", async () => {
        const agents = createAgentContext({}, [{ binding: "AGENT_SUPPORT", exportName: "support" }]);

        await expect(agents["support"]!.run({ input: "hi", threadKey: "t-1" })).rejects.toThrow(MISSING_BINDING_PATTERN);
    });

    it("rejects run() input carrying the reserved branch-marker key, and never calls create()", async () => {
        const { binding, createCalls } = fakeBinding();
        const agents = createAgentContext({ AGENT_SUPPORT: binding }, [{ binding: "AGENT_SUPPORT", exportName: "support" }]);

        // Reachable from the public `agents:agentRun` mutation when `publicRun:
        // true` — a forged marker must be rejected before it ever reaches create().
        const forgedInput = {
            __lunoraBranch: { eventType: "lunora:branch:x", index: 0, parentBinding: "WORKFLOW_X", parentId: "p" },
            input: "hi",
            threadKey: "t-1",
        } as unknown as AgentRunInput;

        await expect(agents["support"]!.run(forgedInput)).rejects.toThrow(BRANCH_MARKER_PATTERN);
        expect(createCalls).toHaveLength(0);
    });

    it("cancels a run: terminates the instance and marks its thread cancelled", async () => {
        const { binding, terminateCalls } = fakeBinding();
        const dispatches: { args: Record<string, unknown> | undefined; path: string }[] = [];
        const dispatch = async (reference: AgentFunctionReference, args?: Record<string, unknown>): Promise<unknown> => {
            // eslint-disable-next-line no-underscore-dangle -- __lunoraRef is the reference's wire field
            dispatches.push({ args, path: reference.__lunoraRef });

            return undefined;
        };

        const agents = createAgentContext({ AGENT_SUPPORT: binding }, [{ binding: "AGENT_SUPPORT", exportName: "support" }], dispatch);

        await agents["support"]!.cancel("run-7");

        expect(terminateCalls).toStrictEqual(["run-7"]);
        expect(dispatches).toStrictEqual([{ args: { instanceId: "run-7", status: "cancelled" }, path: "agents:agentPatchThread" }]);
    });

    it("still resolves cancel when the thread-status patch fails (the run is already terminated)", async () => {
        const { binding, terminateCalls } = fakeBinding();
        // The status patch fails, but terminate() already succeeded — the run is
        // gone, so cancel() must not surface the bookkeeping failure.
        const dispatch = async (): Promise<unknown> => {
            throw new Error("dispatch unavailable");
        };

        const agents = createAgentContext({ AGENT_SUPPORT: binding }, [{ binding: "AGENT_SUPPORT", exportName: "support" }], dispatch);

        await expect(agents["support"]!.cancel("run-9")).resolves.toBeUndefined();
        expect(terminateCalls).toStrictEqual(["run-9"]);
    });
});
