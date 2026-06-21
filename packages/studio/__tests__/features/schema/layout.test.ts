import { describe, expect, it } from "vitest";

import type { SchemaEdge } from "../../../src/features/schema/layout";
import { computeDepths, computeLayout } from "../../../src/features/schema/layout";

const NO_COUNTS = new Map<string, number>();

describe("computeDepths", () => {
    it("places a referencing table one column right of its target", () => {
        expect.assertions(2);

        const edges: SchemaEdge[] = [{ column: "author", from: "messages", to: "users" }];
        const depth = computeDepths(["messages", "users"], edges);

        expect(depth.get("users")).toBe(0);
        expect(depth.get("messages")).toBe(1);
    });

    it("is cycle-safe — a back-edge contributes depth 0 instead of looping", () => {
        expect.assertions(1);

        const edges: SchemaEdge[] = [
            { column: "b", from: "a", to: "b" },
            { column: "a", from: "b", to: "a" },
        ];

        // Must terminate (not stack-overflow) and assign finite depths.
        expect(() => computeDepths(["a", "b"], edges)).not.toThrow();
    });

    it("ignores a self-reference when computing depth", () => {
        expect.assertions(1);

        const edges: SchemaEdge[] = [{ column: "parent", from: "nodes", to: "nodes" }];
        const depth = computeDepths(["nodes"], edges);

        expect(depth.get("nodes")).toBe(0);
    });
});

describe("computeLayout", () => {
    it("assigns each table a position and stacks deeper tables further right", () => {
        expect.assertions(3);

        const edges: SchemaEdge[] = [{ column: "author", from: "messages", to: "users" }];
        const nodes = computeLayout(["messages", "users"], edges, NO_COUNTS);
        const byName = new Map(nodes.map((node) => [node.name, node]));

        expect(nodes).toHaveLength(2);
        // `messages` references `users`, so it sits in a column to the right.
        expect(byName.get("messages")?.x).toBeGreaterThan(byName.get("users")?.x ?? 0);
        expect(byName.get("users")?.x).toBeGreaterThanOrEqual(0);
    });

    it("stacks same-depth tables vertically using their column counts", () => {
        expect.assertions(2);

        const counts = new Map<string, number>([
            ["a", 5],
            ["b", 2],
        ]);
        const nodes = computeLayout(["a", "b"], [], counts);
        const byName = new Map(nodes.map((node) => [node.name, node]));

        // Same depth (no edges) → same column.
        expect(byName.get("a")?.x).toBe(byName.get("b")?.x);
        // …but stacked, so `b` sits below `a`.
        expect(byName.get("b")?.y).toBeGreaterThan(byName.get("a")?.y ?? 0);
    });
});
