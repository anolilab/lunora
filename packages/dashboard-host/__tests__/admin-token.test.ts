import { describe, expect, it } from "vitest";

import { parseDevVariable } from "../src/admin-token.js";

describe("parseDevVariable", () => {
    it("reads a quoted value and ignores comments/blank lines", () => {
        expect.assertions(2);

        const key = "CIRRUS_ADMIN_TOKEN";
        const body = ["# a comment", "", 'AUTH_SECRET="abc"', `${key}=tok123`].join("\n");

        expect(parseDevVariable(body, key)).toBe("tok123");
        expect(parseDevVariable(body, "AUTH_SECRET")).toBe("abc");
    });

    it("returns undefined for a missing or empty key", () => {
        expect.assertions(2);

        expect(parseDevVariable("FOO=bar", "MISSING")).toBeUndefined();
        expect(parseDevVariable('EMPTY=""', "EMPTY")).toBeUndefined();
    });
});
