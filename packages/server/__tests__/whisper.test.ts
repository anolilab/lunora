import { describe, expect, it, vi } from "vitest";

import type { QueryCtx as QueryContext, WhisperEvent } from "../src/index";
import { onWhisper } from "../src/index";

const makeEvent = (overrides: Partial<WhisperEvent> = {}): WhisperEvent => {
    return {
        action: "subscribe",
        connectionId: "conn-1",
        shardKey: "root",
        topic: "room:r1",
        userId: "user-1",
        ...overrides,
    };
};

describe("onWhisper", () => {
    it("tags an internal query marked `whisper`", () => {
        expect.assertions(3);

        const authorizer = onWhisper(() => true);

        // A QUERY, not a mutation: the shard re-runs this check, and a check that
        // can write is a check you cannot safely re-run.
        expect(authorizer.kind).toBe("query");
        expect(authorizer.visibility).toBe("internal");
        expect(authorizer.lifecycle).toBe("whisper");
    });

    it("forwards the whisper event verbatim to the handler", async () => {
        expect.assertions(2);

        const handler = vi.fn<(context: QueryContext, event: WhisperEvent) => boolean>().mockReturnValue(true);
        const authorizer = onWhisper(handler);
        const context = {} as QueryContext;
        const event = makeEvent({ action: "send", topic: "cursors" });

        await authorizer.handler(context, event as unknown as Record<string, never>);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(context, event);
    });

    it.each([
        ["a literal true", true, true],
        ["a literal false", false, false],
        ["an undefined return", undefined, false],
        ["a truthy row object", { _id: "row" }, false],
        ["a non-empty string", "yes", false],
        ["zero", 0, false],
    ])("normalises %s to a strict verdict", async (_label, returned, expected) => {
        expect.assertions(1);

        // Only a literal `true` allows. Collapsing every truthy value would silently
        // widen "I found a membership row" into an allow for a handler that meant to
        // return the row, not a verdict.
        const authorizer = onWhisper(() => returned as boolean);

        await expect(authorizer.handler({}, makeEvent() as unknown as Record<string, never>)).resolves.toBe(expected);
    });

    it("propagates a throwing handler so the shard can deny on it", async () => {
        expect.assertions(1);

        const authorizer = onWhisper(() => {
            throw new Error("membership lookup failed");
        });

        // Deliberately NOT swallowed here: the shard logs the path alongside the
        // failure and denies. Swallowing it to `false` would lose the diagnostic.
        await expect(authorizer.handler({}, makeEvent() as unknown as Record<string, never>)).rejects.toThrow("membership lookup failed");
    });
});
