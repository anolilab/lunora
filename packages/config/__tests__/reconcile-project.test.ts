import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pendingBindingChanges, reconcileBindingsSafely } from "../src/cloudflare/reconcile-project";
import type { DiscoveryCache } from "../src/discovery-cache";
import { createDiscoveryCache } from "../src/discovery-cache";

describe("reconcileBindingsSafely target gate", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-reconcile-project-"));
        mkdirSync(join(root, "lunora"), { recursive: true });
        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "compatibility_date": "2026-04-07" }\n`, "utf8");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const sourceMaps = (): unknown => (parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as { upload_source_maps?: unknown }).upload_source_maps;
    const logger = { info: (): void => {}, warn: (): void => {} };

    it.each([["celld"], ["node"]])("does not write upload_source_maps for the %s target", async (target) => {
        expect.assertions(1);

        await reconcileBindingsSafely({ projectRoot: root, schemaDir: "lunora", target }, logger);

        expect(sourceMaps()).toBeUndefined();
    });

    it("writes upload_source_maps for the cloudflare target", async () => {
        expect.assertions(1);

        await reconcileBindingsSafely({ projectRoot: root, schemaDir: "lunora", target: "cloudflare" }, logger);

        expect(sourceMaps()).toBe(true);
    });
});

describe("pendingBindingChanges", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-pending-bindings-"));
        mkdirSync(join(root, "lunora"), { recursive: true });
        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "compatibility_date": "2026-04-07" }\n`, "utf8");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const project = (): { cache: DiscoveryCache; projectRoot: string; schemaDir: string; target: string } => {
        return { cache: createDiscoveryCache(), projectRoot: root, schemaDir: "lunora", target: "cloudflare" };
    };

    it("names a binding the code started to need after the startup reconcile, without writing it", async () => {
        expect.assertions(3);

        await reconcileBindingsSafely(project(), { info: (): void => {}, warn: (): void => {} });

        await expect(pendingBindingChanges(project())).resolves.toStrictEqual([]);

        writeFileSync(join(root, "lunora", "cache.ts"), `import { kv } from "@lunora/bindings/kv";\n\nexport const store = kv;\n`, "utf8");

        const before = readFileSync(join(root, "wrangler.jsonc"), "utf8");

        const pending = await pendingBindingChanges(project());

        expect(pending.some((label) => label.startsWith("KV"))).toBe(true);
        expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toBe(before);
    });

    it("names a service binding only the dev sidecar's config lacks, without writing that config", async () => {
        expect.assertions(2);

        writeFileSync(join(root, "lunora.config.ts"), `export default { services: { parser: { dir: "./services/parser" } } };\n`, "utf8");
        mkdirSync(join(root, "services", "parser", "src"), { recursive: true });
        writeFileSync(join(root, "services", "parser", "wrangler.jsonc"), `{ "name": "parser", "main": "src/index.ts" }\n`, "utf8");
        writeFileSync(join(root, "package.json"), `{ "name": "app" }\n`, "utf8");

        await reconcileBindingsSafely(project(), { info: (): void => {}, warn: (): void => {} });

        // The sidecar appears after the startup pass, so only it is a binding short.
        const sidecar = `{ "name": "app-dev", "main": "lunora/server.ts" }\n`;

        writeFileSync(join(root, "wrangler.dev.jsonc"), sidecar, "utf8");

        const pending = await pendingBindingChanges(project());

        expect(pending.filter((label) => label.includes("SERVICE_PARSER"))).toStrictEqual(["wrangler.dev.jsonc services/SERVICE_PARSER → parser"]);
        expect(readFileSync(join(root, "wrangler.dev.jsonc"), "utf8")).toBe(sidecar);
    });
});
