import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requiredSecrets, resolveDeployDriver } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { offerMissingSecrets } from "../../src/commands/deploy/secrets";
import type { Logger } from "../../src/util/logger";

const logger: Logger = { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };

/**
 * celld has no secret store, so the gate checks the `vars` celld actually
 * deploys. For a Vite virtual entry that is the build's config, not the
 * project's own `wrangler.jsonc`.
 */
describe("celld secrets gate", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-celld-secrets-"));
        writeFileSync(
            join(root, "wrangler.jsonc"),
            JSON.stringify({ main: "virtual:lunora/worker", name: "app", vars: { LUNORA_ADMIN_TOKEN: "source-only" } }),
            "utf8",
        );
        mkdirSync(join(root, ".wrangler", "deploy"), { recursive: true });
        writeFileSync(join(root, ".wrangler", "deploy", "config.json"), JSON.stringify({ configPath: "../../dist/server/wrangler.json" }), "utf8");
        mkdirSync(join(root, "dist", "server"), { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const writeBuildConfig = (vars: Record<string, string>): void => {
        writeFileSync(join(root, "dist", "server", "wrangler.json"), JSON.stringify({ main: "index.js", name: "app", vars }), "utf8");
    };

    // Interactive too: nothing can supply the value to a host without a secret store.
    it("aborts an interactive deploy when the build's vars lack a key the source config carries", async () => {
        expect.assertions(1);

        writeBuildConfig({});

        await expect(offerMissingSecrets(root, { logger }, true, resolveDeployDriver("celld"))).resolves.toStrictEqual({
            error: expect.stringMatching(/missing required secret\(s\) in the wrangler vars: .*LUNORA_ADMIN_TOKEN/u),
        });
    });

    // A real URL that happens to contain a placeholder word is a value: the token heuristic judges secret-shaped keys only.
    it("passes when a required URL names a placeholder word", async () => {
        expect.assertions(1);

        mkdirSync(join(root, "lunora"), { recursive: true });
        writeFileSync(join(root, "lunora", "auth.ts"), 'import "@lunora/auth";\n', "utf8");
        writeBuildConfig(
            Object.fromEntries(requiredSecrets(["@lunora/auth"]).map((entry) => [entry.key, entry.key === "AUTH_URL" ? "https://todo.acme.com" : "set"])),
        );

        await expect(offerMissingSecrets(root, { logger }, true, resolveDeployDriver("celld"))).resolves.toStrictEqual({});
    });

    it("passes when the build's vars carry the key", async () => {
        expect.assertions(1);

        writeBuildConfig({ LUNORA_ADMIN_TOKEN: "set" });

        await expect(offerMissingSecrets(root, { logger }, true, resolveDeployDriver("celld"))).resolves.toStrictEqual({});
    });
});
