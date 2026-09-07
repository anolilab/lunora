import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectAuthUiItem, isReactNativeProject, isSolid2Project, normalizeFeature } from "../../src/commands/add/features";
import { runAddFeature } from "../../src/commands/add/handler";
import type { Logger } from "../../src/util/logger";

const makeLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (prefix: string) =>
        (message: string): number =>
            lines.push(`${prefix}${message}`);

    return { lines, logger: { error: push("error: "), info: push("info: "), success: push("success: "), warn: push("warn: ") } };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const registryRoot = resolve(testDirectory, "..", "..", "..", "..", "registry");

const seedProject = (dir: string, dependencies: Record<string, string>): void => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies, name: "demo" }, null, 4), "utf8");
    writeFileSync(join(dir, "wrangler.jsonc"), '{\n    "name": "demo"\n}\n', "utf8");
    mkdirSync(join(dir, "lunora"), { recursive: true });
    writeFileSync(join(dir, "lunora", "schema.ts"), "export const schema = {};\n", "utf8");
};

const readDeps = (dir: string): Record<string, string> => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };

    return pkg.dependencies ?? {};
};

describe("normalizeFeature (auth-ui)", () => {
    it("routes auth-ui to its own kind (not the auth provider prompt)", () => {
        expect.assertions(2);

        expect(normalizeFeature("auth-ui")).toStrictEqual({ kind: "auth-ui" });
        expect(normalizeFeature("AUTH-UI")).toStrictEqual({ kind: "auth-ui" });
    });

    it("keeps a bare per-framework item as a passthrough", () => {
        expect.assertions(1);

        expect(normalizeFeature("auth-ui-vue")).toStrictEqual({ item: "auth-ui-vue", kind: "item" });
    });
});

describe("detectAuthUiItem", () => {
    it("prefers the Lunora adapter dependency", () => {
        expect.assertions(2);

        expect(detectAuthUiItem({ "@lunora/vue": "1.0.0", vue: "3.0.0" })).toBe("auth-ui-vue");
        expect(detectAuthUiItem({ "@lunora/react": "1.0.0" })).toBe("auth-ui-react");
    });

    it("falls back to a bare framework / meta-framework", () => {
        expect.assertions(5);

        expect(detectAuthUiItem({ next: "15.0.0" })).toBe("auth-ui-react");
        expect(detectAuthUiItem({ nuxt: "3.0.0" })).toBe("auth-ui-vue");
        expect(detectAuthUiItem({ "@sveltejs/kit": "2.0.0" })).toBe("auth-ui-svelte");
        expect(detectAuthUiItem({ "solid-js": "1.0.0" })).toBe("auth-ui-solid");
        expect(detectAuthUiItem({ "@angular/core": "19.0.0" })).toBe("auth-ui-angular");
    });

    it("returns undefined when nothing matches", () => {
        expect.assertions(1);

        expect(detectAuthUiItem({ lodash: "4.0.0" })).toBeUndefined();
    });

    it("does not resolve React Native to the DOM React payload", () => {
        expect.assertions(3);

        // An Expo app depends on `react`, which would otherwise match `auth-ui-react`.
        expect(detectAuthUiItem({ expo: "54.0.0", react: "19.2.0", "react-native": "0.83.0" })).toBeUndefined();
        expect(detectAuthUiItem({ "@lunora/react-native": "1.0.0", react: "19.2.0" })).toBeUndefined();
        expect(isReactNativeProject({ "react-native": "0.83.0" })).toBe(true);
    });

    it("routes Solid 2 to its own payload, not the Solid 1.x one", () => {
        expect.assertions(9);

        // A Solid 2 project still depends on `solid-js` and `@lunora/solid`, both
        // of which would otherwise match `auth-ui-solid` — whose screens are 1.x
        // source and do not compile against Solid 2.
        expect(detectAuthUiItem({ "@lunora/solid": "1.0.0", "@solidjs/web": "2.0.0-rc.0", "solid-js": "2.0.0-rc.0" })).toBe("auth-ui-solid-v2");
        expect(detectAuthUiItem({ "solid-js": "^2.0.0-rc.0" })).toBe("auth-ui-solid-v2");
        expect(isSolid2Project({ "solid-js": "^2.0.0-rc.0" })).toBe(true);
        expect(isSolid2Project({ "@solidjs/web": "^2.0.0-rc.0" })).toBe(true);

        // npm accepts partial ranges, so a major on its own is a legal way to
        // pin Solid 2 and has no dot for the parser to anchor on.
        expect(isSolid2Project({ "solid-js": "2" })).toBe(true);
        expect(isSolid2Project({ "solid-js": "^2" })).toBe(true);
        expect(isSolid2Project({ "solid-js": "1" })).toBe(false);

        // Solid 1.x is untouched — it still resolves to the 1.x payload.
        expect(isSolid2Project({ "solid-js": "^1.9.14" })).toBe(false);
        expect(detectAuthUiItem({ "@lunora/solid": "1.0.0", "solid-js": "^1.9.14" })).toBe("auth-ui-solid");
    });

    it("reads the range's floor rather than its first digit", () => {
        expect.assertions(6);

        // `>1` is `>=2.0.0`: the first number in a range is not its floor.
        expect(isSolid2Project({ "solid-js": ">1" })).toBe(true);
        expect(isSolid2Project({ "solid-js": ">=2" })).toBe(true);

        // A union floors at its lowest alternative regardless of the order it is
        // written in, so a range spanning both majors is not a Solid 2 signal.
        expect(isSolid2Project({ "solid-js": "^1.9.0 || ^2.0.0-rc.0" })).toBe(false);
        expect(isSolid2Project({ "solid-js": "2 || 1" })).toBe(false);

        // Specifiers npm cannot parse as a range decide nothing on their own —
        // the project falls through to the rest of the ladder.
        expect(isSolid2Project({ "solid-js": "workspace:*" })).toBe(false);
        expect(isSolid2Project({ "@solidjs/web": "workspace:*", "solid-js": "workspace:*" })).toBe(true);
    });
});

