/* eslint-disable no-secrets/no-secrets -- fixtures intentionally contain placeholder secret-like strings */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScaffoldPlan } from "../src/scaffold-dev-variables";
import {
    ensureDevVariables,
    fillDevSecrets,
    isPlaceholderValue,
    planDevSecretsFill,
    planDevVariablesAugment,
    planDevVariablesScaffold,
} from "../src/scaffold-dev-variables";

/**
 * A hook fired from inside a mocked `statSync`, right before it returns —
 * lets a test simulate a concurrent peer's write landing exactly between the
 * source's pre-write read and its pre-rename re-check. `undefined` (the
 * default) makes the mock behave exactly like the real `statSync`.
 */
let onStatSync: (() => void) | undefined;

// eslint-disable-next-line vitest/prefer-import-in-mock -- `vi.mock(import("node:fs"), ...)` type-checks the mock's shape too strictly against `statSync`'s (Stats | BigIntStats | undefined) overloads
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();

    return {
        ...actual,
        statSync: (...args: Parameters<typeof actual.statSync>) => {
            onStatSync?.();

            return actual.statSync(...args);
        },
    };
});

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

STORAGE_SIGNING_SECRET="replace-with-openssl-rand-hex-32"
LUNORA_ADMIN_TOKEN="replace-with-openssl-rand-hex-32"
`;

describe("isPlaceholderValue", () => {
    it("detects genuine placeholders (empty, angle-bracketed, and standalone markers)", () => {
        expect.assertions(8);

        expect(isPlaceholderValue("")).toBe(true);
        expect(isPlaceholderValue("   ")).toBe(true);
        expect(isPlaceholderValue("<your-key>")).toBe(true);
        expect(isPlaceholderValue("TODO")).toBe(true);
        expect(isPlaceholderValue("change-me")).toBe(true);
        expect(isPlaceholderValue("xxx")).toBe(true);
        // Marker as a token bounded by separators within a larger value.
        expect(isPlaceholderValue("replace-with-openssl-rand-hex-32")).toBe(true);
        expect(isPlaceholderValue("CHANGE_THIS")).toBe(true);
    });

    it("preserves prefix markers (`your-` / `your_`)", () => {
        expect.assertions(2);

        expect(isPlaceholderValue("your-api-key")).toBe(true);
        expect(isPlaceholderValue("your_secret_token")).toBe(true);
    });

    it("does not match a real value that merely contains a marker as a substring", () => {
        expect.assertions(5);

        // `todo` ⊂ `todoist`, but it is not a standalone token here.
        expect(isPlaceholderValue("https://todoist.com/hooks/abc")).toBe(false);
        // `example` ⊂ `examples`, glued to the rest of the word.
        expect(isPlaceholderValue("examplesoflife")).toBe(false);
        // `xxx` ⊂ a real-looking token with no boundary around it.
        expect(isPlaceholderValue("axxxk3yliteral")).toBe(false);
        // A 64-hex-char generated secret must never read as a placeholder.
        expect(isPlaceholderValue("a".repeat(64))).toBe(false);
        // `your` without the trailing separator is not the `your-`/`your_` prefix.
        expect(isPlaceholderValue("yourealthing")).toBe(false);
    });
});

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

        expect(plan.generatedKeys).toStrictEqual(["AUTH_SECRET", "STORAGE_SIGNING_SECRET", "LUNORA_ADMIN_TOKEN"]);
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
                exampleContent: 'AUTH_SECRET="TODO"\nSTORAGE_SIGNING_SECRET="PLACEHOLDER"\nLUNORA_ADMIN_TOKEN="CHANGE_THIS"\n',
                randomHex: fixedHex,
            }),
        );

        // All three are placeholders for registry secrets → all regenerated.
        expect(plan.generatedKeys).toStrictEqual(["AUTH_SECRET", "STORAGE_SIGNING_SECRET", "LUNORA_ADMIN_TOKEN"]);
    });

    it("leaves a secret-NAMED key the registry does not know unfilled, however placeholder-looking", () => {
        expect.assertions(4);

        const plan = generatePlan(
            planDevVariablesScaffold({
                devVarsExists: false,
                // Neither key is in the registry, so neither is one Lunora can mint:
                // a random value would be rejected by the provider at runtime AND
                // would hide the gap from `lunora env doctor`.
                exampleContent: 'OPENAI_API_KEY="<your-openai-api-key>"\nGITHUB_CLIENT_SECRET=""\nAUTH_SECRET="TODO"\n',
                randomHex: fixedHex,
            }),
        );

        expect(plan.generatedKeys).toStrictEqual(["AUTH_SECRET"]);
        expect(plan.content).toContain('OPENAI_API_KEY="<your-openai-api-key>"');
        expect(plan.content).toContain('GITHUB_CLIENT_SECRET=""');
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

    it("never mints provider-issued keys — their placeholders survive so they stay detectable as unfilled", () => {
        expect.assertions(5);

        const plan = generatePlan(
            planDevVariablesScaffold({
                devVarsExists: false,
                // RESEND_API_KEY / STRIPE_SECRET_KEY are provider-issued (in the registry with `<…>`
                // placeholders): Lunora cannot mint a valid value, so they must be left verbatim.
                exampleContent:
                    'RESEND_API_KEY="<your-resend-api-key>"\nSTRIPE_SECRET_KEY="<your-stripe-secret-key>"\nAUTH_SECRET="replace-with-openssl-rand-hex-32"\n',
                randomHex: fixedHex,
            }),
        );

        // Only the locally-mintable AUTH_SECRET is generated; the provider keys are untouched.
        expect(plan.generatedKeys).toStrictEqual(["AUTH_SECRET"]);
        expect(plan.content).toContain('RESEND_API_KEY="<your-resend-api-key>"');
        expect(plan.content).toContain('STRIPE_SECRET_KEY="<your-stripe-secret-key>"');
        // The provider placeholders remain detectable as unfilled by `lunora env doctor`.
        expect(isPlaceholderValue("<your-resend-api-key>")).toBe(true);
    });

    it("does not regenerate a real secret whose value merely contains a marker substring", () => {
        expect.assertions(4);

        const plan = generatePlan(
            planDevVariablesScaffold({
                devVarsExists: false,
                // `todo` ⊂ `todoist`, `example` ⊂ the URL — but neither is a standalone token.
                exampleContent: 'WEBHOOK_SECRET="https://todoist.com/hooks/abc"\nDEPLOY_TOKEN="prodexamplesecret"\n',
                randomHex: fixedHex,
            }),
        );

        // Substring-collision values are real → kept verbatim, never overwritten.
        expect(plan.generatedKeys).toStrictEqual([]);
        expect(plan.content).toContain('WEBHOOK_SECRET="https://todoist.com/hooks/abc"');
        expect(plan.content).toContain('DEPLOY_TOKEN="prodexamplesecret"');
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

    it("re-escapes a newline the example spelled as an escape, keeping the entry one line", () => {
        expect.assertions(1);

        // dotenv EXPANDS `\n` inside a double-quoted value, so copying the parsed
        // value through would have written a physical line break into `.dev.vars`
        // — and every rewrite here is line-oriented, so the tail would be orphaned.
        const plan = planDevVariablesAugment({
            exampleContent: `${String.raw`BANNER="one\ntwo"`}\n`,
            existingContent: "",
            randomHex: fixedHex,
        });

        expect(plan.additions).toStrictEqual([String.raw`BANNER="one\ntwo"`]);
    });

    it("empties a value carrying a quote, which a double-quoted entry cannot spell", () => {
        expect.assertions(2);

        // dotenv does not unescape `\"`, so there is no form that round-trips a
        // literal quote; emitting it would close the entry early and silently
        // truncate. An empty placeholder is the honest answer.
        const plan = planDevVariablesAugment({
            exampleContent: 'GREETING="say \\"hi\\""\n',
            existingContent: "",
            randomHex: fixedHex,
        });

        expect(plan.missingKeys).toStrictEqual(["GREETING"]);
        expect(plan.additions).toStrictEqual(['GREETING=""']);
    });

    it("renders additions for missing keys: secrets generated, plain values copied", () => {
        expect.assertions(3);

        const plan = planDevVariablesAugment({
            exampleContent: 'AUTH_SECRET="real"\nAUTH_URL="http://localhost:5173"\nSTORAGE_SIGNING_SECRET="replace-me"\n',
            existingContent: 'AUTH_SECRET="real"\n',
            randomHex: fixedHex,
        });

        expect(plan.missingKeys).toStrictEqual(["AUTH_URL", "STORAGE_SIGNING_SECRET"]);
        expect(plan.generatedKeys).toStrictEqual(["STORAGE_SIGNING_SECRET"]);
        // Non-secret copied verbatim; secret placeholder regenerated.
        expect(plan.additions).toStrictEqual(['AUTH_URL="http://localhost:5173"', `STORAGE_SIGNING_SECRET="${"a".repeat(64)}"`]);
    });
});

