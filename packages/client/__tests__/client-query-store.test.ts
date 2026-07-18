import { describe, expect, it } from "vitest";

import { ClientQueryStore, createClientQuery } from "../src/client-query-store";

/**
 * `set(ref, undefined)` must honor the documented reset semantics: the doc on
 * `ClientQueryStore.set` says passing `undefined` resets the slot to
 * `ref.defaultValue`. Before the fix, `set` stored `undefined` directly and
 * `get` checked `values.has(key)` (true even for a stored `undefined`), so
 * `setClientQuery(ref, undefined)` returned `undefined` instead of the
 * default — e.g. a boolean client query would silently collapse to falsy.
 */
describe("ClientQueryStore reset semantics (CLIENT-04 regression)", () => {
    it("set(ref, undefined) resets to the default, not a stored undefined", () => {
        expect.assertions(3);

        const store = new ClientQueryStore();
        const ref = createClientQuery("sidebarOpen", true);

        // Never set — reports the default.
        expect(store.get(ref)).toBe(true);

        // Explicitly set to a real value.
        store.set(ref, false);

        expect(store.get(ref)).toBe(false);

        // Reset via `undefined` — must report the default again, not `undefined`.
        store.set(ref, undefined as unknown as boolean);

        expect(store.get(ref)).toBe(true);
    });

    it("set(ref, undefined) still notifies subscribers with the default value", () => {
        expect.assertions(2);

        const store = new ClientQueryStore();
        const ref = createClientQuery("selectedId", "none");
        const seen: unknown[] = [];

        store.subscribe(ref, (value) => {
            seen.push(value);
        });

        store.set(ref, "abc");

        expect(store.get(ref)).toBe("abc");

        store.set(ref, undefined as unknown as string);

        expect(seen).toStrictEqual(["abc", "none"]);
    });

    it("reset(ref) and set(ref, undefined) are equivalent", () => {
        expect.assertions(2);

        const store = new ClientQueryStore();
        const ref = createClientQuery("count", 0);

        store.set(ref, 5);
        store.reset(ref);

        const afterReset = store.get(ref);

        store.set(ref, 5);

        expect(store.get(ref)).toBe(5);

        store.set(ref, undefined as unknown as number);

        const afterSetUndefined = store.get(ref);

        expect(afterSetUndefined).toBe(afterReset);
    });
});
