import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import rowCheckTargetRefusal from "../../src/util/row-check-target";

let cwd: string;

const wrangler = (config: Record<string, unknown>): void => {
    writeFileSync(join(cwd, "wrangler.jsonc"), JSON.stringify(config), "utf8");
};

const link = (workerUrl: string, environment?: string): void => {
    mkdirSync(join(cwd, ".lunora"), { recursive: true });
    writeFileSync(join(cwd, ".lunora", "project.json"), JSON.stringify({ env: environment, workerUrl }), "utf8");
};

describe(rowCheckTargetRefusal, () => {
    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-row-target-"));
        wrangler({ name: "app" });
    });

    afterEach(() => {
        rmSync(cwd, { force: true, recursive: true });
    });

    it("accepts the linked deployment and refuses another path on the same host", () => {
        expect.assertions(2);

        link("https://acme.com/app");

        expect(rowCheckTargetRefusal(cwd, undefined, "https://acme.com/app/")).toBeUndefined();
        expect(rowCheckTargetRefusal(cwd, undefined, "https://acme.com/other")).toContain("this checkout is linked to https://acme.com/app");
    });

    it.each([
        ["staging", "--env staging", undefined],
        [undefined, "production", "staging"],
    ])("refuses the URL linked to %s for a deploy of another env", (linkedEnvironment, named, deployEnvironment) => {
        expect.assertions(1);

        link("https://acme.com", linkedEnvironment);

        expect(rowCheckTargetRefusal(cwd, deployEnvironment, "https://acme.com")).toContain(`this checkout links it to ${named}`);
    });

    it("checks a custom domain against the routes wrangler declares per env", () => {
        expect.assertions(4);

        wrangler({
            env: { staging: { routes: [{ custom_domain: true, pattern: "staging.acme.com" }] } },
            name: "app",
            routes: [{ custom_domain: true, pattern: "api.acme.com" }, "*.acme.io/*"],
        });

        expect(rowCheckTargetRefusal(cwd, undefined, "https://api.acme.com")).toBeUndefined();
        expect(rowCheckTargetRefusal(cwd, undefined, "https://eu.acme.io")).toBeUndefined();
        expect(rowCheckTargetRefusal(cwd, undefined, "https://staging.acme.com")).toContain("wrangler routes it to --env staging");
        expect(rowCheckTargetRefusal(cwd, "staging", "https://elsewhere.acme.net")).toContain("routes to staging.acme.com");
    });

    it.each(["https://[::ffff:127.0.0.1]", "https://[::ffff:10.0.0.1]", "https://[::ffff:c0a8:101]"])("refuses the IPv4-mapped private address %s", (url) => {
        expect.assertions(1);

        expect(rowCheckTargetRefusal(cwd, undefined, url)).toContain("local or private address");
    });

    it("accepts an IPv4-mapped public address as a custom host", () => {
        expect.assertions(1);

        expect(rowCheckTargetRefusal(cwd, undefined, "https://[::ffff:8.8.8.8]")).toBeUndefined();
    });

    it("refuses an unlisted custom domain for an env with no routes when another env declares some", () => {
        expect.assertions(1);

        wrangler({ env: { staging: { routes: ["staging.acme.com/*"] } }, name: "app" });

        expect(rowCheckTargetRefusal(cwd, undefined, "https://old.acme.net")).toContain("routes to no declared route");
    });

    it("takes a custom domain at its word when no routes are declared", () => {
        expect.assertions(1);

        expect(rowCheckTargetRefusal(cwd, undefined, "https://api.acme.com")).toBeUndefined();
    });

    it("refuses a *.workers.dev target no link ties to this account, naming how to link, and one for another Worker", () => {
        expect.assertions(2);

        expect(rowCheckTargetRefusal(cwd, undefined, "https://app.other-account.workers.dev")).toContain("lunora link --url");
        expect(rowCheckTargetRefusal(cwd, undefined, "https://other.acme.workers.dev")).toContain('ships the Worker "app"');
    });

    it("accepts a *.workers.dev target the link names", () => {
        expect.assertions(1);

        link("https://app.acme.workers.dev");

        expect(rowCheckTargetRefusal(cwd, undefined, "https://app.acme.workers.dev")).toBeUndefined();
    });

    it("refuses a *.workers.dev target on another account than the one the link records", () => {
        expect.assertions(1);

        link("https://app.acme.workers.dev");

        expect(rowCheckTargetRefusal(cwd, undefined, "https://app.other-account.workers.dev")).toContain("linked to https://app.acme.workers.dev");
    });

    it("tells two path-scoped routes on one host apart", () => {
        expect.assertions(3);

        wrangler({
            env: { staging: { routes: ["example.com/staging/*"] } },
            name: "app",
            routes: ["example.com/prod/*"],
        });

        expect(rowCheckTargetRefusal(cwd, "staging", "https://example.com/prod")).toContain("wrangler routes it to production");
        expect(rowCheckTargetRefusal(cwd, "staging", "https://example.com/staging")).toBeUndefined();
        expect(rowCheckTargetRefusal(cwd, undefined, "https://example.com/staging/api")).toContain("wrangler routes it to --env staging");
    });

    it("does not let a link recorded for an earlier Worker name or another env's route vouch for the current target", () => {
        expect.assertions(3);

        link("https://old-name.acme.workers.dev");

        expect(rowCheckTargetRefusal(cwd, undefined, "https://old-name.acme.workers.dev")).toContain('this deploy ships the Worker "app"');

        wrangler({ env: { staging: { routes: ["staging.acme.com/*"] } }, name: "app", routes: ["api.acme.com/*"] });
        link("https://staging.acme.com");

        expect(rowCheckTargetRefusal(cwd, undefined, "https://staging.acme.com")).toContain("wrangler routes it to --env staging");

        link("https://api.acme.com");

        expect(rowCheckTargetRefusal(cwd, undefined, "https://api.acme.com")).toBeUndefined();
    });

    it.each(["https://other.acme.workers.dev.", "https://OTHER.ACME.WORKERS.DEV", "https://other.acme.workers.dev.."])(
        "treats %s as the *.workers.dev host it is, so an unlinked one is refused",
        (url) => {
            expect.assertions(1);

            expect(rowCheckTargetRefusal(cwd, undefined, url)).toContain("refused");
        },
    );

    it.each(["http://localhost./", "http://LOCALHOST./", "http://app.localhost./", "http://127.0.0.1./"])(
        "treats %s as a local address, not a deployed worker",
        (url) => {
            expect.assertions(1);

            expect(rowCheckTargetRefusal(cwd, undefined, url)).toContain("local or private address");
        },
    );

    it("holds a linked custom domain against the routes the current env deploys, not only other envs' routes", () => {
        expect.assertions(2);

        wrangler({ name: "app", routes: ["api.acme.com/*"] });
        link("https://old.acme.com");

        expect(rowCheckTargetRefusal(cwd, undefined, "https://old.acme.com")).toContain("routes to api.acme.com");

        link("https://api.acme.com");

        expect(rowCheckTargetRefusal(cwd, undefined, "https://api.acme.com")).toBeUndefined();
    });
});
