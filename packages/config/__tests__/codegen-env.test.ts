import { describe, expect, it } from "vitest";

import { isLazyFunctionsEnabled } from "../src/codegen-env";

describe("isLazyFunctionsEnabled", () => {
    it.each([
        [undefined, false],
        ["", false],
        ["0", false],
        ["false", false],
        ["1", true],
        ["true", true],
        [" TRUE ", true],
    ])("reads %j as %s", (value, expected) => {
        expect.assertions(1);

        expect(isLazyFunctionsEnabled(value)).toBe(expected);
    });
});
