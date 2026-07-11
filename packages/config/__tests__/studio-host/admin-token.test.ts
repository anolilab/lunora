import { describe, expect, it } from "vitest";

import { parseDevVariable } from "../../src/studio-host/admin-token";

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
        // A key that fails the DEV_VARS_KEY_PATTERN (leading digit) is ignored.
        expect(parseDevVariable("1BAD=value", "1BAD")).toBeUndefined();
    });
});
