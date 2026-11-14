import { createContext } from "solid-js";
import { describe, expect, it } from "vitest";

import { sharedContextFor } from "../src/shared-context";

// Two factories with distinct identities stand in for two Solid runtimes (Solid 1 and Solid 2) in one realm. Each returns a
// context of its own, as `createContext` from a different runtime does.
const runtimeOne = <T>(defaultValue: T) => createContext(defaultValue);
const runtimeTwo = <T>(defaultValue: T) => createContext(defaultValue);

describe("sharedContextFor across Solid runtimes", () => {
    it("keeps the contexts of two runtimes apart under the same name", () => {
        expect.assertions(2);

        const one = sharedContextFor(runtimeOne, "lunora-client", null);
        const two = sharedContextFor(runtimeTwo, "lunora-client", null);

        expect(two).not.toBe(one);
        expect(sharedContextFor(runtimeOne, "lunora-client", null)).toBe(one);
    });
});
