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

describe("cLOUDFLARE_DRIVER toolchain", () => {
    const { toolchain } = CLOUDFLARE_DRIVER;

    it("builds the deploy argv, matching wrangler's expected flag order", () => {
        expect.assertions(2);

        expect(toolchain?.deploy({})).toStrictEqual({ args: ["deploy"], tool: "wrangler" });
        // Entry positional precedes flags; `--metafile` always rides with `--outdir`.
        expect(toolchain?.deploy({ dryRun: true, entry: "src/worker.ts", environment: "prod", outDir: "dist", temporary: true }).args).toStrictEqual([
            "deploy",
            "src/worker.ts",
            "--env",
            "prod",
            "--temporary",
            "--dry-run",
            "--outdir",
            "dist",
            "--metafile",
        ]);
    });

    // A preview must never take production traffic, so it maps to a different
    // wrangler subcommand rather than a flag on `deploy`.
    it("maps a preview deploy onto versions upload", () => {
        expect.assertions(1);

        expect(toolchain?.deploy({ preview: true }).args).toStrictEqual(["versions", "upload"]);
    });

    it("builds tail argv with the worker positional before flags", () => {
        expect.assertions(1);

        expect(toolchain?.tail?.({ environment: "prod", format: "json", search: "boom", status: "error", worker: "api" })?.args).toStrictEqual([
            "tail",
            "api",
            "--env",
            "prod",
            "--format",
            "json",
            "--status",
            "error",
            "--search",
            "boom",
        ]);
    });

    // The value is never in argv — it goes over stdin — so only the key appears.
    it("builds secret argv without ever placing a value on the command line", () => {
        expect.assertions(2);

        const put = toolchain?.secretPut?.({ environment: "prod", key: "STRIPE_KEY" });

        expect(put?.args).toStrictEqual(["secret", "put", "STRIPE_KEY", "--env", "prod"]);
        expect(toolchain?.secretList?.({})?.args).toStrictEqual(["secret", "list", "--format", "json"]);
    });

    it("builds dev argv with the generated config and caller flags", () => {
        expect.assertions(1);

        expect(toolchain?.dev({ configPath: "wrangler.dev.jsonc", extraArgs: ["--var", "X:1"] }).args).toStrictEqual([
            "dev",
            "--config",
            "wrangler.dev.jsonc",
            "--var",
            "X:1",
        ]);
    });
});
