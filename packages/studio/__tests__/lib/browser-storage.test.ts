import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadJsonArray, newId, saveJson, usePersistedList } from "../../src/lib/browser-storage";

const KEY = "lunora-studio-test";

describe("browserStorage", () => {
    afterEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
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
