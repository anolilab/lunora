import { describe, expect, it } from "vitest";

import { findServiceCycle } from "../src/deploy/service-graph";
import { BINDING_SUPPORT, TARGET_IDS } from "../src/provision-contract";

const graph = (edges: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(edges));

describe(findServiceCycle, () => {
    it("accepts an empty graph and a project with no service bindings", () => {
        expect(findServiceCycle(new Map())).toBeUndefined();
        expect(findServiceCycle(graph({ api: [], worker: [] }))).toBeUndefined();
    });

    it("accepts a chain", () => {
        expect(findServiceCycle(graph({ a: ["b"], b: ["c"], c: [] }))).toBeUndefined();
    });

    it("accepts a diamond, where two paths reach the same sibling", () => {
        expect(findServiceCycle(graph({ a: ["b", "c"], b: ["d"], c: ["d"], d: [] }))).toBeUndefined();
    });

    it("refuses a self-loop and names it", () => {
        expect(findServiceCycle(graph({ a: ["a"] }))).toStrictEqual(["a", "a"]);
    });

    it("refuses a two-cycle and names both Workers", () => {
        expect(findServiceCycle(graph({ a: ["b"], b: ["a"] }))).toStrictEqual(["a", "b", "a"]);
    });

    it("refuses a three-cycle and names all three, starting from the first in sorted order", () => {
        expect(findServiceCycle(graph({ a: ["b"], b: ["c"], c: ["a"] }))).toStrictEqual(["a", "b", "c", "a"]);
    });

    it("names only the loop, not the acyclic path that leads into it", () => {
        expect(findServiceCycle(graph({ entry: ["b"], b: ["c"], c: ["d"], d: ["b"] }))).toStrictEqual(["b", "c", "d", "b"]);
    });

    it("reports the same cycle however the edges are listed", () => {
        const forward = findServiceCycle(graph({ a: ["c", "b"], b: ["a"], c: ["a"] }));
        const reversed = findServiceCycle(graph({ c: ["a"], b: ["a"], a: ["b", "c"] }));

        expect(forward).toStrictEqual(reversed);
    });

    it("ignores an edge to a name outside the project, which cannot close a loop", () => {
        expect(findServiceCycle(graph({ a: ["connector"], connector: [] }))).toBeUndefined();
    });

    it("finds the cycle closing a 2000-Worker chain", () => {
        const size = 2000;
        const edges: Record<string, string[]> = {};

        for (let index = 0; index < size; index += 1) {
            edges[`w${String(index).padStart(4, "0")}`] = [`w${String(index + 1).padStart(4, "0")}`];
        }

        edges[`w${String(size).padStart(4, "0")}`] = ["w0000"];

        expect(findServiceCycle(graph(edges))?.length).toBe(size + 2);
    });
});

describe("service bindings are refused on every target", () => {
    // The check is not on any deploy path yet. This pins that: enabling `service` on a target
    // must come with wiring this check into that target's deploy, so this assertion is updated then.
    it.each(TARGET_IDS)("rates service unsupported on %s", (target) => {
        expect(BINDING_SUPPORT[target].service).toBe("unsupported");
    });
});
