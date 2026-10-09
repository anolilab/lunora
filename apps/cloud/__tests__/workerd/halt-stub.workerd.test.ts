/**
 * The emergency stop's stub in real workerd (`src/deploy/halt-stub.ts`): the
 * module `buildHaltStub` generates — written by `vitest.config.ts` from
 * `halt-stub-fixture.ts` and hosted by the test worker — answers 503 on the
 * Worker and on each Durable Object class, and an alarm that fires PARKS
 * itself an hour out instead of running anything, on both SQLite- and
 * KV-backed classes, without touching the object's stored data.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PARK_ALARM_MS } from "../../src/deploy/halt-stub";
import haltStub from "./halt-stub.generated";

const namespaces = [
    ["SQLite-backed", "PARKED_SQLITE"],
    ["KV-backed", "PARKED_KV"],
] as const;

describe("the generated halt stub", () => {
    it("answers every request on the Worker with a 503 naming the reason", async () => {
        const response = haltStub.fetch(new Request("https://acme.lunora.app/api/anything"));

        expect(response.status).toBe(503);
        expect(response.headers.get("content-type")).toBe("application/json");
        await expect(response.json()).resolves.toStrictEqual({ error: "project halted: spend-cap" });
    });

    it.each(namespaces)("answers a %s Durable Object's fetch with the same 503", async (_label, binding) => {
        const stub = env[binding].get(env[binding].idFromName("fetch"));
        const response = await stub.fetch("https://do.internal/increment");

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toStrictEqual({ error: "project halted: spend-cap" });
    });

    it.each(namespaces)("parks a %s Durable Object's alarm an hour out and keeps its data", async (_label, binding) => {
        const stub = env[binding].get(env[binding].idFromName("alarm"));

        await runInDurableObject(stub, async (_instance, state) => {
            await state.storage.put("counter", 41);
            await state.storage.setAlarm(Date.now() + 60_000);
        });

        const before = Date.now();

        await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

        const after = Date.now();
        const { alarm, counter } = await runInDurableObject(stub, async (_instance, state) => {
            return { alarm: await state.storage.getAlarm(), counter: await state.storage.get<number>("counter") };
        });

        expect(alarm).not.toBeNull();
        expect(alarm).toBeGreaterThanOrEqual(before + PARK_ALARM_MS);
        expect(alarm).toBeLessThanOrEqual(after + PARK_ALARM_MS);
        expect(counter).toBe(41);
    });
});
