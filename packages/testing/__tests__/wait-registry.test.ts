import { describe, expect, it } from "vitest";

import WaitRegistry from "../src/wait-registry";

describe("waitRegistry — awaitWait", () => {
    it("resolves for a wait the run already reached and consumed before the test asked", async () => {
        expect.hasAssertions();

        const registry = new WaitRegistry([]);
        const waited = registry.wait("run-1", "go", "go-type");

        registry.deliver("run-1", "go", { ok: true });

        await expect(waited).resolves.toStrictEqual({ ok: true });

        // The run is already past its wait; the observer must not hang on it.
        await expect(registry.awaitWait("run-1", "go")).resolves.toBeUndefined();
    });
});

describe("waitRegistry — late deliveries", () => {
    it("drops a delivery that arrives after expiry instead of holding it for the run's next wait", async () => {
        expect.hasAssertions();

        const registry = new WaitRegistry([]);
        const timedOut = registry.wait("run-1", "go", "go-type");

        registry.expire("run-1", "go");

        await expect(timedOut).rejects.toThrow("timed out");

        // The event is late: the run no longer awaits it, so it must not satisfy the next wait.
        registry.deliver("run-1", "go", { stale: true });

        const next = registry.wait("run-1", "go", "go-type");

        registry.deliver("run-1", "go", { fresh: true });

        await expect(next).resolves.toStrictEqual({ fresh: true });
    });

    it("still holds an event delivered before the run's first wait", async () => {
        expect.hasAssertions();

        const registry = new WaitRegistry([]);

        registry.deliver("run-1", "go", { early: true });

        await expect(registry.wait("run-1", "go", "go-type")).resolves.toStrictEqual({ early: true });
    });
});
