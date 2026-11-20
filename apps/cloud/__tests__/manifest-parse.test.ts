import { describe, expect, it } from "vitest";

import { parsePayload } from "../src/deploy/manifest-parse";
import type { BindingRequirement } from "../src/provision-contract";

const parse = (bindings: BindingRequirement[]) => parsePayload({ manifest: { bindings } }, "app", "cloudflare-workers", "worker");

describe("one binding per stateful class", () => {
    it("accepts a class bound once, and two distinct classes", () => {
        expect(
            parse([
                { binding: "ROOMS", className: "Room", sqlite: true, type: "durable_object" },
                { binding: "FLOW", className: "OrderFlow", type: "workflow" },
            ]),
        ).toHaveProperty("value.manifest");
    });

    it("accepts one Durable Object class bound under two binding names", () => {
        expect(
            parse([
                { binding: "ROOMS", className: "Room", sqlite: true, type: "durable_object" },
                { binding: "LOBBY", className: "Room", sqlite: true, type: "durable_object" },
            ]),
        ).toHaveProperty("value.manifest");
    });

    it("refuses one class bound as both a Durable Object and a Workflow, in either order", () => {
        expect(
            parse([
                { binding: "ROOMS", className: "OrderFlow", sqlite: true, type: "durable_object" },
                { binding: "FLOW", className: "OrderFlow", type: "workflow" },
            ]),
        ).toStrictEqual({
            error: "class OrderFlow is bound twice (by ROOMS and FLOW); a Workflow class has one binding, because two bindings name one workflow and a converge can delete its instances",
        });
        expect(
            parse([
                { binding: "FLOW", className: "OrderFlow", type: "workflow" },
                { binding: "ROOMS", className: "OrderFlow", sqlite: true, type: "durable_object" },
            ]),
        ).toStrictEqual({
            error: "class OrderFlow is bound twice (by FLOW and ROOMS); a Workflow class has one binding, because two bindings name one workflow and a converge can delete its instances",
        });
    });

    it("refuses a renamed workflow binding left alongside its old name, which would delete the live workflow", () => {
        expect(
            parse([
                { binding: "FLOW", className: "OrderFlow", type: "workflow" },
                { binding: "FLOW_V2", className: "OrderFlow", type: "workflow" },
            ]),
        ).toStrictEqual({
            error: "class OrderFlow is bound twice (by FLOW and FLOW_V2); a Workflow class has one binding, because two bindings name one workflow and a converge can delete its instances",
        });
    });
});
