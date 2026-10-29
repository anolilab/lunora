import { describe, expect, it } from "vitest";

describe("@lunora/mcp/node exports", () => {
    it("exposes the stdio connector for the per-function server", async () => {
        expect.assertions(2);

        const node = await import("../src/node/index");

        expect(node.connectFunctionStdio).toBeTypeOf("function");
        expect(node.connectStdio).toBeTypeOf("function");
    });
});
