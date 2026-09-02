import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { coerceCellValue, useStagedEdits } from "../../../src/features/data/staged-edits";

describe("useStagedEdits", () => {
    it("drops the cells a commit wrote", () => {
        expect.assertions(2);

        const { result } = renderHook(() => useStagedEdits());

        act(() => {
            result.current.stage("m1", "text", "edited");
            result.current.stage("m2", "text", "also edited");
        });

        const committed = result.current.staged["m1"] ?? {};

        act(() => {
            result.current.drop("m1", committed);
        });

        expect(result.current.staged["m1"]).toBeUndefined();
        expect(result.current.staged["m2"]).toStrictEqual({ text: "also edited" });
    });

    it("keeps a cell restaged after the commit snapshot was taken", () => {
        expect.assertions(2);

        // The grid stays editable while `committing` is true (only Commit and
        // Discard are disabled), and `commitStaged` iterates a SNAPSHOT of the
        // buffer. A cell re-edited while that row's patch is in flight has not
        // been written, so dropping the whole row entry silently threw the
        // operator's newer edit away.
        const { result } = renderHook(() => useStagedEdits());

        act(() => {
            result.current.stage("m1", "text", "first");
        });

        const committed = result.current.staged["m1"] ?? {};

        act(() => {
            result.current.stage("m1", "text", "second");
            result.current.stage("m1", "author", "ada");
        });

        act(() => {
            result.current.drop("m1", committed);
        });

        expect(result.current.staged["m1"]).toStrictEqual({ author: "ada", text: "second" });
        expect(result.current.count).toBe(2);
    });
});

describe("coerceCellValue", () => {
    it("keeps a numeric column numeric", () => {
        expect.assertions(1);

        expect(coerceCellValue("42", 1)).toBe(42);
    });
});
