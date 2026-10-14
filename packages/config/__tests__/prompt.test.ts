import { afterEach, describe, expect, it } from "vitest";

import { promptMultiSelect, promptSelect, promptText } from "../src/prompt";

const OPTIONS = [
    { label: "Email & password", value: "auth" },
    { label: "Clerk", value: "clerk" },
] as const;

describe("promptSelect (non-interactive)", () => {
    const originalIsTty = process.stdin.isTTY;

    afterEach(() => {
        // Restore the real TTY flag the test runner started with.
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
    });

    const setTty = (value: boolean): void => {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
    };

    it("returns the default without reading stdin when not a TTY", async () => {
        expect.assertions(1);

        setTty(false);

        await expect(promptSelect("Pick one", OPTIONS, { default: "clerk" })).resolves.toBe("clerk");
    });

    it("returns undefined when not a TTY and no default is given", async () => {
        expect.assertions(1);

        setTty(false);

        await expect(promptSelect("Pick one", OPTIONS)).resolves.toBeUndefined();
    });

    it("returns the default for an empty option list even on a TTY", async () => {
        expect.assertions(1);

        setTty(true);

        await expect(promptSelect("Pick one", [], { default: "auth" })).resolves.toBe("auth");
    });
});

describe("promptMultiSelect (non-interactive)", () => {
    const originalIsTty = process.stdin.isTTY;

    afterEach(() => {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
    });

    const setTty = (value: boolean): void => {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
    };

    it("returns the defaults without reading stdin when not a TTY", async () => {
        expect.assertions(1);

        setTty(false);

        await expect(promptMultiSelect("Pick many", OPTIONS, { defaults: ["auth", "clerk"] })).resolves.toStrictEqual(["auth", "clerk"]);
    });

    it("returns an empty array when not a TTY and no defaults are given", async () => {
        expect.assertions(1);

        setTty(false);

        await expect(promptMultiSelect("Pick many", OPTIONS)).resolves.toStrictEqual([]);
    });

    it("returns the defaults for an empty option list even on a TTY", async () => {
        expect.assertions(1);

        setTty(true);

        await expect(promptMultiSelect("Pick many", [], { defaults: ["auth"] })).resolves.toStrictEqual(["auth"]);
    });
});

describe("promptText (non-interactive)", () => {
    const originalIsTty = process.stdin.isTTY;

    afterEach(() => {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
    });

    const setTty = (value: boolean): void => {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
    };

    it("returns the default without reading stdin when not a TTY", async () => {
        expect.assertions(1);

        setTty(false);

        await expect(promptText("Table name: ", { default: "messages" })).resolves.toBe("messages");
    });

    it("returns undefined when not a TTY and no default is given", async () => {
        expect.assertions(1);

        setTty(false);

        await expect(promptText("Table name: ")).resolves.toBeUndefined();
    });
});
