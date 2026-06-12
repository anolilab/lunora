import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

// __tests__/commands/ -> package root -> packages/ -> monorepo root -> registry/
const testDirectory = dirname(fileURLToPath(import.meta.url));
const registryRoot = resolve(testDirectory, "..", "..", "..", "..", "registry");

const seedProject = (dir: string): void => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, null, 4), "utf8");
    writeFileSync(join(dir, "wrangler.jsonc"), '{\n    // demo\n    "name": "demo"\n}\n', "utf8");
    mkdirSync(join(dir, "cirrus"), { recursive: true });
    writeFileSync(join(dir, "cirrus", "schema.ts"), "export const schema = {};\n", "utf8");
};

const readDeps = (dir: string): Record<string, string> => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };

    return pkg.dependencies ?? {};
};

let workdir: string;

describe("runAddFeature", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-add-feature-"));
        seedProject(workdir);
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("`add email` applies the mail item", async () => {
        expect.assertions(3);

        const result = await runAddFeature({ cwd: workdir, feature: "email", from: registryRoot, logger: makeLogger().logger, yes: true });

        expect(result).toStrictEqual({ code: 0, items: ["mail"] });
        expect(existsSync(join(workdir, "cirrus", "mail", "index.ts"))).toBe(true);
        expect(readDeps(workdir)["@cirrus/mail"]).toBeDefined();
    });

    it("`add auth --yes` applies the default email-and-password item", async () => {
        expect.assertions(3);

        const result = await runAddFeature({ cwd: workdir, feature: "auth", from: registryRoot, logger: makeLogger().logger, yes: true });

        expect(result.items).toStrictEqual(["auth"]);
        expect(existsSync(join(workdir, "cirrus", "auth", "index.ts"))).toBe(true);
        expect(readDeps(workdir)["@cirrus/auth"]).toBeDefined();
    });

    it("`add auth --provider clerk` applies the auth-clerk item", async () => {
        expect.assertions(2);

        const result = await runAddFeature({ cwd: workdir, feature: "auth", from: registryRoot, logger: makeLogger().logger, provider: "clerk" });

        expect(result.items).toStrictEqual(["auth-clerk"]);
        expect(existsSync(join(workdir, "cirrus", "auth", "clerk.ts"))).toBe(true);
    });

    it("uses the injected provider prompt when neither --provider nor --yes is given", async () => {
        expect.assertions(1);

        const result = await runAddFeature({
            cwd: workdir,
            feature: "auth",
            from: registryRoot,
            logger: makeLogger().logger,
            promptSelect: async () => "auth-auth0",
        });

        expect(result.items).toStrictEqual(["auth-auth0"]);
    });

    it("rejects when run outside a Cirrus project", async () => {
        expect.assertions(2);

        const empty = mkdtempSync(join(tmpdir(), "cirrus-cli-add-empty-"));

        try {
            const { lines, logger } = makeLogger();
            const result = await runAddFeature({ cwd: empty, feature: "auth", from: registryRoot, logger, yes: true });

            expect(result.code).toBe(1);
            expect(lines.join("\n")).toMatch(/not a Cirrus project/);
        } finally {
            rmSync(empty, { force: true, recursive: true });
        }
    });

    it("rejects an empty feature argument", async () => {
        expect.assertions(2);

        const { lines, logger } = makeLogger();
        const result = await runAddFeature({ cwd: workdir, feature: "   ", from: registryRoot, logger });

        expect(result.code).toBe(1);
        expect(lines.join("\n")).toMatch(/requires a feature/);
    });

    it("`add storage` passes a bare registry item name straight through", async () => {
        expect.assertions(2);

        const result = await runAddFeature({ cwd: workdir, feature: "storage", from: registryRoot, logger: makeLogger().logger });

        expect(result.items).toStrictEqual(["storage"]);
        expect(existsSync(join(workdir, "cirrus", "storage", "index.ts"))).toBe(true);
    });

    it("errors clearly on an unknown bare registry item", async () => {
        expect.assertions(1);

        const result = await runAddFeature({ cwd: workdir, feature: "does-not-exist", from: registryRoot, logger: makeLogger().logger });

        expect(result.code).toBe(1);
    });
});
