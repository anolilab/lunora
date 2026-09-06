import { afterEach, describe, expect, it, vi } from "vitest";

import resolveAgentRun from "../src/resolve-run";
import type { AgentFunctionReference, AgentRunFunction } from "../src/types";

const DISPATCH_ENV = { LUNORA_ADMIN_TOKEN: "admin-token", LUNORA_ORIGIN_URL: "https://app.example/" };

/** A sentinel dispatcher so the ownerless branch can be asserted by reference identity. */
const sentinelRun: AgentRunFunction = async () => "sentinel";

const messagesRef: AgentFunctionReference = { __lunoraRef: "agents:agentMessages" };

describe(resolveAgentRun, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns the identity-free context dispatcher verbatim for an ownerless run", () => {
        // No owner → the thread's gate is already open, so the loop must keep the
        // exact `context.run` it was given (no new dispatcher, no fetch).
        expect(resolveAgentRun(sentinelRun, undefined, DISPATCH_ENV)).toBe(sentinelRun);
    });

    it("forwards the owner as x-lunora-userid so owner-gated reads are admitted", async () => {
        let capturedUrl = "";
        let capturedHeaders: Record<string, string> = {};
        let capturedBody = "";

        const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) => {
            capturedUrl = url;
            capturedHeaders = init.headers as Record<string, string>;
            capturedBody = init.body as string;

            // The shard's real transport envelope — the loop's `listMessages`
            // read gets the ARRAY back only because the runner unwraps it.
            return Response.json({ result: [{ content: "hi" }] });
        });

        vi.stubGlobal("fetch", fetchSpy);

        const run = resolveAgentRun(sentinelRun, "user-a", DISPATCH_ENV);

        // Owner-scoped → a fresh identity-carrying dispatcher, NOT `context.run`.
        expect(run).not.toBe(sentinelRun);

        const result = await run(messagesRef, { key: "thread-1" });

        // The dispatched read reaches the scheduler endpoint and — the point of
        // the fix — is attributed to the verified owner via `x-lunora-userid`, so
        // the owner gate admits it. (The admin-bearer auth header is the
        // dispatcher's own concern, covered by `@lunora/dispatch`'s suite.)
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(capturedUrl).toBe("https://app.example/_lunora/scheduler/dispatch");
        expect(capturedHeaders["x-lunora-userid"]).toBe("user-a");
        expect(JSON.parse(capturedBody)).toStrictEqual({ args: { key: "thread-1" }, functionPath: "agents:agentMessages" });

        // The dispatcher resolves the function's own return value, unwrapped out
        // of the `{ result }` envelope — not the envelope.
        expect(result).toStrictEqual([{ content: "hi" }]);
    });
});
