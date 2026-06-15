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

    it("records nothing for a module with no secret-shaped literals", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "clean.ts"), CLEAN, "utf8");

        expect(discoverSecrets(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
