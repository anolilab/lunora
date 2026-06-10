import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import devVariablesPlugin from "../src/dev-variables-plugin";
import { cirrus } from "../src/index";

const RESOLVED = (projectRoot: string) => {
    return {
        apiSpec: "openapi" as const,
        cloudflare: {} as never,
        generatedDir: "cirrus/_generated",
        overlay: false as const,
        projectRoot,
        schemaDir: "cirrus",
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
        dir = mkdtempSync(join(tmpdir(), "cirrus-vite-devvars-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("is a pre-enforced, serve-only plugin", () => {
        expect.assertions(3);

        const plugin = devVariablesPlugin(RESOLVED(dir));

        expect(plugin.name).toBe("cirrus:dev-vars");
        expect(plugin.enforce).toBe("pre");
        expect(plugin.apply).toBe("serve");
    });

    it("does not prompt or write in a non-interactive context", async () => {
        expect.assertions(1);

        writeFileSync(join(dir, ".dev.vars.example"), 'AUTH_SECRET="replace-me-openssl"\n', "utf8");
        // stdin is not a TTY in the test runner → confirm resolves false → nothing written.
        await runConfigResolved(devVariablesPlugin(RESOLVED(dir)));

        expect(existsSync(join(dir, ".dev.vars"))).toBe(false);
    });

    it("is among the leading plugins so it scaffolds `.dev.vars` before the worker boots", () => {
        expect.assertions(3);

        const plugins = cirrus({ cloudflare: false, overlay: false, projectRoot: dir, validateWrangler: false });
        const names = plugins.map((plugin) => plugin.name);

        // The command probe leads (it must capture serve/build first); dev-vars
        // follows, still ahead of codegen and the worker plugins.
        expect(names[0]).toBe("cirrus:command-probe");
        expect(names).toContain("cirrus:dev-vars");
        expect(names.indexOf("cirrus:dev-vars")).toBeLessThan(names.indexOf("cirrus:codegen"));
    });
});
