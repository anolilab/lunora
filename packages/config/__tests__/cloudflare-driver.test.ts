import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import CLOUDFLARE_DRIVER from "../src/cloudflare-driver";

const WRANGLER = `{
    "name": "app",
    "main": "src/server/index.ts",
    "compatibility_date": "2026-04-07"
}
`;

const ENTRY_SHARD_ONLY = `import { createShardDO } from "../../lunora/_generated/shard.js";

export const ShardDO = createShardDO({});

export default { fetch() { return new Response("ok"); } };
`;

const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
    users: defineTable({ email: v.string() }).global(),
});
`;

describe("cLOUDFLARE_DRIVER", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-driver-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const write = (relativePath: string, content: string): void => {
        const fullPath = join(root, relativePath);

        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(fullPath, content, "utf8");
    };

    it("identifies itself as the cloudflare target", () => {
        expect.assertions(1);

        expect(CLOUDFLARE_DRIVER.id).toBe("cloudflare");
    });

    // The projection is the driver's real work: it must carry the app's
    // requirements across in provider-neutral terms, without the wrangler
    // encodings a second target could not use.
    it("projects inferred bindings onto a provider-neutral resource graph", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/schema.ts", SCHEMA_WITH_GLOBAL);

        const graph = await CLOUDFLARE_DRIVER.infer({ crons: ["0 * * * *"], projectRoot: root });

        // A `.global()` table means the app needs a replicated SQL store — stated
        // neutrally, not as "needs the D1 binding".
        expect(graph.globalDatabase).toBe(true);
        expect(graph.shardNamespaces.map((entry: { name: string }) => entry.name)).toContain("SHARD");
        // Crons come from the app's code, so the driver threads them through.
        expect(graph.crons).toStrictEqual(["0 * * * *"]);
    });

    it("infer never writes configuration", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const before = readFileSync(join(root, "wrangler.jsonc"), "utf8");
        await CLOUDFLARE_DRIVER.infer({ projectRoot: root });

        expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toBe(before);
    });

    it("provisions the wrangler config, and is idempotent on a second run", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const first = await CLOUDFLARE_DRIVER.provision({ projectRoot: root });

        expect(first.changed).toBe(true);

        // Re-provisioning an already-provisioned project must be a no-op — the
        // contract's idempotence requirement, and what makes `prepare` safe to
        // re-run in CI.
        const second = await CLOUDFLARE_DRIVER.provision({ projectRoot: root });

        expect(second.changed).toBe(false);
    });

    // A driver folds a failed step into a warning: `prepare` relies on this to
    // reach `validateWrangler`, which is the real gate on a missing requirement.
    it("reports a warning instead of throwing when there is nothing to provision", async () => {
        expect.assertions(2);

        const result = await CLOUDFLARE_DRIVER.provision({ projectRoot: root });

        expect(result.changed).toBe(false);
        expect(Array.isArray(result.warnings)).toBe(true);
    });
});
