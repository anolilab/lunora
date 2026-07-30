import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectWranglerSecretVariables, scanWranglerVariablesForSecrets } from "../src/cloudflare/wrangler-secret-variables";

describe("scanWranglerVariablesForSecrets", () => {
    it("flags a value that matches a known secret shape", () => {
        expect.assertions(2);

        // `sk_live_` (8) + 22 alphanumerics = 30 chars; ≥ 20 trailing chars matches the Stripe live-key shape.
        // eslint-disable-next-line no-secrets/no-secrets -- a fake Stripe-shaped fixture, not a real credential
        const findings = scanWranglerVariablesForSecrets({ STRIPE_KEY: "sk_live_ABCDEFGHIJKLMNOPQRSTUV" }, "wrangler.jsonc"); // gitleaks:allow -- a fake Stripe-shaped fixture, not a real credential

        expect(findings).toHaveLength(1);
        // Only the redacted preview crosses the boundary — never the full value.
        expect(findings[0]).toEqual({ file: "wrangler.jsonc", key: "STRIPE_KEY", kind: "stripe_live_key", preview: "sk_l…(30 chars)" });
    });

    it("flags a secret-named key whose value is long enough, as `secret_named_var`", () => {
        expect.assertions(2);

        // eslint-disable-next-line no-secrets/no-secrets -- a fake webhook-secret fixture, not a real credential
        const findings = scanWranglerVariablesForSecrets({ WEBHOOK_SECRET: "whsec_9f8e7d6c5b4a3210ffee" }, "wrangler.jsonc");

        expect(findings).toHaveLength(1);
        expect(findings[0]?.kind).toBe("secret_named_var");
    });

    it("ignores placeholders, public keys, short values, non-strings, and benign keys", () => {
        expect.assertions(1);

        const variables: Record<string, unknown> = {
            // placeholder value
            API_SECRET: "<your-secret-here>",
            CACHE_TTL: "60",
            // eslint-disable-next-line no-secrets/no-secrets -- a fake public key fixture (public keys ship in cleartext), not a real credential
            NEXT_PUBLIC_API_KEY: "pk_live_51ABCdefGHIjklMNOpqrSTUv", // gitleaks:allow -- a fake public key fixture, not a real credential
            // bare `*_KEY` config, not a secret shape
            PARTITION_KEY: "orders",
            // non-string values are typed vars, not plaintext secrets
            RETRIES: 3,
            // secret-named but value too short to be a real secret
            SESSION_TOKEN: "v1",
            // eslint-disable-next-line no-secrets/no-secrets -- a fake public key fixture (public keys ship in cleartext), not a real credential
            STRIPE_PUBLISHABLE_KEY: "pk_live_51ABCdefGHIjklMNOpqrSTUv", // gitleaks:allow -- a fake public key fixture, not a real credential
        };

        const findings = scanWranglerVariablesForSecrets(variables, "wrangler.jsonc");

        expect(findings).toHaveLength(0);
    });

    it("returns nothing when there is no `vars` block", () => {
        expect.assertions(1);
        expect(scanWranglerVariablesForSecrets(undefined, "wrangler.jsonc")).toHaveLength(0);
    });
});

describe("collectWranglerSecretVariables", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-wrangler-secret-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("reads wrangler.jsonc (comments + trailing commas) and reports plaintext secrets", () => {
        expect.assertions(2);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            // eslint-disable-next-line no-secrets/no-secrets -- a fake committed secret fixture — the exact footgun this lint catches — not a real credential
            `{
                // committed secret in cleartext vars — the footgun this lint catches
                "name": "app",
                "vars": {
                    "STRIPE_SECRET_KEY": "sk_live_ABCDEFGHIJKLMNOPQRSTUV", // gitleaks:allow -- a fake committed secret fixture (the footgun this lint catches), not a real credential
                    "PUBLIC_URL": "https://example.com",
                },
            }`,
            "utf8",
        );

        const findings = collectWranglerSecretVariables(root);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ file: "wrangler.jsonc", key: "STRIPE_SECRET_KEY", kind: "stripe_live_key" });
    });

    it("returns [] when no wrangler config exists", () => {
        expect.assertions(1);
        expect(collectWranglerSecretVariables(root)).toHaveLength(0);
    });
});
