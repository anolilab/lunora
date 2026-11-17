import { describe, expect, it } from "vitest";

import { createReferenceHost } from "../src/conformance";

describe("createReferenceHost scheduler", () => {
    it("refuses retry.forever as a coded INVALID_INPUT, which a shard outbox parks rather than re-offers", async () => {
        expect.assertions(1);

        const host = createReferenceHost();

        try {
            await expect(host.scheduler?.schedule("jobs:sync", {}, { retry: { forever: true } })).rejects.toMatchObject({
                code: "INVALID_INPUT",
                status: 400,
                type: "VisulimaError",
            });
        } finally {
            host.cleanup?.();
        }
    });
});
