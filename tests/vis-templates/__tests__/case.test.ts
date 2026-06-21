import { describe, expect, test } from "vitest";

import { camelCase, dashCase, isJsIdentifier, isPackageName } from "../../../.vis/templates/_helpers/case.js";

describe("camelCase", () => {
    test.each([
        ["list-messages", "listMessages"],
        ["list_messages", "listMessages"],
        ["list messages", "listMessages"],
        ["ListMessages", "listMessages"],
        ["listMessages", "listMessages"],
        ["foo--bar", "fooBar"],
        ["foo__bar", "fooBar"],
        ["", ""],
        ["x", "x"],
    ])("camelCase(%j) === %j", (input, expected) => {
        expect(camelCase(input)).toBe(expected);
    });
});

describe("dashCase", () => {
    test.each([
        ["FooBar", "foo-bar"],
        ["fooBar", "foo-bar"],
        ["foo_bar", "foo-bar"],
        ["foo bar", "foo-bar"],
        ["AlreadyMixed_with-stuff", "already-mixed-with-stuff"],
        ["lower", "lower"],
    ])("dashCase(%j) === %j", (input, expected) => {
        expect(dashCase(input)).toBe(expected);
    });
});

describe("isJsIdentifier", () => {
    test.each([
        ["foo", true],
        ["_foo", true],
        ["$foo", true],
        ["foo123", true],
        ["123foo", false],
        ["foo-bar", false],
        ["foo.bar", false],
        ["", false],
    ])("isJsIdentifier(%j) === %j", (input, expected) => {
        expect(isJsIdentifier(input)).toBe(expected);
    });
});

describe("isPackageName", () => {
    test.each([
        ["foo", true],
        ["foo-bar", true],
        ["foo123", true],
        ["Foo", false],
        ["-foo", false],
        ["123foo", false],
        ["foo_bar", false],
        ["foo.bar", false],
        ["", false],
    ])("isPackageName(%j) === %j", (input, expected) => {
        expect(isPackageName(input)).toBe(expected);
    });
});
