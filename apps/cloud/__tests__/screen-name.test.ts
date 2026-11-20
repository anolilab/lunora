import { describe, expect, it } from "vitest";

import { redactOrgPath, screenFor, TABS } from "../src/client/tabs";

/**
 * These two functions are the only thing standing between the studio's URLs and
 * the analytics pipeline, and every URL here embeds an organization id. The
 * cases that matter are the ones where an id would slip through, so that is
 * what these pin.
 */

describe(screenFor, () => {
    it.each([
        ["the organization list", "/", "organizations"],
        ["a trailing slash", "//", "organizations"],
        ["the sign-in page", "/login", "login"],
        ["the per-organization index", "/orgs/org_abc123", "overview"],
        ["a tab", "/orgs/org_abc123/logs", "logs"],
        ["a hyphenated tab", "/orgs/org_abc123/cloudflare-costs", "cloudflare-costs"],
        ["a trailing slash on a tab", "/orgs/org_abc123/logs/", "logs"],
        // A sub-route rolls up to its tab — the id in it never becomes the name.
        ["a detail route under a tab", "/orgs/org_abc123/projects/prj_secret", "projects"],
    ])("names %s", (_label, pathname, expected) => {
        expect.assertions(1);

        expect(screenFor(pathname)).toBe(expected);
    });

    it("names every tab in the table, so a new tab is not silently 'unknown'", () => {
        expect.assertions(TABS.length);

        for (const tab of TABS) {
            expect(screenFor(`/orgs/org_abc123/${tab.id}`)).toBe(tab.id);
        }
    });

    it.each([
        ["an unregistered tab segment", "/orgs/org_abc123/some-new-tab"],
        ["an unknown top-level route", "/prj_secret"],
        ["a bare /orgs", "/orgs"],
    ])("refuses to echo %s back as a screen name", (_label, pathname) => {
        expect.assertions(1);

        expect(screenFor(pathname)).toBe("unknown");
    });
});

describe(redactOrgPath, () => {
    it.each([
        ["a path", "/orgs/org_abc123/logs", "/orgs/:organizationId/logs"],
        ["an absolute URL", "https://cloud.lunora.dev/orgs/org_abc123/logs?traceId=t1", "https://cloud.lunora.dev/orgs/:organizationId/logs?traceId=t1"],
        ["the organization index", "/orgs/org_abc123", "/orgs/:organizationId"],
        ["a path with no organization", "/login", "/login"],
    ])("redacts %s", (_label, value, expected) => {
        expect.assertions(1);

        expect(redactOrgPath(value)).toBe(expected);
    });

    it("leaves no organization id behind in a rewritten URL", () => {
        expect.assertions(1);

        expect(redactOrgPath("https://cloud.lunora.dev/orgs/org_abc123/traces")).not.toContain("org_abc123");
    });
});
