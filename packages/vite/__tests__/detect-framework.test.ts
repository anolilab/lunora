import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "vite";
import { resolveConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectFramework } from "../src/detect-framework";
import { createPluginContext, formatFrameworkDetection } from "../src/framework-detect-plugin";
import { cirrus } from "../src/index";

let workdir: string;

const SCHEMA = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

const VALID_WRANGLER = `{
    "name": "cirrus-app",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`;

const writePackageJson = (dependencies: Record<string, string>): void => {
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies, name: "fixture" }), "utf8");
};

describe("detectFramework", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-vite-detect-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns class C / none when there is no package.json", () => {
        expect.hasAssertions();

        expect(detectFramework(workdir)).toStrictEqual({ class: "C", framework: "none" });
    });

    it("returns class C / none for a plain SPA with no known framework", () => {
        expect.hasAssertions();

        writePackageJson({ react: "^19.0.0", vite: "^8.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ class: "C", framework: "none" });
    });

    it("detects TanStack Start as class A", () => {
        expect.hasAssertions();

        writePackageJson({ "@tanstack/react-start": "^1.95.0" });

        expect(detectFramework(workdir)).toStrictEqual({ class: "A", framework: "tanstack-start" });
    });

    it("detects React Router (framework mode) as class A via @react-router/dev", () => {
        expect.hasAssertions();

        writePackageJson({ "@react-router/dev": "^7.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ class: "A", framework: "react-router" });
    });

    it("detects SolidStart as class A", () => {
        expect.hasAssertions();

        writePackageJson({ "@solidjs/start": "^1.0.0" });

        expect(detectFramework(workdir)).toStrictEqual({ class: "A", framework: "solid-start" });
    });

    it("detects SvelteKit / Nuxt / Astro as class B", () => {
        expect.hasAssertions();

        for (const dependency of ["@sveltejs/kit", "nuxt", "astro"]) {
            writePackageJson({ [dependency]: "^1.0.0" });

            expect(detectFramework(workdir).class).toBe("B");
        }
    });

    it("falls back to standalone on a malformed package.json", () => {
        expect.hasAssertions();

        writeFileSync(join(workdir, "package.json"), "{ not valid json", "utf8");

        expect(detectFramework(workdir)).toStrictEqual({ class: "C", framework: "none" });
    });
});

describe("formatFrameworkDetection", () => {
    it("formats the class-A composition line", () => {
        expect.hasAssertions();

        expect(formatFrameworkDetection({ class: "A", framework: "react-router" })).toContain("React Router (class A)");
    });

    it("formats a class-B note that composition is handled separately", () => {
        expect.hasAssertions();

        const line = formatFrameworkDetection({ class: "B", framework: "sveltekit" });

        expect(line).toContain("SvelteKit (class B)");
        expect(line).toContain("not yet wired here");
    });

    it("formats the standalone (class C) line", () => {
        expect.hasAssertions();

        expect(formatFrameworkDetection({ class: "C", framework: "none" })).toContain("standalone");
    });
});

describe("framework-detect-plugin (wired into cirrus())", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-vite-detect-plugin-"));
        mkdirSync(join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "cirrus", "schema.ts"), SCHEMA, "utf8");
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("includes the framework-detect plugin in cirrus()", () => {
        expect.hasAssertions();

        const names = cirrus({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false }).map((plugin) => plugin.name);

        expect(names).toContain("cirrus:framework-detect");
    });

    it("surfaces the detected framework on the shared context during config resolution", async () => {
        expect.hasAssertions();

        // A react-router project: the detect plugin must populate the context's
        // `framework` once Vite drives the plugin pipeline.
        writePackageJson({ "@react-router/dev": "^7.0.0" });

        const context = createPluginContext();
        const probe: Plugin = {
            configResolved() {
                context.framework = detectFramework(workdir);
            },
            name: "test:probe",
        };

        await resolveConfig(
            {
                configFile: false,
                plugins: [probe, ...cirrus({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false })],
                root: workdir,
            },
            "serve",
        );

        expect(context.framework).toStrictEqual({ class: "A", framework: "react-router" });
    });
});
