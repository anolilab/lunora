import { afterEach, describe, expect, it, vi } from "vitest";

import { loadJsonArray, newId, saveJson } from "../../src/lib/browser-storage";

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
