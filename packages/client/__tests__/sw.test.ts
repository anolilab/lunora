import { describe, expect, it } from "vitest";

import { createReply, sendToSw } from "../src/sw/message-bridge";

// ─── message-bridge ──────────────────────────────────────────────────

describe("createReply", () => {
    it("replies with type:reply and echoes correlationId", () => {
        expect.hasAssertions();

        const reply = createReply({ type: "ping", correlationId: "abc-123" }, { ok: true });

        expect(reply).toEqual({
            type: "ping:reply",
            correlationId: "abc-123",
            payload: { ok: true },
        });
    });

    it("works without a correlationId", () => {
        expect.hasAssertions();

        const reply = createReply({ type: "fire-and-forget" });

        expect(reply.type).toBe("fire-and-forget:reply");
        expect(reply.payload).toBeUndefined();
        expect(reply.correlationId).toBeUndefined();
    });
});

describe("sendToSw", () => {
    it("rejects when no SW is provided", async () => {
        expect.hasAssertions();

        await expect(sendToSw(null, { type: "test" })).rejects.toThrow("No active service worker");
    });

    it("rejects when expectResponse but no SW", async () => {
        expect.hasAssertions();

        await expect(sendToSw(null, { type: "test" }, true)).rejects.toThrow("No active service worker");
    });
});
