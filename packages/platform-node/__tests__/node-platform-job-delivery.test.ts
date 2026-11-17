import { describe, expect, it, vi } from "vitest";

import { createJobDelivery } from "../src/node-platform";

// A due job reaches the shard through its delivery, so the agent-run shard guard has to hold here too, not only in the dispatch route.
describe(createJobDelivery, () => {
    const job = { id: "job-1", scheduledFor: 0 } as never;

    it("refuses an agent run aimed off the default shard, before it reaches the shard", async () => {
        expect.assertions(2);

        const invoke = vi.fn<(request: { functionPath: string; shardKey?: string }) => Promise<Response>>(async () => new Response("ok", { status: 200 }));
        const deliver = createJobDelivery(invoke, "org-a");

        await expect(deliver("agents:agentRun", {}, job)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(invoke).not.toHaveBeenCalled();
    });

    it("delivers an agent run on the default shard, and any other function anywhere", async () => {
        expect.assertions(2);

        const invoke = vi.fn<(request: { functionPath: string; shardKey?: string }) => Promise<Response>>(async () => new Response("ok", { status: 200 }));

        await createJobDelivery(invoke, "__root__")("agents:agentRun", {}, job);
        await createJobDelivery(invoke, "org-a")("posts:list", {}, job);

        expect(invoke).toHaveBeenCalledTimes(2);
        expect(invoke.mock.calls[1]?.[0]).toStrictEqual(expect.objectContaining({ functionPath: "posts:list", shardKey: "org-a" }));
    });
});
