import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Not part of codegen's public API: this drift guard needs the binding codegen declares.
import { companionServiceBinding } from "../../codegen/src/discover/service-bindings";
import { createWorker } from "../src/create-worker";

// The route reads the binding by name and codegen declares it by name; neither imports the other, so a
// rename on one side would silently turn the route into a permanent 404.
describe("advisor companion binding name", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-binding-name-"));
        mkdirSync(join(root, "lunora"));
        writeFileSync(join(root, "lunora.config.ts"), "export default { studio: { companion: true } };\n", "utf8");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("is the binding the runtime route forwards to", async () => {
        expect.assertions(2);

        const companionFetch = vi.fn(async (_request: Request) => new Response("{}", { status: 200 }));
        const worker = createWorker({
            adminToken: "t",
            shardDO: { get: () => {return { fetch: async () => new Response("not used") }}, idFromName: (name) => {return { __name: name }} },
        });
        const env = { [companionServiceBinding(root)?.binding ?? "undeclared"]: { fetch: companionFetch } };
        const response = await worker.fetch(new Request("https://app.example/__lunora/advisor-procedures", { headers: { authorization: "Bearer t" } }), env, {
            passThroughOnException: () => undefined,
            waitUntil: () => undefined,
        });

        expect(response.status).toBe(200);
        expect(companionFetch).toHaveBeenCalledTimes(1);
    });
});
