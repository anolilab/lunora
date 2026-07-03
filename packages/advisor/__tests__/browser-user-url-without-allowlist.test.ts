import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorBrowserUrlAccess } from "../src/browser-url-accesses";
import type { AdvisorConfigCall } from "../src/config-calls";
import browserUserUrlWithoutAllowlist from "../src/lints/static/browser-user-url-without-allowlist";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const accesses: AdvisorBrowserUrlAccess[] = [
    { exportName: "snap", file: "shots", line: 4, method: "screenshot" },
    { exportName: "render", file: "shots", line: 9, method: "pdf" },
];

const createBrowser = (keys: string[]): AdvisorConfigCall => {
    return {
        analyzable: true,
        callee: "createBrowser",
        file: "browser",
        line: 1,
        presentKeys: keys,
        trueKeys: [],
    };
};

describe("browser_user_url_without_allowlist", () => {
    it("flags one WARN finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const findings = browserUserUrlWithoutAllowlist.run({ browserUrlAccesses: accesses, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "browser_user_url_without_allowlist:shots:4",
            level: "WARN",
            metadata: { exportName: "snap", method: "screenshot" },
            name: "browser_user_url_without_allowlist",
        });
        expect(findings[0]?.detail).toContain("ctx.browser.screenshot");
        expect(findings[1]?.cacheKey).toBe("browser_user_url_without_allowlist:shots:9");
    });

    it("suppresses all findings when a createBrowser is hardened with allowedHosts", () => {
        expect.assertions(1);

        const findings = browserUserUrlWithoutAllowlist.run({
            browserUrlAccesses: accesses,
            configCalls: [createBrowser(["binding", "allowedHosts"])],
            schema: schema(),
        });

        expect(findings).toHaveLength(0);
    });

    it("suppresses all findings when a createBrowser pins resolveDns", () => {
        expect.assertions(1);

        const findings = browserUserUrlWithoutAllowlist.run({
            browserUrlAccesses: accesses,
            configCalls: [createBrowser(["binding", "resolveDns"])],
            schema: schema(),
        });

        expect(findings).toHaveLength(0);
    });

    it("still flags when a createBrowser sets neither allowedHosts nor resolveDns", () => {
        expect.assertions(1);

        const findings = browserUserUrlWithoutAllowlist.run({
            browserUrlAccesses: accesses,
            configCalls: [createBrowser(["binding", "launch"])],
            schema: schema(),
        });

        expect(findings).toHaveLength(2);
    });

    it("ignores an opaque (non-analyzable) createBrowser config when deciding hardening", () => {
        expect.assertions(1);

        // A spread-assembled config is opaque: presentKeys can't be trusted, so a
        // key listed there must not suppress. `analyzable: false` models that.
        const findings = browserUserUrlWithoutAllowlist.run({
            browserUrlAccesses: accesses,
            configCalls: [{ analyzable: false, callee: "createBrowser", file: "browser", line: 1, presentKeys: ["allowedHosts"], trueKeys: [] }],
            schema: schema(),
        });

        expect(findings).toHaveLength(2);
    });

    it("finds nothing when the feeder supplies no browser evidence", () => {
        expect.assertions(2);

        expect(browserUserUrlWithoutAllowlist.run({ schema: schema() })).toHaveLength(0);
        expect(browserUserUrlWithoutAllowlist.run({ browserUrlAccesses: [], schema: schema() })).toHaveLength(0);
    });
});
