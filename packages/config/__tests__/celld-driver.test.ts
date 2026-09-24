import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    it("drops module rules celld's bundler has no loader for", () => {
        expect.assertions(2);

        const { config, dropped } = projectCelldConfig({
            rules: [
                { globs: ["**/*.js"], type: "ESModule" },
                { globs: ["**/*.txt"], type: "Text" },
            ],
        });

        expect(config["rules"]).toStrictEqual([{ globs: ["**/*.txt"], type: "Text" }]);
        expect(dropped).toStrictEqual(["rules[0]"]);
    });

    // A key celld refuses but whose value configures nothing is dropped without
    // a report — otherwise every Vite build's generated defaults flood it.
    it("does not report dropping a key that configures nothing", () => {
        expect.assertions(1);

        expect(projectCelldConfig({ send_email: [], vectorize: [] }).dropped).toStrictEqual([]);
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

        const projected = resolveDeployDriver("celld").projectConfig?.(root, "deploy");

        expect(projected?.configPath).toBe(join(root, ".celld.wrangler.json"));
        expect(JSON.parse(readFileSync(join(root, ".celld.wrangler.json"), "utf8"))).toStrictEqual({ main: "src/server.ts" });
    });

    it("says where celld deploys from when there is no wrangler config", () => {
        expect.assertions(1);

        expect(() => resolveDeployDriver("celld").projectConfig?.(root, "deploy")).toThrow(/no wrangler.jsonc or wrangler.json/u);
    });

    /** A project on `@lunora/vite` after `vite build`: the plugin's output plus its deploy redirect. */
    const writeViteBuild = (assetsIgnore = "wrangler.json\n.dev.vars\n"): void => {
        writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ main: "virtual:lunora/worker", name: "app", observability: { enabled: true } }), "utf8");
        mkdirSync(join(root, ".wrangler", "deploy"), { recursive: true });
        writeFileSync(join(root, ".wrangler", "deploy", "config.json"), JSON.stringify({ configPath: "../../dist/server/wrangler.json" }), "utf8");
        mkdirSync(join(root, "dist", "server"), { recursive: true });
        mkdirSync(join(root, "dist", "client"), { recursive: true });
        writeFileSync(join(root, "dist", "client", ".assetsignore"), assetsIgnore, "utf8");
        writeFileSync(
            join(root, "dist", "server", "wrangler.json"),
            JSON.stringify({
                assets: { directory: "../client" },
                jsx_factory: "React.createElement",
                main: "index.js",
                name: "app",
                no_bundle: true,
                observability: { enabled: true },
                rules: [{ globs: ["**/*.js"], type: "ESModule" }],
                vectorize: [],
            }),
            "utf8",
        );
    };

    // The assets sit in a sibling of the server bundle, and celld wants every
    // path inside the config's directory — so the projection lands in the
    // build's output root with both paths rebased onto it.
    it("deploys a Vite-built worker from its build output", () => {
        expect.assertions(4);

        writeViteBuild();

        const projected = resolveDeployDriver("celld").projectConfig?.(root, "deploy");

        expect(projected?.configPath).toBe(join(root, "dist", ".celld.wrangler.json"));
        expect(JSON.parse(readFileSync(join(root, "dist", ".celld.wrangler.json"), "utf8"))).toStrictEqual({
            assets: { directory: "client" },
            main: "server/index.js",
            name: "app",
            rules: [],
        });
        // Only what the project configured, plus what the projection did to the build.
        expect(projected?.dropped).toStrictEqual(["observability", "no_bundle (celld re-bundles the build output)", "client/.assetsignore (matched no files)"]);
        expect(existsSync(join(root, "dist", "client", ".assetsignore"))).toBe(false);
    });

    it("keeps an .assetsignore that is hiding something, and stops instead", () => {
        expect.assertions(2);

        writeViteBuild("secret.txt\n");
        writeFileSync(join(root, "dist", "client", "secret.txt"), "x", "utf8");

        expect(() => resolveDeployDriver("celld").projectConfig?.(root, "deploy")).toThrow(/hides secret.txt/u);
        expect(existsSync(join(root, "dist", "client", ".assetsignore"))).toBe(true);
    });

    it("asks for a build when a Vite-built worker has none yet", () => {
        expect.assertions(1);

        writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ main: "virtual:lunora/worker" }), "utf8");

        expect(() => resolveDeployDriver("celld").projectConfig?.(root, "deploy")).toThrow(/Run the project's build/u);
    });

    // `celld dev` watches and rebuilds from source; serving a stale build
    // output as a dev server would be worse than saying so.
    it("refuses a dev server for a Vite-built worker", () => {
        expect.assertions(1);

        writeViteBuild();

        expect(() => resolveDeployDriver("celld").projectConfig?.(root, "dev")).toThrow(/`celld dev` rebuilds from a source file/u);
    });
});
