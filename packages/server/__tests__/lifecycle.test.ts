import { describe, expect, it, vi } from "vitest";

import type { LifecycleEvent, MutationCtx as MutationContext } from "../src/index";
import { onConnect, onDisconnect } from "../src/index";

const makeEvent = (overrides: Partial<LifecycleEvent> = {}): LifecycleEvent => {
    return {
        connectionId: "conn-1",
        shardKey: "root",
        userId: "user-1",
        ...overrides,
    };
};

describe("connection-lifecycle factories", () => {
    it("onConnect tags an internal mutation marked `connect`", () => {
        expect.assertions(3);

        const hook = onConnect(() => undefined);

        expect(hook.kind).toBe("mutation");
        expect(hook.visibility).toBe("internal");
        expect(hook.lifecycle).toBe("connect");
    });

    it("onDisconnect tags an internal mutation marked `disconnect`", () => {
        expect.assertions(3);

        const hook = onDisconnect(() => undefined);

        expect(hook.kind).toBe("mutation");
        expect(hook.visibility).toBe("internal");
        expect(hook.lifecycle).toBe("disconnect");
    });

    it("forwards the lifecycle event verbatim to the handler", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: MutationContext, event: LifecycleEvent) => void>();
        const hook = onConnect(handler);

        const context = {} as MutationContext;
        const event = makeEvent({ context: { roomId: "room-1" } });

        await hook.handler(context, event as unknown as never);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(context, event);
    });
});
