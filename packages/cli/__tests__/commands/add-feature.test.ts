import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAddFeature } from "../../src/commands/add/handler";
import { deriveBucketName } from "../../src/commands/add/storage";
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
    mkdirSync(join(dir, "lunora"), { recursive: true });
    writeFileSync(join(dir, "lunora", "schema.ts"), "export const schema = {};\n", "utf8");
};

const readDeps = (dir: string): Record<string, string> => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };

    return pkg.dependencies ?? {};
};

let workdir: string;

describe("runAddFeature", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-add-feature-"));
        seedProject(workdir);
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("`add email` applies the mail item", async () => {
        expect.assertions(3);

        const result = await runAddFeature({ cwd: workdir, feature: "email", from: registryRoot, logger: makeLogger().logger, yes: true });

        expect(result).toStrictEqual({ code: 0, items: ["mail"] });
        expect(existsSync(join(workdir, "lunora", "mail", "index.ts"))).toBe(true);
        expect(readDeps(workdir)["@lunora/mail"]).toBeDefined();
    });

    it("`add auth --yes` applies the default email-and-password item", async () => {
        expect.assertions(3);

        const result = await runAddFeature({ cwd: workdir, feature: "auth", from: registryRoot, logger: makeLogger().logger, yes: true });

        expect(result.items).toStrictEqual(["auth"]);
        expect(existsSync(join(workdir, "lunora", "auth", "index.ts"))).toBe(true);
        expect(readDeps(workdir)["@lunora/auth"]).toBeDefined();
    });

    it("`add auth --provider clerk` applies the auth-clerk item", async () => {
        expect.assertions(2);

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "auth",
            from: registryRoot,
            logger: makeLogger().logger,
            provider: "clerk",
        });

        expect(result.items).toStrictEqual(["auth-clerk"]);
        expect(existsSync(join(workdir, "lunora", "auth", "clerk.ts"))).toBe(true);
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

    it("asks before applying items from a custom --from registry root", async () => {
        expect.assertions(3);

        // `--from` points at a registry the user named, exactly like `--source`:
        // the item's files, deps and wrangler bindings are whatever that root
        // ships. `lunora add` used to auto-confirm the apply whenever `--source`
        // was unset, so the `--from` half wrote them silently.
        const prompts: string[] = [];
        const result = await runAddFeature({
            confirm: async (message: string) => {
                prompts.push(message);

                return false;
            },
            cwd: workdir,
            feature: "email",
            from: registryRoot,
            logger: makeLogger().logger,
        });

        expect(prompts).toHaveLength(1);
        expect(result.code).toBe(1);
        expect(existsSync(join(workdir, "lunora", "mail", "index.ts"))).toBe(false);
    });

    it("rejects when run outside a Lunora project", async () => {
        expect.assertions(2);

        const empty = mkdtempSync(join(tmpdir(), "lunora-cli-add-empty-"));

        try {
            const { lines, logger } = makeLogger();
            const result = await runAddFeature({ cwd: empty, feature: "auth", from: registryRoot, logger, yes: true });

            expect(result.code).toBe(1);
            expect(lines.join("\n")).toMatch(/not a Lunora project/);
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

    /** The `bucket_name` of the first `UPLOADS` r2 binding written to wrangler.jsonc. */
    const readBucketName = (dir: string): string | undefined => {
        const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
        const match = /"bucket_name":\s*"([^"]+)"/u.exec(text);

        return match?.[1];
    };

    it("`add storage` applies the item and writes the prompted bucket name", async () => {
        expect.assertions(3);

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "storage",
            from: registryRoot,
            logger: makeLogger().logger,
            promptText: async () => "my-cool-bucket",
        });

        expect(result.items).toStrictEqual(["storage"]);
        expect(existsSync(join(workdir, "lunora", "storage", "index.ts"))).toBe(true);
        expect(readBucketName(workdir)).toBe("my-cool-bucket");
    });

    it("`add storage --bucket` skips the prompt and writes the given (sanitized) name", async () => {
        expect.assertions(1);

        await runAddFeature({
            bucket: "My_App Uploads!",
            confirm: async () => true,
            cwd: workdir,
            feature: "storage",
            from: registryRoot,
            logger: makeLogger().logger,
            // A prompt here would throw — proving --bucket bypasses it.
            promptText: async () => {
                throw new Error("should not prompt when --bucket is given");
            },
        });

        expect(readBucketName(workdir)).toBe("my-app-uploads");
    });

    it("`add storage --yes` uses the project-derived default without prompting", async () => {
        expect.assertions(1);

        await runAddFeature({
            cwd: workdir,
            feature: "storage",
            from: registryRoot,
            logger: makeLogger().logger,
            promptText: async () => {
                throw new Error("should not prompt with --yes");
            },
            yes: true,
        });

        // The default is the project name (the temp dir) suffixed with `-uploads`, sanitized.
        expect(readBucketName(workdir)).toBe(deriveBucketName(basename(workdir)));
    });

    /** The first matching `key: value` string pair written to wrangler.jsonc. */
    const readBindingValue = (dir: string, key: string): string | undefined => {
        const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
        const match = new RegExp(String.raw`"${key}":\s*"([^"]+)"`, "u").exec(text);

        return match?.[1];
    };

    it("`add email` writes the prompted destination address into the send_email binding", async () => {
        expect.assertions(2);

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "email",
            from: registryRoot,
            logger: makeLogger().logger,
            promptText: async () => "support@my-app.com",
        });

        expect(result.items).toStrictEqual(["mail"]);
        expect(readBindingValue(workdir, "destination_address")).toBe("support@my-app.com");
    });

    it("`add email` keeps the placeholder (with a warning) when the typed address is invalid", async () => {
        expect.assertions(2);

        const { lines, logger } = makeLogger();

        await runAddFeature({ confirm: async () => true, cwd: workdir, feature: "email", from: registryRoot, logger, promptText: async () => "not-an-email" });

        expect(readBindingValue(workdir, "destination_address")).toBe("REPLACE_ME@example.com");
        expect(lines.join("\n")).toMatch(/doesn't look like an email/);
    });

    it("`add auth` writes the prompted D1 database name (leaving the id placeholder)", async () => {
        expect.assertions(3);

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "auth",
            from: registryRoot,
            logger: makeLogger().logger,
            promptText: async () => "my-db",
            provider: "auth",
        });

        expect(result.items).toStrictEqual(["auth"]);
        expect(readBindingValue(workdir, "database_name")).toBe("my-db");
        // The id can only come from `wrangler d1 create`, so the placeholder stays.
        expect(readBindingValue(workdir, "database_id")).toBe("<replace-with-d1-create-id>");
    });

    it("`add auth --db` skips the prompt and writes the given (sanitized) database name", async () => {
        expect.assertions(1);

        await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            db: "My App DB",
            feature: "auth",
            from: registryRoot,
            logger: makeLogger().logger,
            promptText: async () => {
                throw new Error("should not prompt when --db is given");
            },
            provider: "auth",
        });

        expect(readBindingValue(workdir, "database_name")).toBe("my-app-db");
    });

    it("`add --provider clerk` still names the D1 database (clerk pulls in base auth via requires)", async () => {
        expect.assertions(2);

        const result = await runAddFeature({
            confirm: async () => true,
            cwd: workdir,
            feature: "auth",
            from: registryRoot,
            logger: makeLogger().logger,
            promptText: async () => "clerk-db",
            provider: "clerk",
        });

        expect(result.items).toStrictEqual(["auth-clerk"]);
        // The transform reaches the base `auth` manifest expanded from `requires`.
        expect(readBindingValue(workdir, "database_name")).toBe("clerk-db");
    });

    it("errors clearly on an unknown bare registry item", async () => {
        expect.assertions(1);

        const result = await runAddFeature({ cwd: workdir, feature: "does-not-exist", from: registryRoot, logger: makeLogger().logger });

        expect(result.code).toBe(1);
    });
});
