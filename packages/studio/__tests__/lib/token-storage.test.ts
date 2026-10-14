import { afterEach, describe, expect, it, vi } from "vitest";

import { loadToken, saveToken } from "../../src/lib/token-storage";

const STORAGE_KEY = "lunora-studio-admin-token";

describe("tokenStorage", () => {
    afterEach(() => {
        // Restore FIRST: a case that mocks the storage getter into throwing would
        // otherwise take the `clear()` calls below down with it.
        vi.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
    });

    it("round-trips a token", () => {
        expect.assertions(1);

        saveToken("secret-token");

        expect(loadToken()).toBe("secret-token");
    });

    /**
     * `sessionStorage`, not `localStorage` — the deliberate tradeoff that keeps a
     * long-lived admin credential off disk and scoped to the tab. Pinned because
     * "just use the same area as everything else" is a one-character change that
     * silently widens the credential's lifetime.
     */
    it("persists to sessionStorage and never to localStorage", () => {
        expect.assertions(2);

        saveToken("secret-token");

        expect(sessionStorage.getItem(STORAGE_KEY)).toBe("secret-token");

        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("returns the empty string when nothing is stored", () => {
        expect.assertions(1);

        expect(loadToken()).toBe("");
    });

    // Saving "" is how the studio CLEARS the token (the operator empties the
    // field). It must remove the entry, not persist a blank one that later reads
    // back as a stored value.
    it("clears the stored token when saving an empty string", () => {
        expect.assertions(2);

        saveToken("secret-token");
        saveToken("");

        expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
        expect(loadToken()).toBe("");
    });

    it("overwrites a previously stored token rather than appending", () => {
        expect.assertions(1);

        saveToken("first");
        saveToken("second");

        expect(loadToken()).toBe("second");
    });

    /**
     * A private window or a browser set to block site data THROWS on the
     * `sessionStorage` accessor rather than returning null. The studio must still
     * boot (in-memory-only) rather than white-screen on a storage exception.
     */
    it("degrades to in-memory-only when the storage accessor throws", () => {
        expect.assertions(2);

        vi.spyOn(globalThis, "sessionStorage", "get").mockImplementation(() => {
            throw new Error("SecurityError: access denied");
        });

        expect(loadToken()).toBe("");
        expect(() => {
            saveToken("secret-token");
        }).not.toThrow();
    });

    it("swallows a setItem throw (quota / privacy mode) instead of propagating it", () => {
        expect.assertions(1);

        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("QuotaExceededError");
        });

        expect(() => {
            saveToken("secret-token");
        }).not.toThrow();
    });

    it("swallows a removeItem throw on the clear path", () => {
        expect.assertions(1);

        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new Error("SecurityError");
        });

        expect(() => {
            saveToken("");
        }).not.toThrow();
    });

    it("swallows a getItem throw and reads as unset", () => {
        expect.assertions(1);

        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("SecurityError");
        });

        expect(loadToken()).toBe("");
    });
});
