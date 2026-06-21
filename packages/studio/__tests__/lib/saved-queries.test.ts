import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataView } from "../../src/lib/saved-queries";
import { deleteSavedQuery, loadSavedQueries, saveQuery } from "../../src/lib/saved-queries";

const VIEW: DataView = { filters: [{ column: "status", operator: "eq", value: "error" }], search: "boom", shard: "room-1", table: "messages" };

describe("savedQueries", () => {
    afterEach(() => {
        localStorage.clear();
    });

    it("returns an empty list when nothing has been saved", () => {
        expect.assertions(1);

        expect(loadSavedQueries()).toEqual([]);
    });

    it("saves a view under a name and returns it most-recent-first", () => {
        expect.assertions(2);

        saveQuery("errors", VIEW);
        saveQuery("everything", { table: "users" });

        const saved = loadSavedQueries();

        expect(saved.map((entry) => entry.name)).toEqual(["everything", "errors"]);
        expect(saved[1]?.view).toEqual(VIEW);
    });

    it("round-trips the full view through storage", () => {
        expect.assertions(1);

        saveQuery("errors", VIEW);

        expect(loadSavedQueries()[0]?.view).toEqual(VIEW);
    });

    it("overwrites and moves a re-saved name to the front", () => {
        expect.assertions(2);

        saveQuery("a", { table: "one" });
        saveQuery("b", { table: "two" });
        saveQuery("a", { table: "three" });

        const saved = loadSavedQueries();

        expect(saved.map((entry) => entry.name)).toEqual(["a", "b"]);
        expect(saved[0]?.view).toEqual({ table: "three" });
    });

    it("ignores an empty/whitespace name", () => {
        expect.assertions(1);

        saveQuery("", VIEW);
        saveQuery("   ", VIEW);

        expect(loadSavedQueries()).toEqual([]);
    });

    it("deletes a saved query by name", () => {
        expect.assertions(1);

        saveQuery("a", { table: "one" });
        saveQuery("b", { table: "two" });

        expect(deleteSavedQuery("a").map((entry) => entry.name)).toEqual(["b"]);
    });

    it("drops malformed entries when loading", () => {
        expect.assertions(1);

        localStorage.setItem("lunora-studio-saved-queries", JSON.stringify([{ name: "ok", view: {} }, { name: 42 }, "garbage", { view: {} }]));

        expect(loadSavedQueries().map((entry) => entry.name)).toEqual(["ok"]);
    });

    it("degrades to an empty list when storage is unavailable", () => {
        expect.assertions(2);

        const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("storage disabled");
        });
        const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("storage disabled");
        });

        // Neither the read nor the write throws — both swallow the failure.
        expect(() => saveQuery("a", VIEW)).not.toThrow();
        expect(loadSavedQueries()).toEqual([]);

        getItem.mockRestore();
        setItem.mockRestore();
    });
});
