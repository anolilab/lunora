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
