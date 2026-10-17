import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * A route topic's delivery is re-checked against the route as it is now. A socket that upgraded
 * anonymously before a deploy made the route require auth must stop receiving that route's broadcasts.
 */
describe("defineWebSocket route topic gate (workerd)", () => {
    it("stops delivering a route topic to an anonymous socket once the route requires auth", async () => {
        expect.assertions(4);

        const stub = env.SYNC.get(env.SYNC.idFromName("socket-route-gate"));
        const topic = "__lunora_socket__:sockets:wake";

        await expect(stub.routeTopicGate("/chat-wake", undefined, topic)).resolves.toBe(true);

        await stub.setWakeRouteAuth(true);

        await expect(stub.routeTopicGate("/chat-wake", undefined, topic)).resolves.toBe(false);
        await expect(stub.routeTopicGate("/chat-wake", "u1", topic)).resolves.toBe(true);
        await expect(stub.routeTopicGate("/other", undefined, topic)).resolves.toBe(false);
    });
});
