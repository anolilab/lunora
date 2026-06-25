import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PACKAGE_SECRETS_REGISTRY, secretsForPackages } from "../src/package-secrets-registry";
import { buildPackageSecretsBlock, ensureDevVarsExample, isPlaceholderValue } from "../src/scaffold-dev-variables";

/** Keys whose name implies a secret value — mirrors the scaffolder's SECRET_KEY regex. */
const SECRET_KEY_PATTERN = /(?:KEY|PASSWORD|SECRET|TOKEN)$/u;

/** Strip one layer of surrounding quotes from a raw value string. */
const stripQuotes = (raw: string): string =>
    raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) ? raw.slice(1, -1) : raw;

/**
 * Parse a `.dev.vars` block and return the unquoted values of every
 * secret-keyed assignment (keys matching {@link SECRET_KEY_PATTERN}).
 * Uses a functional pipeline — no `if` branches in test scope.
 */
const secretEntryValues = (text: string): string[] =>
    text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((trimmed) => trimmed.length > 0 && !trimmed.startsWith("#") && trimmed.includes("="))
        .map((trimmed) => {
            return { equalsIndex: trimmed.indexOf("="), trimmed };
        })
        .filter(({ equalsIndex }) => equalsIndex > 0)
        .map(({ trimmed, equalsIndex }) => {
            return { key: trimmed.slice(0, equalsIndex).trim(), rawValue: trimmed.slice(equalsIndex + 1).trim() };
        })
        .filter(({ key }) => SECRET_KEY_PATTERN.test(key))
        .map(({ rawValue }) => stripQuotes(rawValue));

// ─────────────────────────────────────────────────────────────────────────────
// secretsForPackages
// ─────────────────────────────────────────────────────────────────────────────

