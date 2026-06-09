/* eslint-disable no-secrets/no-secrets -- fixtures intentionally contain placeholder secret-like strings */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDevVariables, planDevVariablesScaffold } from "../src/scaffold-dev-variables";

/** Deterministic stand-in for `crypto.randomBytes(n).toString("hex")`. */
const fixedHex = (bytes: number): string => "a".repeat(bytes * 2);

const EXAMPLE = `# Local dev secrets (gitignored).
# Generate a strong secret with: openssl rand -hex 32

AUTH_SECRET="replace-with-openssl-rand-hex-32"

# Base URL — not a secret, copied verbatim.
AUTH_URL="http://localhost:5173"

STORAGE_SECRET="replace-with-openssl-rand-hex-32"
CIRRUS_ADMIN_TOKEN="replace-with-openssl-rand-hex-32"
`;

describe("planDevVariablesScaffold", () => {
    it("reports `exists` when .dev.vars is already present", () => {
        expect.assertions(1);

        const plan = planDevVariablesScaffold({ devVarsExists: true, exampleContent: EXAMPLE });

        expect(plan.status).toBe("exists");
    });

    it("reports `no-example` when there is nothing to scaffold from", () => {
        expect.assertions(1);

        const plan = planDevVariablesScaffold({ devVarsExists: false, exampleContent: undefined });

        expect(plan.status).toBe("no-example");
    });

    it("fills secret-like placeholders with random hex and lists the generated keys", () => {
        expect.assertions(4);

        const plan = planDevVariablesScaffold({ devVarsExists: false, exampleContent: EXAMPLE, randomHex: fixedHex });

        if (plan.status !== "generate") {
            throw new Error(`expected "generate", got "${plan.status}"`);
        }

        expect(plan.generatedKeys).toStrictEqual(["AUTH_SECRET", "STORAGE_SECRET", "CIRRUS_ADMIN_TOKEN"]);
        // Secret keys get a fresh 64-char hex value.
        expect(plan.content).toContain(`AUTH_SECRET="${"a".repeat(64)}"`);
        // Non-secret values and comments are preserved verbatim.
        expect(plan.content).toContain('AUTH_URL="http://localhost:5173"');
        expect(plan.content).toContain("# Generate a strong secret with: openssl rand -hex 32");
    });

    it("catches common placeholder conventions beyond the example's own (todo / placeholder / change_this)", () => {
        expect.assertions(1);

        const plan = planDevVariablesScaffold({
            devVarsExists: false,
            exampleContent: 'AUTH_SECRET="TODO"\nAPI_KEY="PLACEHOLDER"\nWEBHOOK_TOKEN="CHANGE_THIS"\n',
            randomHex: fixedHex,
        });

        if (plan.status !== "generate") {
            throw new Error(`expected "generate", got "${plan.status}"`);
        }

        // All three are placeholders for secret-like keys → all regenerated.
        expect(plan.generatedKeys).toStrictEqual(["AUTH_SECRET", "API_KEY", "WEBHOOK_TOKEN"]);
    });

    it("leaves a secret-like key alone when the example already pins a real value", () => {
        expect.assertions(2);

        const plan = planDevVariablesScaffold({
            devVarsExists: false,
            exampleContent: 'SHARED_TOKEN="abc123def456"\n',
            randomHex: fixedHex,
        });

        if (plan.status !== "generate") {
            throw new Error(`expected "generate", got "${plan.status}"`);
        }

        expect(plan.generatedKeys).toStrictEqual([]);
        expect(plan.content).toContain('SHARED_TOKEN="abc123def456"');
    });
});

describe("ensureDevVariables", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "cirrus-devvars-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("does nothing when .dev.vars already exists", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars"), 'AUTH_SECRET="kept"\n', "utf8");
        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const confirm = vi.fn(async () => true);
        const result = await ensureDevVariables({ confirm, cwd: dir, info: () => undefined, randomHex: fixedHex });

        expect(result.status).toBe("exists");
        expect(confirm).not.toHaveBeenCalled();
    });

    it("stays silent when there is no example", async () => {
        expect.assertions(2);

        const confirm = vi.fn(async () => true);
        const result = await ensureDevVariables({ confirm, cwd: dir, info: () => undefined });

        expect(result.status).toBe("no-example");
        expect(confirm).not.toHaveBeenCalled();
    });

    it("generates .dev.vars after confirmation", async () => {
        expect.assertions(3);

        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const result = await ensureDevVariables({ confirm: async () => true, cwd: dir, info: () => undefined, randomHex: fixedHex });

        expect(result.status).toBe("generated");
        expect(result.generatedKeys).toStrictEqual(["AUTH_SECRET", "STORAGE_SECRET", "CIRRUS_ADMIN_TOKEN"]);
        expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toContain(`AUTH_SECRET="${"a".repeat(64)}"`);
    });

    it("generates without prompting when `yes` is set", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const confirm = vi.fn(async () => false);
        const result = await ensureDevVariables({ confirm, cwd: dir, info: () => undefined, randomHex: fixedHex, yes: true });

        expect(result.status).toBe("generated");
        expect(confirm).not.toHaveBeenCalled();
    });

    it("writes nothing when the user declines", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const result = await ensureDevVariables({ confirm: async () => false, cwd: dir, info: () => undefined, randomHex: fixedHex });

        expect(result.status).toBe("declined");
        expect(existsSync(join(dir, ".dev.vars"))).toBe(false);
    });
});