describe("runAddFeature (auth-ui)", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-add-auth-ui-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("`add auth-ui` detects React, copies the screens, and pulls in the base auth item", async () => {
        expect.assertions(5);

        seedProject(workdir, { "@lunora/react": "1.0.0-alpha.30" });

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "auth-ui",
            from: registryRoot,
            logger: makeLogger().logger,
            // auth-ui requires the base `auth` item, which prompts for the D1 name.
            promptText: async () => "demo-db",
        });

        expect(result.items).toStrictEqual(["auth-ui-react"]);
        // The copied, user-owned files land under lunora/auth-ui/**.
        expect(existsSync(join(workdir, "lunora", "auth-ui", "react", "provider.tsx"))).toBe(true);
        expect(existsSync(join(workdir, "lunora", "auth-ui", "core", "sign-in.ts"))).toBe(true);
        // The base `auth` server item came in via `requires`.
        expect(existsSync(join(workdir, "lunora", "auth", "index.ts"))).toBe(true);
        expect(readDeps(workdir)["@lunora/react"]).toBeDefined();
    });

    it("`add auth-ui` detects Vue and installs the Vue payload", async () => {
        expect.assertions(4);

        seedProject(workdir, { "@lunora/vue": "1.0.0-alpha.1" });

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "auth-ui",
            from: registryRoot,
            logger: makeLogger().logger,
            promptText: async () => "demo-db",
        });

        expect(result.items).toStrictEqual(["auth-ui-vue"]);
        expect(existsSync(join(workdir, "lunora", "auth-ui", "vue", "AuthUIProvider.vue"))).toBe(true);
        // Shared, framework-agnostic core lands alongside the Vue views.
        expect(existsSync(join(workdir, "lunora", "auth-ui", "core", "sign-in.ts"))).toBe(true);
        expect(readDeps(workdir)["@lunora/vue"]).toBeDefined();
    });

    it("`add auth-ui --yes` with no framework dependency warns and defaults to React", async () => {
        expect.assertions(2);

        seedProject(workdir, {});

        const { lines, logger } = makeLogger();
        const result = await runAddFeature({ cwd: workdir, feature: "auth-ui", from: registryRoot, logger, yes: true });

        expect(result.items).toStrictEqual(["auth-ui-react"]);
        expect(lines.join("\n")).toMatch(/couldn't detect your framework/);
    });

    it("`add auth-ui` refuses on React Native instead of copying the DOM screens", async () => {
        expect.assertions(3);

        seedProject(workdir, { expo: "54.0.0", "@lunora/react-native": "1.0.0", react: "19.2.0", "react-native": "0.83.0" });

        const { lines, logger } = makeLogger();
        // `--yes` so the "couldn't detect your framework" fallback would otherwise
        // have installed `auth-ui-react` without asking.
        const result = await runAddFeature({ cwd: workdir, feature: "auth-ui", from: registryRoot, logger, yes: true });

        expect(result.code).toBe(1);
        expect(lines.join("\n")).toMatch(/no React Native port/);
        expect(existsSync(join(workdir, "lunora", "auth-ui"))).toBe(false);
    });

    it("`add auth-ui` detects Solid 2 and installs the Solid 2 payload", async () => {
        expect.assertions(4);

        seedProject(workdir, { "@lunora/solid": "1.0.0", "@solidjs/web": "2.0.0-rc.0", "solid-js": "^2.0.0-rc.0" });

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "auth-ui",
            from: registryRoot,
            logger: makeLogger().logger,
            promptText: async () => "demo-db",
        });

        expect(result.items).toStrictEqual(["auth-ui-solid-v2"]);
        expect(existsSync(join(workdir, "lunora", "auth-ui", "solid-v2", "auth-cards.tsx"))).toBe(true);
        // ...and not the 1.x views beside them.
        expect(existsSync(join(workdir, "lunora", "auth-ui", "solid", "auth-cards.tsx"))).toBe(false);
        // Shared, framework-agnostic core lands alongside them.
        expect(existsSync(join(workdir, "lunora", "auth-ui", "core", "sign-in.ts"))).toBe(true);
    });

    it("uses the injected framework prompt when detection fails and not --yes", async () => {
        expect.assertions(1);

        seedProject(workdir, {});

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "auth-ui",
            from: registryRoot,
            logger: makeLogger().logger,
            // Detection returns nothing → the select prompt decides.
            promptSelect: async () => "auth-ui-react",
            promptText: async () => "demo-db",
        });

        expect(result.items).toStrictEqual(["auth-ui-react"]);
    });
});
