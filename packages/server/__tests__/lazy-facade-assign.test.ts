/**
 * `ctx.db.<table>` was a writable data property before the facades became lazy;
 * assigning to it must keep working both before and after the first read.
 */
import { describe, expect, it } from "vitest";

import type { FacadeWriterLike } from "../src/facade";
import { defineLazyFacade } from "../src/facade";

const lazyTarget = (): Record<string, unknown> => {
    const target = {} as Record<string, unknown>;

    defineLazyFacade(target as unknown as FacadeWriterLike, "users");

    return target;
};

describe("defineLazyFacade assignment", () => {
    it("accepts an assignment before the first read", () => {
        expect.assertions(1);

        const target = lazyTarget();

        target["users"] = "replaced";

        expect(target["users"]).toBe("replaced");
    });

    it("accepts an assignment after the first read", () => {
        expect.assertions(2);

        const target = lazyTarget();

        expect(target["users"]).toBeDefined();

        target["users"] = "replaced";

        expect(target["users"]).toBe("replaced");
    });

    it("shadows the facade when assigned through an object that inherits from the target", () => {
        expect.assertions(3);

        const target = lazyTarget();
        const child = Object.create(target) as Record<string, unknown>;

        child["users"] = "replaced";

        expect(child["users"]).toBe("replaced");
        expect(Object.hasOwn(child, "users")).toBe(true);
        expect(target["users"]).not.toBe("replaced");
    });
});
