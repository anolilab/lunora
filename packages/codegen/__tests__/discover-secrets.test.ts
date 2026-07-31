import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverSecrets from "../src/discover-secrets";

// Secret-shaped literals across the provider rules. The values are synthetic —
// shaped to match each gitleaks-style pattern without being live credentials.
// eslint-disable-next-line no-secrets/no-secrets -- synthetic fixtures, not real credentials
const SECRETS = `
    export const stripe = "sk_live_0123456789abcdefABCDEFghij"; // gitleaks:allow
    export const aws = "AKIAIOSFODNN7EXAMPLE";
    export const note = "just a short ordinary string";
`;

/** A clean module with no secret-shaped literals. */
const CLEAN = `
    export const greeting = "hello world";
    export const count = 42;
`;

/** A 64-char single-case hex value reused by the heuristic-gating tests under two different binding names. */
const HEX_VALUE = "a3f9c2e1b7d8049f5c6a1e2d3b4c5f6071829304a1b2c3d4e5f60718293a4b5c6";

/** A vendor-prefixed key inside a test file — evidence-carrying, so still reported. */
// eslint-disable-next-line no-secrets/no-secrets -- synthetic fixture, not a real credential
const STRIPE_IN_TEST = `
    const client = "sk_live_0123456789abcdefABCDEFghij"; // gitleaks:allow
`;

/** An all-lowercase 64-char hex key — single-case, missed by the mixed-charset rule. */
const HEX_KEY = `
    export const hmac = "a3f9c2e1b7d8049f5c6a1e2d3b4c5f6071829304a1b2c3d4e5f60718293a4b5c6";
`;

/** A secret split across `+`-concatenated string literals — folded into one token before matching. */
// eslint-disable-next-line no-secrets/no-secrets -- synthetic fixture, not a real credential
const CONCAT_SECRET = `
    export const key = "a3f9c2e1b7d8049f5c6a1e2d3b" + "4c5f6071829304a1b2c3d4e5f60718293a4b5c6";
`;

/**
 * A complete secret literal concatenated with a *dynamic* operand — the top-level
 * `+` root folds to `undefined`, so the fully-formed literal must be scanned on its
 * own rather than lost with the un-foldable root.
 */
// eslint-disable-next-line no-secrets/no-secrets -- synthetic fixture, not a real credential
const CONCAT_SECRET_DYNAMIC = `
    export function makeKey(suffix: string) {
        return "sk_live_0123456789abcdefABCDEFghij" + suffix; // gitleaks:allow
    }
`;

/** A secret key literal joined with a dynamic host and a static `/path` tail — still surfaced. */
// eslint-disable-next-line no-secrets/no-secrets -- synthetic fixture, not a real credential
const CONCAT_SECRET_PATH = `
    export function makeUrl(host: string) {
        return "sk_live_0123456789abcdefABCDEFghij" + host + "/path"; // gitleaks:allow
    }
`;

let workdir: string;
let project: Project;

describe("discoverSecrets", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-secrets-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a Stripe live key and an AWS access key, redacting the value", () => {
        expect.assertions(3);

        writeFileSync(join(workdir, "lunora", "config.ts"), SECRETS, "utf8");

        const found = discoverSecrets(project, join(workdir, "lunora"));
        const kinds = found.map((secret) => secret.kind).toSorted((a, b) => a.localeCompare(b));

        expect(kinds).toStrictEqual(["aws_access_key", "stripe_live_key"]);
        expect(found.every((secret) => secret.preview.includes("chars)"))).toBe(true);
        expect(found.every((secret) => !secret.preview.includes("EXAMPLE"))).toBe(true);
    });

    it("flags an all-lowercase hex key the mixed-charset rule would miss", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "hmac.ts"), HEX_KEY, "utf8");

        const found = discoverSecrets(project, join(workdir, "lunora"));

        expect(found.map((secret) => secret.kind)).toStrictEqual(["hex_secret"]);
    });

    it("flags a secret split across +-concatenated string literals", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "concat.ts"), CONCAT_SECRET, "utf8");

        const found = discoverSecrets(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
    });

    it("flags a complete secret literal concatenated with a dynamic operand", () => {
        expect.assertions(3);

        writeFileSync(join(workdir, "lunora", "dynamic.ts"), CONCAT_SECRET_DYNAMIC, "utf8");

        const found = discoverSecrets(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.kind).toBe("stripe_live_key");
        expect(found[0]?.preview).toContain("chars)");
    });

    it("surfaces a secret key literal joined with a dynamic host and a static path", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "path.ts"), CONCAT_SECRET_PATH, "utf8");

        const found = discoverSecrets(project, join(workdir, "lunora"));

        expect(found.map((secret) => secret.kind)).toStrictEqual(["stripe_live_key"]);
        expect(found[0]?.preview.includes("/path")).toBe(false);
    });

    it("records nothing for a module with no secret-shaped literals", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "clean.ts"), CLEAN, "utf8");

        expect(discoverSecrets(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    // `hardcoded_secret` produced ten findings on the first
    // large port and all ten were the W3C Trace Context specification's example
    // trace ids in `lib/traceparent.test.ts` — the canonical values every
    // traceparent implementation tests against. Signal-to-noise was zero, and
    // under #35 that would have blocked the build.
    //
    // Only the two heuristic kinds (`hex_secret`, `high_entropy`) are gated. A
    // vendor-prefixed literal carries its own evidence and is a leak wherever it
    // appears, tests included.
    it("ignores a spec fixture in a test file but still flags a vendor key there", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "traceparent.test.ts"), `const traceId = "0af7651916cd43dd8448eb211c80319c";\n`, "utf8");
        writeFileSync(join(workdir, "lunora", "stripe.test.ts"), STRIPE_IN_TEST, "utf8");

        const found = discoverSecrets(project, join(workdir, "lunora"));

        expect(found.filter((secret) => secret.file.includes("traceparent"))).toHaveLength(0);
        expect(found.filter((secret) => secret.file.includes("stripe")).map((secret) => secret.kind)).toStrictEqual(["stripe_live_key"]);
    });

    it("requires a secret-ish binding name for a heuristic match outside tests", () => {
        expect.assertions(2);

        // The same literal under two names. A content hash is shaped exactly
        // like a key, so shape alone cannot carry the finding.
        writeFileSync(join(workdir, "lunora", "digest.ts"), `export const contentHash = "${HEX_VALUE}";\n`, "utf8");
        writeFileSync(join(workdir, "lunora", "signer.ts"), `export const signingKey = "${HEX_VALUE}";\n`, "utf8");

        const found = discoverSecrets(project, join(workdir, "lunora"));

        expect(found.filter((secret) => secret.file.includes("digest"))).toHaveLength(0);
        expect(found.filter((secret) => secret.file.includes("signer")).map((secret) => secret.kind)).toStrictEqual(["hex_secret"]);
    });
});
