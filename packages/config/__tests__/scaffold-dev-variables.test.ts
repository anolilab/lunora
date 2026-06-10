/* eslint-disable no-secrets/no-secrets -- fixtures intentionally contain placeholder secret-like strings */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScaffoldPlan } from "../src/scaffold-dev-variables";
import { ensureDevVariables, planDevVariablesAugment, planDevVariablesScaffold } from "../src/scaffold-dev-variables";

/** Deterministic stand-in for `crypto.randomBytes(n).toString("hex")`. */
const fixedHex = (bytes: number): string => "a".repeat(bytes * 2);

/** The `confirm` dependency signature, for typing `vi.fn()` mocks. */
type Confirm = (message: string) => Promise<boolean>;

/**
 * Narrow a {@link ScaffoldPlan} to its `generate` variant, failing the test
 * unconditionally if it isn't. Keeps the status check out of the test body so
 * the discriminant assertion stays unconditional.
 */
const generatePlan = (plan: ScaffoldPlan): Extract<ScaffoldPlan, { status: "generate" }> => {
    expect(plan.status).toBe("generate");

    return plan as Extract<ScaffoldPlan, { status: "generate" }>;
};

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
        expect.assertions(5);

        const plan = generatePlan(planDevVariablesScaffold({ devVarsExists: false, exampleContent: EXAMPLE, randomHex: fixedHex }));

        expect(plan.generatedKeys).toStrictEqual(["AUTH_SECRET", "STORAGE_SECRET", "CIRRUS_ADMIN_TOKEN"]);
        // Secret keys get a fresh 64-char hex value.
        expect(plan.content).toContain(`AUTH_SECRET="${"a".repeat(64)}"`);
        // Non-secret values and comments are preserved verbatim.
        expect(plan.content).toContain('AUTH_URL="http://localhost:5173"');
        expect(plan.content).toContain("# Generate a strong secret with: openssl rand -hex 32");
    });

    it("catches common placeholder conventions beyond the example's own (todo / placeholder / change_this)", () => {
        expect.assertions(2);

        const plan = generatePlan(
            planDevVariablesScaffold({
                devVarsExists: false,
                exampleContent: 'AUTH_SECRET="TODO"\nAPI_KEY="PLACEHOLDER"\nWEBHOOK_TOKEN="CHANGE_THIS"\n',
                randomHex: fixedHex,
            }),
        );

        // All three are placeholders for secret-like keys → all regenerated.
        expect(plan.generatedKeys).toStrictEqual(["AUTH_SECRET", "API_KEY", "WEBHOOK_TOKEN"]);
    });

    it("leaves a secret-like key alone when the example already pins a real value", () => {
        expect.assertions(3);

        const plan = generatePlan(
            planDevVariablesScaffold({
                devVarsExists: false,
                exampleContent: 'SHARED_TOKEN="abc123def456"\n',
                randomHex: fixedHex,
            }),
        );

        expect(plan.generatedKeys).toStrictEqual([]);
        expect(plan.content).toContain('SHARED_TOKEN="abc123def456"');
    });
});

describe("planDevVariablesAugment", () => {
    it("reports no missing keys when the file already has them all", () => {
        expect.assertions(2);

        const plan = planDevVariablesAugment({
            exampleContent: 'AUTH_SECRET="replace"\nAUTH_URL="x"\n',
            existingContent: 'AUTH_SECRET="real"\nAUTH_URL="y"\n',
            randomHex: fixedHex,
        });

        expect(plan.missingKeys).toStrictEqual([]);
        expect(plan.additions).toStrictEqual([]);
    });

    it("renders additions for missing keys: secrets generated, plain values copied", () => {
        expect.assertions(3);

        const plan = planDevVariablesAugment({
            exampleContent: 'AUTH_SECRET="real"\nAUTH_URL="http://localhost:5173"\nSTORAGE_SECRET="replace-me"\n',
            existingContent: 'AUTH_SECRET="real"\n',
            randomHex: fixedHex,
        });

        expect(plan.missingKeys).toStrictEqual(["AUTH_URL", "STORAGE_SECRET"]);
        expect(plan.generatedKeys).toStrictEqual(["STORAGE_SECRET"]);
        // Non-secret copied verbatim; secret placeholder regenerated.
        expect(plan.additions).toStrictEqual(['AUTH_URL="http://localhost:5173"', `STORAGE_SECRET="${"a".repeat(64)}"`]);
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

    it("does nothing when .dev.vars already has every example key", async () => {
        expect.assertions(2);

        // A complete file — all four example keys present.
        writeFileSync(
            join(dir, ".dev.vars"),
            'AUTH_SECRET="kept"\nAUTH_URL="http://localhost:5173"\nSTORAGE_SECRET="kept"\nCIRRUS_ADMIN_TOKEN="kept"\n',
            "utf8",
        );
        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const confirm = vi.fn<Confirm>(async () => true);
        const result = await ensureDevVariables({ confirm, cwd: dir, info: () => undefined, randomHex: fixedHex });

        expect(result.status).toBe("exists");
        expect(confirm).not.toHaveBeenCalled();
    });

    it("appends keys the example lists but .dev.vars is missing", async () => {
        expect.assertions(4);

        // Only AUTH_SECRET present locally; the example also wants AUTH_URL, STORAGE_SECRET, CIRRUS_ADMIN_TOKEN.
        writeFileSync(join(dir, ".dev.vars"), 'AUTH_SECRET="my-real-secret"\n', "utf8");
        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const result = await ensureDevVariables({ confirm: async () => true, cwd: dir, info: () => undefined, randomHex: fixedHex });
        const written = readFileSync(join(dir, ".dev.vars"), "utf8");

        expect(result.status).toBe("augmented");
        expect(result.addedKeys).toStrictEqual(["AUTH_URL", "STORAGE_SECRET", "CIRRUS_ADMIN_TOKEN"]);
        // Existing value is preserved; missing secret keys are appended with fresh hex.
        expect(written).toContain('AUTH_SECRET="my-real-secret"');
        expect(written).toContain(`STORAGE_SECRET="${"a".repeat(64)}"`);
    });

    it("does not append when the user declines the missing-key prompt", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars"), 'AUTH_SECRET="my-real-secret"\n', "utf8");
        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const result = await ensureDevVariables({ confirm: async () => false, cwd: dir, info: () => undefined, randomHex: fixedHex });

        expect(result.status).toBe("declined");
        expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe('AUTH_SECRET="my-real-secret"\n');
    });

    it("stays silent when there is no example", async () => {
        expect.assertions(2);

        const confirm = vi.fn<Confirm>(async () => true);
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

        const confirm = vi.fn<Confirm>(async () => false);
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