describe("secretsForPackages", () => {
    it("returns entries for known packages in declaration order", () => {
        expect.assertions(3);

        const entries = secretsForPackages(["@lunora/auth"]);

        expect(entries.length).toBeGreaterThan(0);
        // First key is AUTH_SECRET, as declared in the registry.
        expect(entries[0]?.key).toBe("AUTH_SECRET");
        // All entries have description and docsUrl populated.
        expect(entries.every((entry) => entry.description.length > 0 && entry.docsUrl.length > 0)).toBe(true);
    });

    it("returns entries for multiple packages in the order supplied", () => {
        expect.assertions(2);

        const entries = secretsForPackages(["@lunora/auth", "@lunora/payment"]);
        const keys = entries.map((entry) => entry.key);

        // Auth entries come before payment entries.
        const firstAuthIndex = keys.indexOf("AUTH_SECRET");
        const firstPaymentIndex = keys.indexOf("STRIPE_SECRET_KEY");

        expect(firstAuthIndex).toBeGreaterThanOrEqual(0);
        expect(firstAuthIndex).toBeLessThan(firstPaymentIndex);
    });

    it("silently ignores unknown package names", () => {
        expect.assertions(1);

        const entries = secretsForPackages(["@lunora/does-not-exist", "@lunora/also-unknown"]);

        expect(entries).toStrictEqual([]);
    });

    it("returns no entries for an empty list", () => {
        expect.assertions(1);

        expect(secretsForPackages([])).toStrictEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// packageSecretsRegistry — placeholder-only invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("packageSecretsRegistry", () => {
    it("secret-keyed entries have placeholder values (never a real secret)", () => {
        expect.hasAssertions();

        // Reviewer-visible assertion: the registry can never emit a real secret
        // value for keys that match the SECRET_KEY_PATTERN. Non-secret keys
        // (like AUTH_URL) may carry real default values (e.g. a localhost URL).
        const secretEntries = Object.values(PACKAGE_SECRETS_REGISTRY)
            .flat()
            .filter((entry) => SECRET_KEY_PATTERN.test(entry.key));

        for (const entry of secretEntries) {
            expect(isPlaceholderValue(entry.placeholderValue), `${entry.key}.placeholderValue must be a placeholder`).toBe(true);
        }
    });

    it("every entry has a non-empty description and an https docsUrl", () => {
        expect.assertions(1);

        const entries = Object.values(PACKAGE_SECRETS_REGISTRY).flat();

        expect(entries.every((entry) => entry.description.length > 0 && entry.docsUrl.startsWith("https://"))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPackageSecretsBlock
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPackageSecretsBlock", () => {
    it("contributes no package secrets when no packages have requirements (core token already present)", () => {
        expect.assertions(1);

        // `LUNORA_ADMIN_TOKEN` is an always-included core secret; mark it present
        // so this asserts only that the package itself contributes nothing.
        expect(buildPackageSecretsBlock(["@lunora/runtime"], new Set(["LUNORA_ADMIN_TOKEN"]))).toBe("");
    });

    it("contributes no package secrets for an empty package list (core token already present)", () => {
        expect.assertions(1);

        expect(buildPackageSecretsBlock([], new Set(["LUNORA_ADMIN_TOKEN"]))).toBe("");
    });

    it("always emits the core LUNORA_ADMIN_TOKEN even with no package secrets", () => {
        expect.assertions(1);

        expect(buildPackageSecretsBlock([], new Set())).toContain("LUNORA_ADMIN_TOKEN=");
    });

    it("includes key=placeholder lines for each secret of the given packages", () => {
        expect.assertions(2);

        const block = buildPackageSecretsBlock(["@lunora/auth"], new Set());

        expect(block).toContain("AUTH_SECRET=");
        expect(block).toContain("AUTH_URL=");
    });

    it("includes description comment and docs URL above each entry", () => {
        expect.assertions(2);

        const block = buildPackageSecretsBlock(["@lunora/auth"], new Set());

        // Description comment must appear.
        expect(block).toMatch(/^#.+/mu);
        // Docs URL comment must appear.
        expect(block).toContain("# Docs:");
    });

    it("skips keys that are already present in existingKeys", () => {
        expect.assertions(2);

        const block = buildPackageSecretsBlock(["@lunora/auth"], new Set(["AUTH_SECRET"]));

        // AUTH_SECRET is already present — should not appear.
        expect(block).not.toContain("AUTH_SECRET=");
        // AUTH_URL is not in existingKeys — should appear.
        expect(block).toContain("AUTH_URL=");
    });

    it("returns empty string when all keys are already present", () => {
        expect.assertions(1);

        // Include the always-present core token so the block is genuinely empty.
        const authKeys = new Set([...secretsForPackages(["@lunora/auth"]).map((entry) => entry.key), "LUNORA_ADMIN_TOKEN"]);

        expect(buildPackageSecretsBlock(["@lunora/auth"], authKeys)).toBe("");
    });

    it("never emits a real secret value — secret-keyed entries have placeholder values", () => {
        expect.assertions(1);

        const block = buildPackageSecretsBlock(["@lunora/auth", "@lunora/payment"], new Set());
        const values = secretEntryValues(block);

        expect(values.every((value) => isPlaceholderValue(value))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureDevVarsExample
// ─────────────────────────────────────────────────────────────────────────────

describe("ensureDevVarsExample", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "lunora-devvars-example-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("creates .dev.vars.example when it does not exist", () => {
        expect.assertions(3);

        const added = ensureDevVarsExample(dir, ["@lunora/auth"]);

        expect(added.length).toBeGreaterThan(0);
        expect(existsSync(join(dir, ".dev.vars.example"))).toBe(true);
        expect(readFileSync(join(dir, ".dev.vars.example"), "utf8")).toContain("AUTH_SECRET=");
    });

    it("appends missing secrets to an existing .dev.vars.example", () => {
        expect.assertions(3);

        writeFileSync(join(dir, ".dev.vars.example"), 'AUTH_SECRET="replace-me"\n', "utf8");

        const added = ensureDevVarsExample(dir, ["@lunora/auth"]);

        // AUTH_SECRET was already there; the core admin token + AUTH_URL are added.
        expect(added).toStrictEqual(["LUNORA_ADMIN_TOKEN", "AUTH_URL"]);

        const content = readFileSync(join(dir, ".dev.vars.example"), "utf8");

        expect(content).toContain('AUTH_SECRET="replace-me"');
        expect(content).toContain("AUTH_URL=");
    });

    it("is idempotent — re-running does not duplicate keys", () => {
        expect.assertions(2);

        ensureDevVarsExample(dir, ["@lunora/auth"]);
        const firstContent = readFileSync(join(dir, ".dev.vars.example"), "utf8");

        ensureDevVarsExample(dir, ["@lunora/auth"]);
        const secondContent = readFileSync(join(dir, ".dev.vars.example"), "utf8");

        expect(secondContent).toBe(firstContent);

        // Count occurrences of AUTH_SECRET= — should be exactly 1.
        const occurrences = (secondContent.match(/AUTH_SECRET=/gu) ?? []).length;

        expect(occurrences).toBe(1);
    });

    it("returns an empty array when all secrets are already present", () => {
        expect.assertions(1);

        // Pre-populate with all auth entries plus the always-present core token.
        const authEntries = secretsForPackages(["@lunora/auth"]);
        const existing = `LUNORA_ADMIN_TOKEN="x"\n${authEntries.map((entry) => `${entry.key}="${entry.placeholderValue}"`).join("\n")}\n`;

        writeFileSync(join(dir, ".dev.vars.example"), existing, "utf8");

        const added = ensureDevVarsExample(dir, ["@lunora/auth"]);

        expect(added).toStrictEqual([]);
    });

    it("produces entries for multiple packages (auth + payment)", () => {
        expect.assertions(4);

        const added = ensureDevVarsExample(dir, ["@lunora/auth", "@lunora/payment"]);

        expect(added).toContain("AUTH_SECRET");
        expect(added).toContain("STRIPE_SECRET_KEY");
        expect(added).toContain("POLAR_ACCESS_TOKEN");

        const content = readFileSync(join(dir, ".dev.vars.example"), "utf8");

        expect(content).toContain("AUTH_SECRET=");
    });

    it("emits only the core LUNORA_ADMIN_TOKEN for packages with no registered secrets", () => {
        expect.assertions(2);

        const added = ensureDevVarsExample(dir, ["@lunora/runtime", "@lunora/client"]);

        // The packages contribute nothing, but the always-present core token is written.
        expect(added).toStrictEqual(["LUNORA_ADMIN_TOKEN"]);
        expect(existsSync(join(dir, ".dev.vars.example"))).toBe(true);
    });

    it("never writes a real secret value — secret-keyed entries have placeholder values", () => {
        expect.assertions(1);

        ensureDevVarsExample(dir, ["@lunora/auth", "@lunora/payment", "@lunora/mail"]);

        const content = readFileSync(join(dir, ".dev.vars.example"), "utf8");
        const values = secretEntryValues(content);

        expect(values.every((value) => isPlaceholderValue(value))).toBe(true);
    });

    it("produces RESEND_API_KEY for a mail-using project (LOW 3 regression)", () => {
        expect.assertions(3);

        const added = ensureDevVarsExample(dir, ["@lunora/mail"]);

        expect(added).toContain("RESEND_API_KEY");

        const content = readFileSync(join(dir, ".dev.vars.example"), "utf8");

        expect(content).toContain("RESEND_API_KEY=");

        // Must be a placeholder, not a real key.
        const values = secretEntryValues(content);

        expect(values.every((value) => isPlaceholderValue(value))).toBe(true);
    });

    it("includes description comments and docs URLs in the output", () => {
        expect.assertions(2);

        ensureDevVarsExample(dir, ["@lunora/auth"]);

        const content = readFileSync(join(dir, ".dev.vars.example"), "utf8");

        expect(content).toMatch(/^#.+/mu);
        expect(content).toContain("# Docs: https://lunora.sh/docs/packages/auth");
    });
});
