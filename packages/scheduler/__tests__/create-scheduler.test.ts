import { describe, expect, it, vi } from "vitest";

import createScheduler from "../src/create-scheduler.js";
import { createCronTrigger } from "../src/cron.js";
import type { DurableObjectNamespaceLike, DurableObjectStubLike, FunctionReference } from "../src/types.js";

const NAMESPACE_PATTERN = /namespace/;
const ORIGIN_URL_PATTERN = /originUrl/;
const DELAY_MS_PATTERN = /delayMs/;
const SCHEDULER_DO_PATTERN = /SchedulerDO/;

interface CapturedCall {
    body: Record<string, unknown>;
    url: string;
}

const fakeNamespace = (
    responses: Record<string, unknown> = { "/cancel": { cancelled: true }, "/schedule": { id: "id-1", scheduledFor: 12_345 } },
): { calls: CapturedCall[]; namespace: DurableObjectNamespaceLike } => {
    const calls: CapturedCall[] = [];
    const stub = {
        fetch: vi.fn<DurableObjectStubLike["fetch"]>(async (input: Request | string, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.url;
            const body = init?.body ? JSON.parse(init.body as string) : {};
            const path = new URL(url).pathname;

            calls.push({ body, url });

            const responseBody = responses[path] ?? { ok: true };

            return Response.json(responseBody, { headers: { "content-type": "application/json" }, status: 200 });
        }),
    };
    const namespace: DurableObjectNamespaceLike = {
        get: vi.fn<DurableObjectNamespaceLike["get"]>(() => stub),
        idFromName: vi.fn<DurableObjectNamespaceLike["idFromName"]>((name: string) => {
            return { toString: () => name };
        }),
    };

    return { calls, namespace };
};

const function_: FunctionReference = { __cirrusRef: "messages.send" };

describe("createScheduler", () => {
    it("requires a namespace + originUrl", () => {
        expect.assertions(2);

        expect(() => createScheduler({} as never)).toThrow(NAMESPACE_PATTERN);
        expect(() => createScheduler({ namespace: fakeNamespace().namespace } as never)).toThrow(ORIGIN_URL_PATTERN);
    });

    it("runAt() forwards the RPC envelope to SchedulerDO", async () => {
        expect.assertions(3);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });
        const at = new Date("2026-06-01T12:00:00Z");

        const result = await scheduler.runAt(at, function_, { userId: "u-1" });

        expect(result).toEqual({ id: "id-1", scheduledFor: 12_345 });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.body).toEqual({
            args: { userId: "u-1" },
            functionPath: "messages.send",
            originUrl: "https://app.test",
            scheduledFor: at.getTime(),
            shardKey: undefined,
        });
    });

    it("runAfter() rejects negative or non-finite delays", async () => {
        expect.assertions(2);

        const { namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        await expect(scheduler.runAfter(-1, function_, {})).rejects.toThrow(DELAY_MS_PATTERN);
        await expect(scheduler.runAfter(Number.NaN, function_, {})).rejects.toThrow(DELAY_MS_PATTERN);
    });

    it("runAfter() computes scheduledFor relative to now()", async () => {
        expect.assertions(3);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        const before = Date.now();

        await scheduler.runAfter(5000, function_, { x: 1 }, { shardKey: "u-1" });
        const after = Date.now();

        const scheduledFor = calls[0]?.body.scheduledFor as number;

        expect(scheduledFor).toBeGreaterThanOrEqual(before + 5000);
        expect(scheduledFor).toBeLessThanOrEqual(after + 5000);
        expect(calls[0]?.body.shardKey).toBe("u-1");
    });

    it("cancel() forwards the id", async () => {
        expect.assertions(3);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        const result = await scheduler.cancel("abc");

        expect(result).toEqual({ cancelled: true });
        expect(calls[0]?.body).toEqual({ id: "abc" });
        expect(new URL(calls[0]!.url).pathname).toBe("/cancel");
    });

    it("throws when SchedulerDO returns a non-2xx response", async () => {
        expect.assertions(1);

        const stub = {
            fetch: vi.fn<DurableObjectStubLike["fetch"]>(async () => new Response("nope", { status: 500 })),
        };
        const namespace: DurableObjectNamespaceLike = {
            get: () => stub,
            idFromName: () => {
                return { toString: () => "default" };
            },
        };
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        await expect(scheduler.runAfter(0, function_, {})).rejects.toThrow(SCHEDULER_DO_PATTERN);
    });

    it("createCronTrigger emits a wrangler.jsonc snippet + dispatcher metadata", () => {
        expect.assertions(3);

        const snippet = createCronTrigger({ args: { tenant: "acme" }, fn: function_, schedule: "0 * * * *" });

        expect(snippet.crons).toEqual(["0 * * * *"]);
        expect(snippet.dispatcher).toEqual({ args: { tenant: "acme" }, functionPath: "messages.send" });
        expect(snippet.wranglerJsonc).toContain('"0 * * * *"');
    });

    it("createCronTrigger validates inputs", () => {
        expect.assertions(2);

        expect(() => createCronTrigger({ fn: function_, schedule: "" })).toThrow();
        // @ts-expect-error - intentional misuse
        expect(() => createCronTrigger({ schedule: "0 * * * *" })).toThrow();
    });
});
