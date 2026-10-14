import { describe, expect, it } from "vitest";

import { columnWindow, pinnedOffsets } from "../../../src/features/data/column-window";

/** `count` columns of a uniform width, named `c0…cN`. */
const columns = (count: number, width = 100): { getSize: () => number; id: string }[] =>
    Array.from({ length: count }, (_, index) => {
        return { getSize: () => width, id: `c${String(index)}` };
    });

const NONE: ReadonlySet<string> = new Set();

describe("columnWindow", () => {
    it("mounts only the on-screen run of a very wide table", () => {
        expect.assertions(2);

        // 200 columns × 100px = 20 000px of table behind an 800px viewport. The
        // row virtualizer bounds the vertical axis only; without this the grid
        // mounted every cell of every visible row.
        const slice = columnWindow(columns(200), NONE, 0, 800);

        expect(slice.ids.size).toBeLessThan(20);
        expect(slice.ids.size).toBeGreaterThan(0);
    });

    it("preserves total width through the spacers, so alignment and the scrollbar are unchanged", () => {
        expect.assertions(1);

        const slice = columnWindow(columns(200), NONE, 5000, 800);
        const rendered = [...slice.ids].length * 100;

        expect(slice.leadPx + rendered + slice.tailPx).toBe(200 * 100);
    });

    it("follows the scroll position", () => {
        expect.assertions(2);

        const near = columnWindow(columns(200), NONE, 0, 800);
        const far = columnWindow(columns(200), NONE, 10_000, 800);

        expect(near.ids.has("c0")).toBe(true);
        // Scrolled far right, the leading columns are no longer mounted.
        expect(far.ids.has("c0")).toBe(false);
    });

    it("aLWAYS mounts pinned columns, however far they scroll out of their own span", () => {
        expect.assertions(2);

        // Pinned columns are `position: sticky`; dropping one because its span
        // left the viewport would make it vanish — the opposite of pinning.
        const pinned = new Set(["c0"]);
        const slice = columnWindow(columns(200), pinned, 10_000, 800);

        expect(slice.ids.has("c0")).toBe(true);
        // Its width must not ALSO sit in the lead spacer, or every column after
        // it shifts right by 100px. Asserted as width conservation rather than a
        // magic offset: spacers + mounted columns must still total the full table.
        expect(slice.leadPx + slice.ids.size * 100 + slice.tailPx).toBe(200 * 100);
    });

    it("mounts every column when the viewport is unmeasured", () => {
        expect.assertions(1);

        // jsdom and the first paint report zero width; a blank grid there would
        // be a worse failure than not windowing at all.
        expect(columnWindow(columns(50), NONE, 0, 0).ids.size).toBe(50);
    });
});

describe("pinnedOffsets", () => {
    it("stacks several pinned columns cumulatively instead of overlapping", () => {
        expect.assertions(3);

        const offsets = pinnedOffsets(columns(5), new Set(["c0", "c2"]));

        expect(offsets.get("c0")).toBe(0);
        // c2 sits after c0's 100px — the single-column version hard-coded one
        // offset, so a second pin would have stacked on top of the first.
        expect(offsets.get("c2")).toBe(100);
        expect(offsets.has("c1")).toBe(false);
    });

    it("re-flows when an earlier pinned column is hidden", () => {
        expect.assertions(1);

        // `c0` absent from the visible list: `c2` must move to offset 0, not keep
        // a gap where the hidden column used to be.
        expect(pinnedOffsets(columns(5).slice(1), new Set(["c0", "c2"])).get("c2")).toBe(0);
    });
});
