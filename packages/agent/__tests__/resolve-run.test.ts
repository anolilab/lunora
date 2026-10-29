import { afterEach, describe, expect, it, vi } from "vitest";

import resolveAgentRun from "../src/resolve-run";
import type { AgentFunctionReference } from "../src/types";

const DISPATCH_ENV = { LUNORA_ADMIN_TOKEN: "admin-token", LUNORA_ORIGIN_URL: "https://app.example/" };

const messagesRef: AgentFunctionReference = { __lunoraRef: "agents:agentMessages" };

/** Stub `fetch` and hand back what the dispatcher put on the wire. */
const captureDispatch = (): {
    body: () => { args?: unknown; functionPath?: string; id?: string };
    headers: () => Record<string, string>;
    url: () => string;
} => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "{}";

    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            capturedUrl = url;
            capturedHeaders = init.headers as Record<string, string>;
            capturedBody = init.body as string;

            // The shard's envelope (`ShardDO.buildDispatchResponse`) — the
            // dispatcher unwraps `result` and `decodeWire`s it.
            return Response.json({ result: [{ content: "hi" }] });
        }),
    );

    return {
        body: () => JSON.parse(capturedBody) as { args?: unknown; functionPath?: string; id?: string },
        headers: () => capturedHeaders,
        url: () => capturedUrl,
    };
};

describe(resolveAgentRun, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("dispatches an ownerless run with no identity and no replay-dedup id", async () => {
        const captured = captureDispatch();

        const result = await resolveAgentRun(undefined, DISPATCH_ENV)(messagesRef, { key: "thread-1" });

        expect(captured.url()).toBe("https://app.example/_lunora/scheduler/dispatch");
        expect(captured.headers()["x-lunora-userid"]).toBeUndefined();

        // No `id`: the loop makes most of its calls from inside memoized
        // `step.do` callbacks, so any ORDER-numbered dedup id (what the
        // workflow body's `context.run` would attach) is re-issued to a
        // different call on the next activation — and the shard, keyed
        // `(identity, mutationId)` with no function path, answers it with the
        // first call's cached result. The loop's calls are idempotent on their
        // own keys instead. See `resolve-run.ts`.
        expect(captured.body()).toStrictEqual({ args: { key: "thread-1" }, functionPath: "agents:agentMessages" });
        expect(result).toStrictEqual([{ content: "hi" }]);
    });

    it("forwards the owner as x-lunora-userid so owner-gated reads are admitted", async () => {
        const captured = captureDispatch();

        const result = await resolveAgentRun("user-a", DISPATCH_ENV)(messagesRef, { key: "thread-1" });

        // The dispatched read reaches the scheduler endpoint and — the point of
        // the fix — is attributed to the verified owner via `x-lunora-userid`, so
        // the owner gate admits it. (The admin-bearer auth header is the
        // dispatcher's own concern, covered by `@lunora/dispatch`'s suite.)
        expect(captured.url()).toBe("https://app.example/_lunora/scheduler/dispatch");
        expect(captured.headers()["x-lunora-userid"]).toBe("user-a");
        expect(captured.body()).toStrictEqual({ args: { key: "thread-1" }, functionPath: "agents:agentMessages" });

        // The dispatcher resolves the function's RETURN VALUE, not the envelope.
        expect(result).toStrictEqual([{ content: "hi" }]);
    });
});
