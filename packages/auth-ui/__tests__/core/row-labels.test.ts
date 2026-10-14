/**
 * The two helpers that build a row action's accessible name. They are the only
 * logic behind ~96 `aria-label`s across six ports, so they are asserted here
 * rather than once per port.
 */
import { describe, expect, it } from "vitest";

import { firstLabel, rowActionLabel } from "../../src/core";

describe("rowActionLabel", () => {
    it("names the action after the row it acts on", () => {
        expect.assertions(1);

        expect(rowActionLabel("Remove", "GitHub")).toBe("Remove: GitHub");
    });

    it("falls back to the bare action when the row has no identity", () => {
        expect.assertions(3);

        // No worse than the name the control would have had anyway — and much
        // better than "Remove: " trailing into nothing.
        expect(rowActionLabel("Remove", undefined)).toBe("Remove");
        expect(rowActionLabel("Remove", "")).toBe("Remove");
        expect(rowActionLabel("Remove", "   ")).toBe("Remove");
    });

    it("trims a padded subject rather than reading the padding aloud", () => {
        expect.assertions(1);

        expect(rowActionLabel("Revoke access", "  Acme  ")).toBe("Revoke access: Acme");
    });
});

describe("firstLabel", () => {
    it("takes the first candidate a person can actually read", () => {
        expect.assertions(2);

        expect(firstLabel("Acme", "client_123")).toBe("Acme");
        expect(firstLabel(undefined, "client_123")).toBe("client_123");
    });

    it("skips blanks, which is the whole reason it is not `??`", () => {
        expect.assertions(3);

        // A server that stores a name it never collected sends `""`; `??` keeps
        // it, so the row renders blank and its action is named after nothing.
        expect(firstLabel("", "client_123")).toBe("client_123");
        expect(firstLabel("   ", "client_123")).toBe("client_123");
        expect(firstLabel(undefined, "", "  ", "user@example.test")).toBe("user@example.test");
    });

    it("is undefined when nothing is readable, so callers can degrade", () => {
        expect.assertions(2);

        expect(firstLabel(undefined, "")).toBeUndefined();
        expect(firstLabel()).toBeUndefined();
    });

    it("composes with rowActionLabel on the shape the cards actually use", () => {
        expect.assertions(2);

        expect(rowActionLabel("Revoke access", firstLabel("", "client_123"))).toBe("Revoke access: client_123");
        expect(rowActionLabel("Revoke access", firstLabel(undefined, undefined))).toBe("Revoke access");
    });
});
