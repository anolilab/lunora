import { describe, expect, it } from "vitest";

import { serializeView } from "../../../src/features/data/hooks/use-data-browser";

describe("serializeView", () => {
    // The re-seed check compares this key to decide whether an incoming view is a
    // real apply. A nested path is part of what the view shows, so two views that
    // differ only by path must not share a key.
    it("keys a view by its nested path, so a path change is a different view", () => {
        expect.assertions(2);

        const city = [{ column: "address", operator: "eq" as const, path: ["city"], value: "Berlin" }];
        const zone = [{ column: "address", operator: "eq" as const, path: ["zone"], value: "Berlin" }];

        expect(serializeView(undefined, undefined, city, undefined)).not.toBe(serializeView(undefined, undefined, zone, undefined));
        expect(serializeView(undefined, undefined, city, undefined)).toBe(
            serializeView(undefined, undefined, [{ column: "address", operator: "eq" as const, path: ["city"], value: "Berlin" }], undefined),
        );
    });
});
