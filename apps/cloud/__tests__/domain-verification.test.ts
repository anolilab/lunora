import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Custom-domain verification must be provable, not assertable.
 *
 * `markVerified` was a PUBLIC mutation taking `verified` as a caller-supplied
 * boolean, so the DNS proof performed by the edge verify route was decorative —
 * anyone reaching RPC could skip the route and certify themselves. Combined with
 * `add`, which validates hostname SYNTAX only, and a GLOBALLY UNIQUE
 * `by_hostname` index, an owner/admin of any entitled org could claim a hostname
 * they do not own, permanently lock its real owner out of the platform, mark it
 * verified, and have the dispatcher serve their script — or a redirect to
 * anywhere — for traffic arriving on it.
 *
 * Asserted over the source: the property is "this is unreachable from the public
 * RPC surface", which is a fact about the function's KIND, not about any value it
 * returns, so no amount of calling it can demonstrate the fix.
 */

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const DOMAINS = read("../lunora/domains.ts");
const ROUTER = read("../src/deploy/router.ts");

describe("domains.markVerified", () => {
    it("is an internalMutation, so no RPC caller can assert its own verification", () => {
        expect(DOMAINS).toContain("export const markVerified = internalMutation");
        expect(DOMAINS).not.toContain("export const markVerified = mutation");
    });

    it("carries no rateLimit middleware, because it is no longer caller-reachable", () => {
        // The `machine` bucket it used to carry only made sense for a public
        // mutation. Its absence is a second, independent signal of the kind change.
        const block = DOMAINS.slice(DOMAINS.indexOf("export const markVerified"), DOMAINS.indexOf("routeForHostname"));

        expect(block).not.toContain("rateLimit(");
    });

    it("is reached only through the route that performs the DNS lookup", () => {
        expect(ROUTER).toContain("internal.domains.markVerified");
        expect(ROUTER).not.toContain("api.domains.markVerified");
        // The write must still be downstream of the actual proof.
        expect(ROUTER).toContain("verifyDomain(domain.hostname");
    });
});

describe("domains.add redirect target", () => {
    it("rejects a redirect target that is not absolute http(s)", () => {
        // `redirectTo` is echoed to the eyeball as a 308 `Location`, so an
        // unvalidated value turns a custom domain into an open redirect.
        expect(DOMAINS).toContain("isRedirectTarget");
        expect(DOMAINS).toContain('protocol === "http:" || protocol === "https:"');
    });
});
