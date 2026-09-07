import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDevVariable, resolveAdminToken } from "../../src/studio-host/admin-token";

describe("parseDevVariable", () => {
    it("reads a quoted value and ignores comments/blank lines", () => {
        expect.assertions(2);

        const key = "LUNORA_ADMIN_TOKEN";
        const body = ["# a comment", "", 'AUTH_SECRET="abc"', `${key}=tok123`].join("\n");

        expect(parseDevVariable(body, key)).toBe("tok123");
        expect(parseDevVariable(body, "AUTH_SECRET")).toBe("abc");
    });

    it("returns undefined for a missing or empty key", () => {
        expect.assertions(2);

        expect(parseDevVariable("FOO=bar", "MISSING")).toBeUndefined();
        expect(parseDevVariable('EMPTY=""', "EMPTY")).toBeUndefined();
    });

    it("agrees with the shared .dev.vars grammar on a lone quote char (no length<2 mis-strip)", () => {
        expect.assertions(2);

        // A single unmatched quote is NOT a wrapping pair — the shared
        // `unquoteDevVariable` keeps it verbatim (its `length >= 2` guard), so the
        // studio and `lunora env` read the same literal value instead of drifting.
        expect(parseDevVariable('LUNORA_ADMIN_TOKEN="', "LUNORA_ADMIN_TOKEN")).toBe('"');
        // dotenv keys are `[\w.-]+`, so a leading digit IS a valid key — the
        // reader accepts everything wrangler's dotenv parse accepts.
        expect(parseDevVariable("1BAD=value", "1BAD")).toBe("value");
    });
});

/** The token the local worker verifies — the one the studio must embed. */
const LOCAL_TOKEN = "local-dev-token";

describe("resolveAdminToken", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("reads an export-prefixed, comment-trailed token like wrangler does", () => {
        expect.assertions(1);

        vi.stubEnv("LUNORA_ADMIN_TOKEN", "");

        const root = mkdtempSync(join(tmpdir(), "lunora-admin-token-"));

        writeFileSync(join(root, ".dev.vars"), "export LUNORA_ADMIN_TOKEN=abc # local\n");

        expect(resolveAdminToken(root)).toBe("abc");
    });

    it("uses the .dev.vars token — the only one the local worker verifies — and warns about a differing shell export", () => {
        expect.assertions(2);

        // `LUNORA_ADMIN_TOKEN` in the shell is the documented way to run
        // `lunora backup` / `deploy --migrate` against PRODUCTION. Nothing
        // forwards it into the dev worker's env, so preferring it both failed the
        // studio's admin gate and put a production bearer in every document
        // served on the developer's machine.
        vi.stubEnv("LUNORA_ADMIN_TOKEN", "production-bearer");

        const root = mkdtempSync(join(tmpdir(), "lunora-admin-token-env-"));

        writeFileSync(join(root, ".dev.vars"), `LUNORA_ADMIN_TOKEN=${JSON.stringify(LOCAL_TOKEN)}\n`);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const token = resolveAdminToken(root);

        expect(token).toBe(LOCAL_TOKEN);
        expect(warn.mock.calls.join(" ")).toContain("LUNORA_ADMIN_TOKEN");

        warn.mockRestore();
    });

    it("returns undefined when .dev.vars carries no token, rather than falling back to the shell", () => {
        expect.assertions(1);

        vi.stubEnv("LUNORA_ADMIN_TOKEN", "production-bearer");

        const root = mkdtempSync(join(tmpdir(), "lunora-admin-token-none-"));

        writeFileSync(join(root, ".dev.vars"), 'AUTH_SECRET="x"\n');

        // The studio prompts instead — a token the worker cannot verify is worse
        // than no token, and this one is a production credential.
        expect(resolveAdminToken(root)).toBeUndefined();
    });
});
