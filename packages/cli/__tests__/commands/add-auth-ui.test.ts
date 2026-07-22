import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectAuthUiItem, normalizeFeature } from "../../src/commands/add/features";
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

    it("`add auth-ui --yes` with no framework dependency warns and defaults to React", async () => {
        expect.assertions(2);

        seedProject(workdir, {});

        const { lines, logger } = makeLogger();
        const result = await runAddFeature({ cwd: workdir, feature: "auth-ui", from: registryRoot, logger, yes: true });

        expect(result.items).toStrictEqual(["auth-ui-react"]);
        expect(lines.join("\n")).toMatch(/couldn't detect your framework/);
    });

    it("uses the injected framework prompt when detection fails and not --yes", async () => {
        expect.assertions(1);

        seedProject(workdir, {});

        const result = await runAddFeature({
            cwd: workdir,
            feature: "auth-ui",
            from: registryRoot,
            logger: makeLogger().logger,
            // Detection returns nothing → the select prompt decides. Choose React
            // (the only item shipped so far) so the install completes.
            promptSelect: async () => "auth-ui-react",
            promptText: async () => "demo-db",
        });

        expect(result.items).toStrictEqual(["auth-ui-react"]);
    });
});
