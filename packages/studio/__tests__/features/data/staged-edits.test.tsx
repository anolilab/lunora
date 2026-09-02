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

    it("leaves a partly-committed row where it was in the buffer", () => {
        expect.assertions(2);

        // `commitStaged` iterates the buffer's insertion order and the diff panel
        // renders it, so re-adding the row after filtering it out moved it to the
        // END — the row the operator was reading jumped to the bottom of the list
        // and its retry ran out of the order the edits were made in.
        const { result } = renderHook(() => useStagedEdits());

        act(() => {
            result.current.stage("m1", "text", "first");
            result.current.stage("m2", "text", "second");
            result.current.stage("m3", "text", "third");
        });

        const committed = result.current.staged["m1"] ?? {};

        act(() => {
            result.current.stage("m1", "author", "ada");
        });

        act(() => {
            result.current.drop("m1", committed);
        });

        expect(Object.keys(result.current.staged)).toStrictEqual(["m1", "m2", "m3"]);
        expect(result.current.staged["m1"]).toStrictEqual({ author: "ada" });
    });
});

describe("coerceCellValue", () => {
    it("keeps a numeric column numeric", () => {
        expect.assertions(1);

        expect(coerceCellValue("42", 1)).toBe(42);
    });
});
