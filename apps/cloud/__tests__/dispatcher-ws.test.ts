import { describe, expect, it, vi } from "vitest";

import dispatcher from "../src/dispatcher/worker";
import type { AnalyticsEngineDataset } from "../src/metering/analytics";

/**
 * Dispatcher WebSocket pass-through (CLOUD-PLAN.md §6 risk #3 spike). The hottest
 * Cirrus path is the hibernated-WS subscription, served at `/_cirrus/ws`. Through
 * Workers for Platforms that upgrade must traverse `env.DISPATCHER.get(script)
 * .fetch(request)` and the resulting 101 response (carrying `webSocket`) must be
 * returned to the eyeball UNCHANGED. These tests pin that forwarding contract for
 * the dispatcher we own; the end-to-end behaviour against a live dispatch
 * namespace is validated by `spikes/ws-dispatch` (see its README).
 */

const upgrade = (host = "acme.cirrus.app"): Request => new Request(`https://${host}/_cirrus/ws?shard=default`, { headers: { Upgrade: "websocket" } });

interface FakeEnv {
    CIRRUS_APP_DOMAIN: string;
    DISPATCHER: { get: ReturnType<typeof vi.fn> };
    USAGE_ANALYTICS?: AnalyticsEngineDataset;
}

const makeEnv = (fetchImpl: (request: Request) => Promise<Response>, analytics?: AnalyticsEngineDataset): FakeEnv => {
    return {
        CIRRUS_APP_DOMAIN: "cirrus.app",
        DISPATCHER: { get: vi.fn().mockReturnValue({ fetch: fetchImpl }) },
        USAGE_ANALYTICS: analytics,
    };
};

describe("dispatcher WebSocket pass-through", () => {
    it("returns the tenant's 101 + webSocket response unchanged", async () => {
        // A real upgrade response carries a live `webSocket`; model it with a
        // sentinel and assert identity (the dispatcher must not reconstruct it).
        const socket = { sentinel: true };
        const upgraded = { status: 101, webSocket: socket } as unknown as Response;
        const env = makeEnv(() => Promise.resolve(upgraded));

        const response = await dispatcher.fetch(upgrade(), env as never);

        expect(response).toBe(upgraded);
        expect((response as unknown as { webSocket: unknown }).webSocket).toBe(socket);
    });

    it("dispatches the upgrade with per-plan limits and meters it once", async () => {
        const writeDataPoint = vi.fn();
        const env = makeEnv(() => Promise.resolve({ status: 101, webSocket: {} } as unknown as Response), { writeDataPoint });

        await dispatcher.fetch(upgrade(), env as never);

        // free-tier limits are applied to the dispatched invocation…
        expect(env.DISPATCHER.get).toHaveBeenCalledWith("acme", undefined, { limits: { cpuMs: 50, subRequests: 50 } });
        // …and the upgrade is metered exactly once (per-message invocations are
        // metered inside the DO, not re-counted on every frame here).
        expect(writeDataPoint).toHaveBeenCalledTimes(1);
        expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ["acme", "free"], doubles: [1], indexes: ["acme"] });
    });

    it("404s an upgrade to an unknown hostname without calling the namespace", async () => {
        const get = vi.fn();
        const response = await dispatcher.fetch(upgrade("cirrus.app"), { CIRRUS_APP_DOMAIN: "cirrus.app", DISPATCHER: { get } });

        expect(response.status).toBe(404);
        expect(get).not.toHaveBeenCalled();
    });
});
