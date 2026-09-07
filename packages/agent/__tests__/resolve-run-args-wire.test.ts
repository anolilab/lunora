/**
 * The agent loop's dispatcher is `@lunora/dispatch`'s runner (built here by
 * `resolveAgentRun`, and identically by `createAgentContext` and the voice DO's
 * `resolveRun`), POSTing to `/_lunora/scheduler/dispatch`. The shard's dispatch
 * loop decodes the body's `args` exactly once
 * (`decodeWire(payload.args ?? {})`), so this end has to encode: without it a
 * `bigint` throws in `JSON.stringify` before the request leaves, and a `Date`
 * reaches the handler as an ISO string.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
import resolveAgentRun from "../src/resolve-run";
import type { AgentFunctionReference, AgentRunFunction } from "../src/types";

const ENV = { LUNORA_ADMIN_TOKEN: "admin-token", LUNORA_ORIGIN_URL: "https://app.example" };
const REF: AgentFunctionReference = { __lunoraRef: "agents:agentAppendMessage" };

/** Never reached — the owner branch always builds a fresh dispatcher. */
const contextRun: AgentRunFunction = async () => undefined;

/** Dispatch `args` through the owner-scoped agent runner and hand back what the shard's single decode gives the handler. */
const handlerArgs = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let body = "";

    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        body = init.body as string;

        return new Response(null, { status: 200 });
    });

    await resolveAgentRun(contextRun, "user-a", ENV)(REF, args);

    return decodeWire((JSON.parse(body) as { args?: unknown }).args ?? {}) as Record<string, unknown>;
};

describe("agent dispatch args wire", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("delivers a bigint argument to the handler as a bigint", async () => {
        expect.assertions(2);

        const args = await handlerArgs({ amountCents: 4_294_967_296n });

        expect(args["amountCents"]).toBeTypeOf("bigint");
        expect(args["amountCents"]).toBe(4_294_967_296n);
    });

    it("delivers a Date argument to the handler as a Date", async () => {
        expect.assertions(2);

        // Assert the TYPE: an un-encoded `Date` arrives as an ISO string and
        // nothing throws, so only the type catches it.
        const args = await handlerArgs({ dueAt: new Date("2026-06-01T12:00:00.000Z") });

        expect(args["dueAt"]).toBeInstanceOf(Date);
        expect((args["dueAt"] as Date).toISOString()).toBe("2026-06-01T12:00:00.000Z");
    });

    it("leaves pure-JSON args untouched at the handler", async () => {
        expect.assertions(1);

        const plain = { count: 3, flag: true, nested: { items: [1, 2, "three"], missing: null } };

        await expect(handlerArgs(plain)).resolves.toStrictEqual(plain);
    });
});
