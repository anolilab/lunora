import { describe, expect, it } from "vitest";

import type { SqlTab } from "../../../src/features/sql/sql-tabs";
import { addTab, closeTab, makeTab, MAX_TABS } from "../../../src/features/sql/sql-tabs";

const tab = (id: string, sql = ""): SqlTab => {
    return { activeId: null, id, name: "Untitled", sql };
};

describe("sqlTabs", () => {
    describe("makeTab", () => {
        it("seeds an unlinked draft with the given sql and a fresh id", () => {
            expect.assertions(3);

            const made = makeTab("SELECT 1");

            expect(made.sql).toBe("SELECT 1");
            expect(made.activeId).toBeNull();
            expect(made.id).not.toBe("");
        });
    });

    describe("addTab", () => {
        it("appends a tab", () => {
            expect.assertions(1);

            expect(addTab([tab("a")], tab("b")).map((each) => each.id)).toStrictEqual(["a", "b"]);
        });

        it("caps the open tabs at MAX_TABS, dropping the oldest", () => {
            expect.assertions(2);

            const full = Array.from({ length: MAX_TABS }, (_, index) => tab(`t${index.toString()}`));
            const next = addTab(full, tab("new"));

            expect(next).toHaveLength(MAX_TABS);
            expect(next.at(-1)?.id).toBe("new");
        });
    });

    describe("closeTab", () => {
        it("removes a tab and selects its left neighbour", () => {
            expect.assertions(2);

            const result = closeTab([tab("a"), tab("b"), tab("c")], "b", () => makeTab());

            expect(result.tabs.map((each) => each.id)).toStrictEqual(["a", "c"]);
            expect(result.activeId).toBe("c");
        });

        it("replaces the sole tab with a fresh draft instead of leaving zero tabs", () => {
            expect.assertions(3);

            const result = closeTab([tab("only", "SELECT 1")], "only", () => makeTab());

            expect(result.tabs).toHaveLength(1);
            expect(result.tabs[0]?.sql).toBe("");
            expect(result.activeId).toBe(result.tabs[0]?.id);
        });
    });
});
