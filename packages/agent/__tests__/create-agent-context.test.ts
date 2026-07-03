import { describe, expect, it } from "vitest";

import createAgentContext from "../src/create-agent-context";

const MISSING_BINDING_PATTERN = /AGENT_SUPPORT/u;

const fakeBinding = (): {
    binding: {
        create: (options?: { id?: string; params?: unknown }) => Promise<{ id: string }>;
        get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
    };
    createCalls: { id?: string; params?: unknown }[];
    statusCalls: string[];
} => {
    const createCalls: { id?: string; params?: unknown }[] = [];
    const statusCalls: string[] = [];

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
                };
            },
        },
        createCalls,
        statusCalls,
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
});
