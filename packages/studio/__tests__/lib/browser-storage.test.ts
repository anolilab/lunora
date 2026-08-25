import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadJsonArray, newId, removeJson, saveJson, storageOf, usePersistedList } from "../../src/lib/browser-storage";

const KEY = "lunora-studio-test";

describe("browserStorage", () => {
    afterEach(() => {
        // Restore FIRST: a case that mocks the storage getter into throwing would
        // otherwise take the `clear()` calls below down with it.
        vi.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
    });

    describe("loadJsonArray", () => {
        it("returns an empty array when the key is absent", () => {
            expect.assertions(1);

            expect(loadJsonArray(KEY)).toStrictEqual([]);
        });

        it("returns the stored array round-tripped through saveJson", () => {
            expect.assertions(1);

            saveJson(KEY, [{ id: "a" }, { id: "b" }]);

            expect(loadJsonArray<{ id: string }>(KEY)).toStrictEqual([{ id: "a" }, { id: "b" }]);
        });

        it("falls back to [] when the stored value is valid JSON but not an array", () => {
            expect.assertions(1);

            localStorage.setItem(KEY, JSON.stringify({ not: "an array" }));

            expect(loadJsonArray(KEY)).toStrictEqual([]);
        });

        it("falls back to [] when the stored value is malformed JSON", () => {
            expect.assertions(1);

            localStorage.setItem(KEY, "{ broken");

            expect(loadJsonArray(KEY)).toStrictEqual([]);
        });
    });

    describe("saveJson", () => {
        it("swallows a setItem throw (quota / privacy mode) instead of propagating it", () => {
            expect.assertions(1);

            vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
                throw new Error("QuotaExceededError");
            });

            expect(() => {
                saveJson(KEY, [1, 2, 3]);
            }).not.toThrow();
        });
    });

    describe("storageOf", () => {
        it("returns the two distinct storage areas, defaulting to local", () => {
            expect.assertions(3);

            expect(storageOf()).toBe(localStorage);
            expect(storageOf("local")).toBe(localStorage);
            expect(storageOf("session")).toBe(sessionStorage);
        });

        /**
         * Reading `globalThis.localStorage` THROWS (not returns null) in a
         * sandboxed iframe and in browsers set to block site data. This is the
         * one guarded accessor every persisted-store helper routes through, so
         * the throw has to be swallowed here or it escapes into a render.
         */
        it("degrades to undefined when the accessor itself throws", () => {
            expect.assertions(2);

            for (const property of ["localStorage", "sessionStorage"] as const) {
                vi.spyOn(globalThis, property, "get").mockImplementation(() => {
                    throw new Error("SecurityError: access denied");
                });
            }

            expect(storageOf("local")).toBeUndefined();
            expect(storageOf("session")).toBeUndefined();
        });

        it("keeps every helper on top of it silent when access throws", () => {
            expect.assertions(3);

            vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
                throw new Error("SecurityError: access denied");
            });

            expect(loadJsonArray(KEY)).toStrictEqual([]);
            expect(() => {
                saveJson(KEY, [1]);
            }).not.toThrow();
            expect(() => {
                removeJson(KEY);
            }).not.toThrow();
        });
    });

    describe("removeJson", () => {
        it("deletes the key from the requested area only", () => {
            expect.assertions(2);

            localStorage.setItem(KEY, JSON.stringify([1]));
            sessionStorage.setItem(KEY, JSON.stringify([2]));

            removeJson(KEY, "local");

            expect(localStorage.getItem(KEY)).toBeNull();
            expect(sessionStorage.getItem(KEY)).toBe(JSON.stringify([2]));
        });

        it("swallows a removeItem throw instead of propagating it", () => {
            expect.assertions(1);

            vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
                throw new Error("SecurityError");
            });

            expect(() => {
                removeJson(KEY);
            }).not.toThrow();
        });
    });

    describe("usePersistedList", () => {
        it("reloads from the new key when `key` changes instead of clobbering it", () => {
            expect.assertions(3);

            localStorage.setItem("list-a", JSON.stringify([1, 2]));
            localStorage.setItem("list-b", JSON.stringify([9]));

            const { rerender, result } = renderHook(({ key }) => usePersistedList<number>(key), { initialProps: { key: "list-a" } });

            expect(result.current[0]).toStrictEqual([1, 2]);

            rerender({ key: "list-b" });

            // The state reflects the new key's stored value…
            expect(result.current[0]).toStrictEqual([9]);
            // …and the new key wasn't overwritten with the previous key's value.
            expect(localStorage.getItem("list-b")).toBe(JSON.stringify([9]));
        });
    });

    describe("newId", () => {
        it("produces distinct ids across calls", () => {
            expect.assertions(2);

            const first = newId("w");
            const second = newId("w");

            expect(first).not.toBe(second);
            expect(typeof first).toBe("string");
        });
    });
});
