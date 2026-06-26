import { describe, expect, it, vi } from "vitest";

import { createPipelines } from "../../src/analytics/create-pipelines";

describe("createPipelines", () => {
    it("wraps a single record in an array for the binding", async () => {
        const send = vi.fn(async () => {});
        const pipelines = createPipelines({ binding: { send } });

        await pipelines.send({ event: "purchase", userId: "1" });

        expect(send).toHaveBeenCalledWith([{ event: "purchase", userId: "1" }]);
    });

    it("forwards an array of records unchanged", async () => {
        const send = vi.fn(async () => {});
        const pipelines = createPipelines({ binding: { send } });

        await pipelines.send([{ n: 1 }, { n: 2 }]);

        expect(send).toHaveBeenCalledWith([{ n: 1 }, { n: 2 }]);
    });
});
