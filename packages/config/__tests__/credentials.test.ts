import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasCloudflareCredentials } from "../src/cloudflare/credentials";

const TOKEN_KEY = "CLOUDFLARE_API_TOKEN";
const EMAIL_KEY = "CLOUDFLARE_EMAIL";
const CF_TOKEN_KEY = "CF_API_TOKEN";

describe("hasCloudflareCredentials", () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "lunora-cf-home-"));
    });

    afterEach(() => {
        rmSync(home, { force: true, recursive: true });
    });

    /** Leave a `wrangler login` file under `<base>/.wrangler/config`. */
    const login = (base: string, file = "default.toml"): void => {
        mkdirSync(join(base, ".wrangler", "config"), { recursive: true });
        writeFileSync(join(base, ".wrangler", "config", file), 'oauth_token = "x"\n', "utf8");
    };

    it("is false with no env credentials and no wrangler login", () => {
        expect.assertions(1);

        expect(hasCloudflareCredentials({ env: {}, home })).toBe(false);
    });

    it("accepts an API token, including the deprecated name", () => {
        expect.assertions(2);

        expect(hasCloudflareCredentials({ env: { CLOUDFLARE_API_TOKEN: "t" }, home })).toBe(true);
        expect(hasCloudflareCredentials({ env: { CF_API_TOKEN: "t" }, home })).toBe(true);
    });

    it("needs both halves of a global API key", () => {
        expect.assertions(3);

        expect(hasCloudflareCredentials({ env: { CLOUDFLARE_API_KEY: "k" }, home })).toBe(false);
        expect(hasCloudflareCredentials({ env: { CLOUDFLARE_EMAIL: "a@b.c" }, home })).toBe(false);
        expect(hasCloudflareCredentials({ env: { CLOUDFLARE_API_KEY: "k", CLOUDFLARE_EMAIL: "a@b.c" }, home })).toBe(true);
    });

    it("ignores a blank token", () => {
        expect.assertions(1);

        expect(hasCloudflareCredentials({ env: { CLOUDFLARE_API_TOKEN: "  " }, home })).toBe(false);
    });

    it.each([
        ["the legacy home directory", (h: string) => h],
        ["macOS preferences", (h: string) => join(h, "Library", "Preferences")],
        ["the Linux XDG default", (h: string) => join(h, ".config")],
        ["the Windows roaming default", (h: string) => join(h, "AppData", "Roaming", "xdg.config")],
    ])("finds a wrangler login under %s", (_label, base) => {
        expect.assertions(1);

        login(base(home));

        expect(hasCloudflareCredentials({ env: {}, home })).toBe(true);
    });

    it("finds a keychain-backed login (an .enc file) under XDG_CONFIG_HOME", () => {
        expect.assertions(1);

        const xdg = join(home, "custom-xdg");

        login(xdg, "default.enc");

        expect(hasCloudflareCredentials({ env: { XDG_CONFIG_HOME: xdg }, home })).toBe(true);
    });

    it("treats an empty wrangler config directory as logged out", () => {
        expect.assertions(1);

        mkdirSync(join(home, ".config", ".wrangler", "config"), { recursive: true });

        expect(hasCloudflareCredentials({ env: {}, home })).toBe(false);
    });

    describe("project .env files", () => {
        let project: string;

        beforeEach(() => {
            project = mkdtempSync(join(tmpdir(), "lunora-cf-project-"));
        });

        afterEach(() => {
            rmSync(project, { force: true, recursive: true });
        });

        it("reads a token from the project .env, which wrangler loads before it authenticates", () => {
            expect.assertions(1);

            writeFileSync(join(project, ".env"), `${TOKEN_KEY}=placeholder\n`, "utf8");

            expect(hasCloudflareCredentials({ env: {}, home, projectRoot: project })).toBe(true);
        });

        it("takes an export prefix and quoted values", () => {
            expect.assertions(1);

            writeFileSync(join(project, ".env.local"), `export ${CF_TOKEN_KEY}="placeholder"\n`, "utf8");

            expect(hasCloudflareCredentials({ env: {}, home, projectRoot: project })).toBe(true);
        });

        it("ignores commented-out and empty credentials", () => {
            expect.assertions(1);

            writeFileSync(join(project, ".env"), "# CLOUDFLARE_API_TOKEN=abc\nCLOUDFLARE_API_TOKEN=\n", "utf8");

            expect(hasCloudflareCredentials({ env: {}, home, projectRoot: project })).toBe(false);
        });

        it("pairs a global key in the environment with an email in .env", () => {
            expect.assertions(1);

            writeFileSync(join(project, ".env"), `${EMAIL_KEY}=placeholder\n`, "utf8");

            expect(hasCloudflareCredentials({ env: { CLOUDFLARE_API_KEY: "k" }, home, projectRoot: project })).toBe(true);
        });

        it("does not read .env files without a project root", () => {
            expect.assertions(1);

            writeFileSync(join(project, ".env"), `${TOKEN_KEY}=placeholder\n`, "utf8");

            expect(hasCloudflareCredentials({ env: {}, home })).toBe(false);
        });
    });

    it("finds a login under APPDATA on Windows", () => {
        expect.assertions(1);

        const appData = mkdtempSync(join(tmpdir(), "lunora-cf-appdata-"));

        try {
            login(join(appData, "xdg.config"));

            expect(hasCloudflareCredentials({ env: { APPDATA: appData }, home })).toBe(true);
        } finally {
            rmSync(appData, { force: true, recursive: true });
        }
    });
});
