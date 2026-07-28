import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import devVariablesPlugin from "../src/dev-variables-plugin";
import { lunora } from "../src/index";

const RESOLVED = (projectRoot: string) => {
    return {
        allowUnauthenticatedShardAccess: false as const,
        apiSpec: "openapi" as const,
        cloudflare: {} as never,
        generatedDir: "lunora/_generated",
        overlay: false as const,
        projectRoot,
        schemaDir: "lunora",
        target: "cloudflare",
        studio: true,
        validateWrangler: false,
    };
};

/** Drive the plugin's `configResolved` hook (the only place it acts). */
const runConfigResolved = async (plugin: Plugin): Promise<void> => {
    const hook = plugin.configResolved;
    const fn = typeof hook === "function" ? hook : hook?.handler;

    await (fn as (config: unknown) => Promise<void>).call(plugin, {});
};

describe("devVariablesPlugin", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "lunora-vite-devvars-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("is a pre-enforced, serve-only plugin", () => {
        expect.assertions(3);

        const plugin = devVariablesPlugin(RESOLVED(dir));

        expect(plugin.name).toBe("lunora:dev-vars");
        expect(plugin.enforce).toBe("pre");
        expect(plugin.apply).toBe("serve");
    });

    it("does not scaffold the example's secrets without a prompt, but still ensures the admin token", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars.example"), 'AUTH_SECRET="replace-me-openssl"\n', "utf8");
        // stdin is not a TTY in the test runner → ensureDevVariables's confirm
        // resolves false → the example's AUTH_SECRET is NOT scaffolded. But
        // fillDevSecrets still ensures the (locally-generated) admin token, since
        // the Studio needs it and there's nothing to prompt about.
        await runConfigResolved(devVariablesPlugin(RESOLVED(dir)));

        const content = existsSync(join(dir, ".dev.vars")) ? readFileSync(join(dir, ".dev.vars"), "utf8") : "";

        expect(content).toContain("LUNORA_ADMIN_TOKEN=");
        // The example secret stays unscaffolded — it needs the (declined) prompt.
        expect(content).not.toContain("AUTH_SECRET=");
    });

    it("fills an empty feature-scaffolded secret + the admin token on dev (no prompt)", async () => {
        expect.assertions(3);

        // What `lunora add auth` writes into .dev.vars directly: a blank secret, no admin token.
        writeFileSync(join(dir, ".dev.vars"), "BETTER_AUTH_SECRET=\n", "utf8");

        await runConfigResolved(devVariablesPlugin(RESOLVED(dir)));

        const content = readFileSync(join(dir, ".dev.vars"), "utf8");

        // The blank secret is now filled with a generated value (64 hex chars).
        expect(content).toMatch(/BETTER_AUTH_SECRET="[a-f0-9]{64}"/u);
        // The Studio admin token is appended + generated.
        expect(content).toMatch(/LUNORA_ADMIN_TOKEN="[a-f0-9]{64}"/u);
        expect(content).toContain("BETTER_AUTH_SECRET=");
    });

    it("is among the leading plugins so it scaffolds `.dev.vars` before the worker boots", () => {
        expect.assertions(3);

        const plugins = lunora({ cloudflare: false, overlay: false, projectRoot: dir, validateWrangler: false });
        const names = plugins.map((plugin) => plugin.name);

        // The command probe leads (it must capture serve/build first); dev-vars
        // follows, still ahead of codegen and the worker plugins.
        expect(names[0]).toBe("lunora:command-probe");
        expect(names).toContain("lunora:dev-vars");
        expect(names.indexOf("lunora:dev-vars")).toBeLessThan(names.indexOf("lunora:codegen"));
    });
});
