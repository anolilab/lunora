import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectCelldConfig } from "../src/celld/celld-config";
import { resolveDeployDriver } from "../src/driver-registry";
import { toolchainExecArgs } from "../src/package-manager";

describe("celld deploy driver", () => {
    const driver = resolveDeployDriver("celld");

    it("runs the celld binary from PATH on the projected config", () => {
        expect.assertions(2);

        expect(driver.toolchain?.deploy({ configPath: ".celld.wrangler.json" })).toStrictEqual({
            args: ["deploy", ".celld.wrangler.json"],
            onPath: true,
            tool: "celld",
        });
        expect(driver.toolchain?.dev({ configPath: ".celld.wrangler.json", extraArgs: ["--port", "8790"] }).args).toStrictEqual([
            "dev",
            ".celld.wrangler.json",
            "--port",
            "8790",
        ]);
    });

    // Each of these has an obvious wrong fallback — a dry run that publishes, an
    // `--env` that quietly deploys the top-level config — so the driver refuses
    // rather than drop the flag.
    it.each([
        [{ dryRun: true }, /no dry run/u],
        [{ environment: "staging" }, /no Wrangler environments/u],
        [{ preview: true }, /no preview versions/u],
        [{ temporary: true }, /no short-lived accounts/u],
        [{ outDir: "dist" }, /does not write its bundle/u],
        [{ entry: "src/worker.ts" }, /composed framework entry/u],
    ])("refuses the deploy option %o it has no equivalent for", (request, message) => {
        expect.assertions(1);

        expect(() => driver.toolchain?.deploy(request)).toThrow(message);
    });

    it("declares no secret store and no log tail", () => {
        expect.assertions(3);

        expect(driver.toolchain?.secretList).toBeUndefined();
        expect(driver.toolchain?.secretPut).toBeUndefined();
        expect(driver.toolchain?.tail).toBeUndefined();
    });
});

describe(toolchainExecArgs, () => {
    it("goes through the package manager for a project dependency", () => {
        expect.assertions(1);

        expect(toolchainExecArgs("npm", { args: ["deploy"], tool: "wrangler" })).toStrictEqual({ args: ["--", "wrangler", "deploy"], command: "npx" });
    });

    // `npx -- celld` would fetch an npm package called `celld` when none is
    // installed locally — somebody else's code — so a PATH binary never goes
    // through the package manager, whichever one the project uses.
    it("runs a PATH binary directly, whatever the package manager", () => {
        expect.assertions(2);

        expect(toolchainExecArgs("npm", { args: ["deploy"], onPath: true, tool: "celld" })).toStrictEqual({ args: ["deploy"], command: "celld" });
        expect(toolchainExecArgs("bun", { args: ["deploy"], onPath: true, tool: "celld" })).toStrictEqual({ args: ["deploy"], command: "celld" });
    });
});

describe(projectCelldConfig, () => {
    it("keeps what celld accepts and names everything it drops", () => {
        expect.assertions(2);

        const { config, dropped } = projectCelldConfig({
            compatibility_date: "2026-06-10",
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            limits: { cpu_ms: 30_000 },
            main: "src/server.ts",
            name: "app",
            observability: { enabled: true },
            version_metadata: { binding: "CF_VERSION_METADATA" },
        });

        expect(config).toStrictEqual({
            compatibility_date: "2026-06-10",
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            main: "src/server.ts",
            name: "app",
        });
        expect(dropped).toStrictEqual(["limits", "observability", "version_metadata"]);
    });

    it("strips container keys celld does not accept, per entry", () => {
        expect.assertions(2);

        const { config, dropped } = projectCelldConfig({
            containers: [{ class_name: "Sandbox", image: "./Dockerfile", image_build_context: ".", max_instances: 2 }],
        });

        expect(config["containers"]).toStrictEqual([{ class_name: "Sandbox", image: "./Dockerfile", max_instances: 2 }]);
        expect(dropped).toStrictEqual(["containers[0].image_build_context"]);
    });

    it("keeps new_sqlite_classes migrations", () => {
        expect.assertions(1);

        expect(projectCelldConfig({ migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }] }).config["migrations"]).toStrictEqual([
            { new_sqlite_classes: ["ShardDO"], tag: "v1" },
        ]);
    });

    // Dropping the step would deploy a class layout the migration history says
    // no longer exists; celld refuses the whole deploy for it anyway.
    it("refuses a migration step celld cannot apply, by name", () => {
        expect.assertions(1);

        expect(() => projectCelldConfig({ migrations: [{ renamed_classes: [{ from: "A", to: "B" }], tag: "v2" }] })).toThrow(
            /migration "v2" uses `renamed_classes`/u,
        );
    });

    it("refuses a Vite virtual entry, which esbuild has no file for", () => {
        expect.assertions(1);

        expect(() => projectCelldConfig({ main: "virtual:lunora/worker" })).toThrow(/Vite virtual module/u);
    });
});

describe("celld config projection on disk", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-celld-config-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    // Beside wrangler.jsonc, not under `.celld/`: celld takes the config's
    // directory as the project root and requires `main` inside it.
    it("writes the projection beside the project's JSONC config", () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), `{\n    // comment\n    "main": "src/server.ts",\n    "observability": { "enabled": true },\n}\n`, "utf8");

        const projected = resolveDeployDriver("celld").projectConfig?.(root);

        expect(projected?.configPath).toBe(join(root, ".celld.wrangler.json"));
        expect(JSON.parse(readFileSync(join(root, ".celld.wrangler.json"), "utf8"))).toStrictEqual({ main: "src/server.ts" });
    });

    it("says where celld deploys from when there is no wrangler config", () => {
        expect.assertions(1);

        expect(() => resolveDeployDriver("celld").projectConfig?.(root)).toThrow(/no wrangler.jsonc or wrangler.json/u);
    });
});
