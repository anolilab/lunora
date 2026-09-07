import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPublicKeyName, isSecretKeyName } from "../../../shared/secret-key";
import { collectWranglerSecretVariables, scanWranglerVariablesForSecrets } from "../src/cloudflare/wrangler-secret-variables";

/**
 * The key-name classifier is `shared/secret-key.ts` — the SAME function
 * `lunora deploy` builds its required-secrets list from and `@lunora/server`
 * redacts a thrown env error with. This module used to carry a second,
 * materially different rule under the same name, so the cases below are the ones
 * the two disagreed on: a deploy that "succeeded" then crashed on an unset
 * `SENTRY_DSN`, and a deploy blocked as missing a `STRIPE_PUBLISHABLE_KEY` that
 * is meant to ship in cleartext.
 */
describe("isSecretKeyName (shared/secret-key)", () => {
    it("treats a whole-word secret name as a secret, whatever the separator convention", () => {
        expect.assertions(8);

        expect(isSecretKeyName("SENTRY_DSN")).toBe(true);
        expect(isSecretKeyName("SMTP_PASSWD")).toBe(true);
        expect(isSecretKeyName("GOOGLE_CREDENTIALS")).toBe(true);
        expect(isSecretKeyName("BACKUP_PASSPHRASE")).toBe(true);
        expect(isSecretKeyName("auth-token")).toBe(true);
        // camelCase splits on the case boundary, so `apiToken` is not config.
        expect(isSecretKeyName("apiToken")).toBe(true);
        // Run-together spellings no word split recovers.
        expect(isSecretKeyName("OPENAI_APIKEY")).toBe(true);
        expect(isSecretKeyName("MYPASSWORD")).toBe(true);
    });

    it("treats a compound *_KEY suffix as a secret but a bare KEY as ordinary config", () => {
        expect.assertions(6);

        expect(isSecretKeyName("OPENAI_API_KEY")).toBe(true);
        expect(isSecretKeyName("AWS_SECRET_ACCESS_KEY")).toBe(true);
        expect(isSecretKeyName("apiKey")).toBe(true);
        // The over-match that blocked a non-interactive deploy on a value the
        // worker never needed as a secret.
        expect(isSecretKeyName("PARTITION_KEY")).toBe(false);
        expect(isSecretKeyName("IDEMPOTENCY_KEY")).toBe(false);
        expect(isSecretKeyName("MONKEY")).toBe(false);
    });

    it("exempts a name that advertises itself as public/publishable", () => {
        expect.assertions(4);

        expect(isSecretKeyName("STRIPE_PUBLISHABLE_KEY")).toBe(false);
        expect(isSecretKeyName("NEXT_PUBLIC_API_KEY")).toBe(false);
        expect(isPublicKeyName("NEXT_PUBLIC_API_KEY")).toBe(true);
        expect(isPublicKeyName("STRIPE_SECRET_KEY")).toBe(false);
    });

    it("classifies a plural exactly as its singular, and a run-together compound key too", () => {
        expect.assertions(10);

        // The list is written in the singular and matched against the singular of
        // each word. It used to carry a hand-added `CREDENTIALS` and no other
        // plural, so these six all read as ordinary config — including in the env
        // error redactor, which scrubs a value only for a secret-named key.
        expect(isSecretKeyName("SECRETS")).toBe(true);
        expect(isSecretKeyName("AUTH_TOKENS")).toBe(true);
        expect(isSecretKeyName("DB_PASSWORDS")).toBe(true);
        expect(isSecretKeyName("API_KEYS")).toBe(true);
        expect(isSecretKeyName("PRIVATE_KEYS")).toBe(true);
        expect(isSecretKeyName("SIGNING_KEYS")).toBe(true);
        // The run-together tail is derived from the same two lists, so every
        // compound `*_KEY` has one — not just `apikey`, which was the only one
        // spelled out by hand.
        expect(isSecretKeyName("MY_PRIVATEKEY")).toBe(true);
        // …and pluralising an ordinary config name still does not make it secret.
        expect(isSecretKeyName("IDEMPOTENCY_KEYS")).toBe(false);
        expect(isSecretKeyName("SORT_KEYS")).toBe(false);
        expect(isSecretKeyName("PROGRESS")).toBe(false);
    });

    it("stays anchored on whole words, so an ordinary word that merely contains one is config", () => {
        expect.assertions(3);

        expect(isSecretKeyName("SECRETARY")).toBe(false);
        expect(isSecretKeyName("TOKENIZER")).toBe(false);
        expect(isSecretKeyName("DATABASE_URL")).toBe(false);
    });
});

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
