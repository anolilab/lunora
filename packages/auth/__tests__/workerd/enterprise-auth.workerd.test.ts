/**
 * Real-workerd boot spike for the enterprise-auth plugins (plan 166, Phase 0).
 *
 * The plan assumed the two halves could be de-risked separately — "OIDC is
 * edge-safe, SAML is the risk". At the module level that split does not exist:
 * `@better-auth/sso`'s `dist/index.mjs` statically imports `samlify` and
 * `node:crypto`'s `X509Certificate`, so configuring only the OIDC mode still
 * loads the SAML dependency tree (`samlify` → `xml-crypto` / `node-rsa` /
 * `@xmldom/xmldom`, with module-scope `require("fs")`).
 *
 * This suite therefore answers the load question for BOTH halves: does a worker
 * that imports and constructs these plugins boot in workerd at all? It does not
 * attempt a SAML ACS verify or measure its CPU cost — that stays the separate
 * Phase-0 question, and is only worth asking if this passes.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("enterprise-auth plugins under workerd", () => {
    it("boots a worker that imports @better-auth/sso and @better-auth/scim", async () => {
        expect.assertions(2);

        // A non-500 answer means the module graph — including the samlify tree
        // dragged in by the static import — resolved and evaluated in workerd.
        const response = await SELF.fetch("https://example.test/");

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("auth-enterprise-test-worker");
    });

    it("constructs both plugin factories inside the runtime", async () => {
        expect.assertions(3);

        const response = await SELF.fetch("https://example.test/plugins");

        expect(response.status).toBe(200);

        const body: { ids: string[] } = await response.json();

        // Plugin ids are better-auth's own; asserting them pins that we wired the
        // real plugins rather than something that merely imports cleanly.
        expect(body.ids).toContain("sso");
        expect(body.ids).toContain("scim");
    });
});
