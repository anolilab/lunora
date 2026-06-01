import { describe, expect, test, vi } from "vitest";

import { createScheduler } from "../src/create-scheduler.js";
import { createCronTrigger } from "../src/cron.js";
import type { DurableObjectNamespaceLike, DurableObjectStubLike, FunctionReference } from "../src/types.js";

interface CapturedCall {
    body: Record<string, unknown>;
    url: string;
}

const fakeNamespace = (
    responses: Record<string, unknown> = { "/schedule": { id: "id-1", scheduledFor: 12_345 }, "/cancel": { cancelled: true } },
): { calls: CapturedCall[]; namespace: DurableObjectNamespaceLike } => {
    const calls: CapturedCall[] = [];
    const stub = {
        fetch: vi.fn<DurableObjectStubLike["fetch"]>(async (input: Request | string, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.url;
            const body = init?.body ? JSON.parse(init.body as string) : {};
            const path = new URL(url).pathname;

            calls.push({ url, body });

            const responseBody = responses[path] ?? { ok: true };

            return Response.json(responseBody, { status: 200, headers: { "content-type": "application/json" } });
        }),
    };
    const namespace: DurableObjectNamespaceLike = {
        idFromName: vi.fn<DurableObjectNamespaceLike["idFromName"]>((name: string) => ({ toString: () => name })),
        get: vi.fn<DurableObjectNamespaceLike["get"]>(() => stub),
    };

    return { namespace, calls };
};

const fn: FunctionReference = { __cirrusRef: "messages.send" };

describe("createScheduler", () => {
    test("requires a namespace + originUrl", () => {
        expect.assertions(2);

        expect(() => createScheduler({} as never)).toThrow(/namespace/);
        expect(() => createScheduler({ namespace: fakeNamespace().namespace } as never)).toThrow(/originUrl/);
    });

    test("runAt() forwards the RPC envelope to SchedulerDO", async () => {
        expect.assertions(3);

        const { namespace, calls } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });
        const at = new Date("2026-06-01T12:00:00Z");

        const result = await scheduler.runAt(at, fn, { userId: "u-1" });

        expect(result).toEqual({ id: "id-1", scheduledFor: 12_345 });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.body).toEqual({
            functionPath: "messages.send",
            args: { userId: "u-1" },
            scheduledFor: at.getTime(),
            shardKey: undefined,
            originUrl: "https://app.test",
        });
    });

    test("runAfter() rejects negative or non-finite delays", async () => {
        expect.assertions(2);

        const { namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        await expect(scheduler.runAfter(-1, fn, {} as Record<string, unknown>)).rejects.toThrow(/delayMs/);
        await expect(scheduler.runAfter(Number.NaN, fn, {} as Record<string, unknown>)).rejects.toThrow(/delayMs/);
    });

    test("runAfter() computes scheduledFor relative to now()", async () => {
        expect.assertions(3);

        const { namespace, calls } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        const before = Date.now();

        await scheduler.runAfter(5000, fn, { x: 1 } as Record<string, unknown>, { shardKey: "u-1" });
        const after = Date.now();

        const scheduledFor = calls[0]?.body.scheduledFor as number;

        expect(scheduledFor).toBeGreaterThanOrEqual(before + 5000);
        expect(scheduledFor).toBeLessThanOrEqual(after + 5000);
        expect(calls[0]?.body.shardKey).toBe("u-1");
    });

    test("cancel() forwards the id", async () => {
        expect.assertions(3);

        const { namespace, calls } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        const result = await scheduler.cancel("abc");

        expect(result).toEqual({ cancelled: true });
        expect(calls[0]?.body).toEqual({ id: "abc" });
        expect(new URL(calls[0]!.url).pathname).toBe("/cancel");
    });

    test("throws when SchedulerDO returns a non-2xx response", async () => {
        expect.assertions(1);

        const stub = {
            fetch: vi.fn<DurableObjectStubLike["fetch"]>(async () => new Response("nope", { status: 500 })),
        };
        const namespace: DurableObjectNamespaceLike = {
            idFromName: () => ({ toString: () => "default" }),
            get: () => stub,
        };
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        await expect(scheduler.runAfter(0, fn, {} as Record<string, unknown>)).rejects.toThrow(/SchedulerDO/);
    });

    test("createCronTrigger emits a wrangler.jsonc snippet + dispatcher metadata", () => {
        expect.assertions(3);

        const snippet = createCronTrigger({ schedule: "0 * * * *", fn, args: { tenant: "acme" } });

        expect(snippet.crons).toEqual(["0 * * * *"]);
        expect(snippet.dispatcher).toEqual({ functionPath: "messages.send", args: { tenant: "acme" } });
        expect(snippet.wranglerJsonc).toContain('"0 * * * *"');
    });

    test("createCronTrigger validates inputs", () => {
        expect.assertions(2);

        expect(() => createCronTrigger({ schedule: "", fn })).toThrow();
        // @ts-expect-error - intentional misuse
        expect(() => createCronTrigger({ schedule: "0 * * * *" })).toThrow();
    });
});
