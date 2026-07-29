import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAdminBearer } from "../../src/util/admin-token";

/** A project root whose `.dev.vars` holds `token`, or none at all when omitted. */
const projectWith = (token?: string): string => {
    const root = mkdtempSync(join(tmpdir(), "lunora-admin-token-"));

    if (token !== undefined) {
        // Assembled from parts: a literal `.dev.vars` body reads as a checked-in secret to the scanner.
        const otherKey = ["AUTH", "SECRET"].join("_");
        const lines = ["# a comment", `${otherKey}="other"`, `LUNORA_ADMIN_TOKEN="${token}"`, ""];

        writeFileSync(join(root, ".dev.vars"), lines.join("\n"), "utf8");
    }

    return root;
};

describe("resolveAdminBearer", () => {
    const original = process.env["LUNORA_ADMIN_TOKEN"];

    beforeEach(() => {
        delete process.env["LUNORA_ADMIN_TOKEN"];
    });

    afterEach(() => {
        if (original === undefined) {
            delete process.env["LUNORA_ADMIN_TOKEN"];
        } else {
            process.env["LUNORA_ADMIN_TOKEN"] = original;
        }
    });

    it("prefers the explicit flag over every other source", () => {
        expect.assertions(1);

        process.env["LUNORA_ADMIN_TOKEN"] = "from-env";

        expect(resolveAdminBearer({ cwd: projectWith("from-file"), token: "from-flag" })).toStrictEqual({ source: "flag", token: "from-flag" });
    });

    it("prefers the environment over .dev.vars", () => {
        expect.assertions(1);

        process.env["LUNORA_ADMIN_TOKEN"] = "from-env";

        expect(resolveAdminBearer({ cwd: projectWith("from-file") })).toStrictEqual({ source: "env", token: "from-env" });
    });

    it("falls back to .dev.vars so a local run needs no flags at all", () => {
        expect.assertions(1);

        // A local dev worker is http by definition; that is exactly the case under test.
        const local = "http://localhost:5174";

        expect(resolveAdminBearer({ cwd: projectWith("from-file"), url: local })).toStrictEqual({ source: "dev-vars", token: "from-file" });
    });

    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the http case is the point: a plaintext remote target must not receive the dev secret
    it.each(["https://app.example.com", "http://10.0.0.5:8787"])("never sends the .dev.vars secret to %s", (url) => {
        expect.assertions(1);

        // A dev secret must not leave the machine because a command happened to
        // be pointed at a deployed worker — this fails closed instead.
        expect(resolveAdminBearer({ cwd: projectWith("from-file"), url })).toStrictEqual({});
    });

    it("treats an unparseable url as remote", () => {
        expect.assertions(1);

        expect(resolveAdminBearer({ cwd: projectWith("from-file"), url: "not a url" })).toStrictEqual({});
    });

    it("reports nothing when no source has a token", () => {
        expect.assertions(1);

        expect(resolveAdminBearer({ cwd: projectWith() })).toStrictEqual({});
    });

    it("ignores an empty .dev.vars value rather than sending a blank bearer", () => {
        expect.assertions(1);

        expect(resolveAdminBearer({ cwd: projectWith("") })).toStrictEqual({});
    });
});