describe("ensureDevVariables", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "lunora-devvars-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("does nothing when .dev.vars already has every example key", async () => {
        expect.assertions(2);

        // A complete file — all four example keys present.
        writeFileSync(
            join(dir, ".dev.vars"),
            'AUTH_SECRET="kept"\nAUTH_URL="http://localhost:5173"\nSTORAGE_SIGNING_SECRET="kept"\nLUNORA_ADMIN_TOKEN="kept"\n',
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

        // Only AUTH_SECRET present locally; the example also wants AUTH_URL, STORAGE_SIGNING_SECRET, LUNORA_ADMIN_TOKEN.
        writeFileSync(join(dir, ".dev.vars"), 'AUTH_SECRET="my-real-secret"\n', "utf8");
        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const result = await ensureDevVariables({ confirm: async () => true, cwd: dir, info: () => undefined, randomHex: fixedHex });
        const written = readFileSync(join(dir, ".dev.vars"), "utf8");

        expect(result.status).toBe("augmented");
        expect(result.addedKeys).toStrictEqual(["AUTH_URL", "STORAGE_SIGNING_SECRET", "LUNORA_ADMIN_TOKEN"]);
        // Existing value is preserved; missing secret keys are appended with fresh hex.
        expect(written).toContain('AUTH_SECRET="my-real-secret"');
        expect(written).toContain(`STORAGE_SIGNING_SECRET="${"a".repeat(64)}"`);
    });

    it("merges a concurrent peer's append instead of clobbering it (compare-and-swap retry)", async () => {
        expect.assertions(4);

        // Only AUTH_SECRET present locally; the example also wants AUTH_URL, STORAGE_SIGNING_SECRET, LUNORA_ADMIN_TOKEN.
        writeFileSync(join(dir, ".dev.vars"), 'AUTH_SECRET="my-real-secret"\n', "utf8");
        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        // Simulate a peer process winning the race: right after our first
        // pre-write fingerprint (the 1st statSync call), it lands its own
        // append (adding AUTH_URL) before our pre-rename re-check (the 2nd
        // statSync call) runs. The re-check must see a changed file — sending
        // us back to re-read + re-plan (picking up the peer's AUTH_URL as
        // already-present) — rather than overwriting the peer's file with our
        // stale, pre-peer content.
        let statCalls = 0;

        onStatSync = () => {
            statCalls += 1;

            if (statCalls === 2) {
                writeFileSync(join(dir, ".dev.vars"), 'AUTH_SECRET="my-real-secret"\nAUTH_URL="http://localhost:5173"\n', "utf8");
            }
        };

        try {
            const result = await ensureDevVariables({ confirm: async () => true, cwd: dir, info: () => undefined, randomHex: fixedHex });
            const written = readFileSync(join(dir, ".dev.vars"), "utf8");

            expect(result.status).toBe("augmented");
            // Our attempt still added the remaining keys (STORAGE_SIGNING_SECRET, LUNORA_ADMIN_TOKEN) —
            // AUTH_URL is no longer "missing" once re-planned against the peer's content.
            expect(result.addedKeys).toStrictEqual(["STORAGE_SIGNING_SECRET", "LUNORA_ADMIN_TOKEN"]);
            // Both the peer's key and our keys survive in the final file.
            expect(written).toContain('AUTH_URL="http://localhost:5173"');
            expect(written).toContain(`STORAGE_SIGNING_SECRET="${"a".repeat(64)}"`);
        } finally {
            onStatSync = undefined;
        }
    });

    it("reports `exists` (no info line) when a peer lands every missing key before our write", async () => {
        expect.assertions(3);

        // Only AUTH_SECRET present locally; the example also wants AUTH_URL, STORAGE_SIGNING_SECRET, LUNORA_ADMIN_TOKEN.
        writeFileSync(join(dir, ".dev.vars"), 'AUTH_SECRET="my-real-secret"\n', "utf8");
        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        // Peer wins the whole race: between our fingerprint and our re-check it
        // lands *all* the missing keys. Our re-plan then finds nothing to add, so
        // the append writes zero lines — that must surface as an unchanged file
        // (`exists`), not a dangling `Updated .dev.vars — added .` log.
        let statCalls = 0;

        onStatSync = () => {
            statCalls += 1;

            if (statCalls === 2) {
                writeFileSync(
                    join(dir, ".dev.vars"),
                    'AUTH_SECRET="my-real-secret"\nAUTH_URL="http://localhost:5173"\nSTORAGE_SIGNING_SECRET="peer"\nLUNORA_ADMIN_TOKEN="peer"\n',
                    "utf8",
                );
            }
        };

        const info = vi.fn<(message: string) => void>();

        try {
            const result = await ensureDevVariables({ confirm: async () => true, cwd: dir, info, randomHex: fixedHex });

            expect(result.status).toBe("exists");
            expect(result.addedKeys).toStrictEqual([]);
            expect(info).not.toHaveBeenCalled();
        } finally {
            onStatSync = undefined;
        }
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
        expect(result.generatedKeys).toStrictEqual(["AUTH_SECRET", "STORAGE_SIGNING_SECRET", "LUNORA_ADMIN_TOKEN"]);
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

    it("leaves no temp file behind after generating atomically", async () => {
        expect.assertions(3);

        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        const result = await ensureDevVariables({ confirm: async () => true, cwd: dir, info: () => undefined, randomHex: fixedHex });

        expect(result.status).toBe("generated");
        // The file exists with the generated content...
        expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toContain(`AUTH_SECRET="${"a".repeat(64)}"`);
        // ...and the sibling temp path used for the atomic rename is gone.
        expect(existsSync(join(dir, `.dev.vars.tmp-${String(process.pid)}`))).toBe(false);
    });

    it("cleans up the temp file and rethrows when the atomic write fails", async () => {
        expect.assertions(3);

        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");
        // Pre-create the exclusive-create temp path so `writeFileSync(..., { flag: "wx" })` fails.
        const temporaryPath = join(dir, `.dev.vars.tmp-${String(process.pid)}`);

        writeFileSync(temporaryPath, "stale", "utf8");

        // The exclusive-create (`wx`) write fails because the temp path already exists.
        await expect(ensureDevVariables({ confirm: async () => true, cwd: dir, info: () => undefined, randomHex: fixedHex })).rejects.toThrow(/EEXIST/u);

        // The stale temp is removed by the cleanup path, and no .dev.vars was produced.
        expect(existsSync(temporaryPath)).toBe(false);
        expect(existsSync(join(dir, ".dev.vars"))).toBe(false);
    });

    it("skips the write when another process creates .dev.vars after the existence check", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars.example"), EXAMPLE, "utf8");

        // Simulate the create-race: a peer drops the file in during the `confirm`
        // prompt, between the initial existsSync and the atomic rename.
        const confirm = vi.fn<Confirm>(async () => {
            writeFileSync(join(dir, ".dev.vars"), 'AUTH_SECRET="peer-secret"\n', "utf8");

            return true;
        });
        const result = await ensureDevVariables({ confirm, cwd: dir, info: () => undefined, randomHex: fixedHex });

        expect(result.status).toBe("skipped-exists");
        // The peer's file is left untouched.
        expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe('AUTH_SECRET="peer-secret"\n');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// planDevSecretsFill — pure
// ─────────────────────────────────────────────────────────────────────────────

describe("planDevSecretsFill", () => {
    it("fills empty secret-keyed values + appends the missing core admin token", () => {
        expect.assertions(5);

        // A `lunora add`-scaffolded .dev.vars: secrets blank, a non-secret URL, no admin token.
        const existing = "# comment\nBETTER_AUTH_SECRET=\nBETTER_AUTH_URL=http://localhost:8787\nSTORAGE_SIGNING_SECRET=\n";

        const plan = planDevSecretsFill({ existingContent: existing, randomHex: fixedHex });

        // Both empty secret-keyed vars are filled.
        expect(plan.filledKeys).toStrictEqual(["BETTER_AUTH_SECRET", "STORAGE_SIGNING_SECRET"]);
        // The core admin token is appended (it was absent).
        expect(plan.addedKeys).toStrictEqual(["LUNORA_ADMIN_TOKEN"]);
        // Filled with a real generated value; the comment + non-secret URL are kept verbatim.
        expect(plan.content).toContain(`BETTER_AUTH_SECRET="${"a".repeat(64)}"`);
        expect(plan.content).toContain("BETTER_AUTH_URL=http://localhost:8787");
        expect(plan.content).toContain(`LUNORA_ADMIN_TOKEN="${"a".repeat(64)}"`);
    });

    it("never overwrites a real (non-placeholder) secret value", () => {
        expect.assertions(2);

        const existing = 'BETTER_AUTH_SECRET="my-real-secret-value-kept"\nLUNORA_ADMIN_TOKEN="my-token"\n';

        const plan = planDevSecretsFill({ existingContent: existing, randomHex: fixedHex });

        expect(plan.filledKeys).toStrictEqual([]);
        expect(plan.addedKeys).toStrictEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// fillDevSecrets — I/O
// ─────────────────────────────────────────────────────────────────────────────

describe("fillDevSecrets", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "lunora-fill-secrets-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("fills a feature-scaffolded .dev.vars (blank secrets, no admin token) so dev boots with real values", () => {
        expect.assertions(4);

        // Mirrors what `lunora add auth storage` writes: secrets blank, no admin token.
        writeFileSync(join(dir, ".dev.vars"), "BETTER_AUTH_SECRET=\nBETTER_AUTH_URL=http://localhost:8787\nSTORAGE_SIGNING_SECRET=\n", "utf8");

        const result = fillDevSecrets({ cwd: dir, randomHex: (bytes) => "a".repeat(bytes * 2) });

        expect(result.status).toBe("filled");
        expect(result.filledKeys).toStrictEqual(["BETTER_AUTH_SECRET", "STORAGE_SIGNING_SECRET"]);
        expect(result.addedKeys).toStrictEqual(["LUNORA_ADMIN_TOKEN"]);

        const content = readFileSync(join(dir, ".dev.vars"), "utf8");

        // The Studio reads this token to skip its login gate in dev.
        expect(content).toContain(`LUNORA_ADMIN_TOKEN="${"a".repeat(64)}"`);
    });

    it("creates .dev.vars with a generated admin token when none exists", () => {
        expect.assertions(3);

        const result = fillDevSecrets({ cwd: dir, randomHex: (bytes) => "b".repeat(bytes * 2) });

        expect(result.status).toBe("created");
        expect(result.addedKeys).toStrictEqual(["LUNORA_ADMIN_TOKEN"]);
        expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toContain(`LUNORA_ADMIN_TOKEN="${"b".repeat(64)}"`);
    });

    it("is idempotent — a second run with everything filled changes nothing", () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars"), "BETTER_AUTH_SECRET=\n", "utf8");
        fillDevSecrets({ cwd: dir, randomHex: (bytes) => "c".repeat(bytes * 2) });
        const afterFirst = readFileSync(join(dir, ".dev.vars"), "utf8");

        const second = fillDevSecrets({ cwd: dir, randomHex: (bytes) => "d".repeat(bytes * 2) });

        expect(second.status).toBe("unchanged");
        // The second run must not regenerate (and so must not change) the values.
        expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe(afterFirst);
    });
});
