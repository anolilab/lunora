import type { LunoraClient } from "@lunora/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The context store stands in for Svelte's component context: `setContext` writes under a key, `getContext` reads it back.
const { store } = vi.hoisted(() => {
    return { store: new Map<unknown, unknown>() };
});

vi.mock(import("svelte"), async (importOriginal) => {
    const actual = await importOriginal();

    // Every real export is kept; only the two context functions read and write the store.
    return {
        ...actual,
        getContext: (key: unknown): unknown => store.get(key),
        setContext: (key: unknown, value: unknown): void => {
            store.set(key, value);
        },
    } as typeof actual;
});

// Two module instances of this package, as a bundle holding two pnpm peer variants has them.
const loadCopy = async (): Promise<typeof import("../src/context")> => {
    vi.resetModules();

    return import("../src/context");
};

describe("setLunoraClient across copies of the package", () => {
    beforeEach(() => {
        store.clear();
    });

    it("a client set by one copy is read by getLunoraClient of another copy", async () => {
        expect.assertions(2);

        const setter = await loadCopy();
        const reader = await loadCopy();
        const client = { id: "client" } as unknown as LunoraClient;

        // Only a real second copy makes this test mean anything.
        expect(reader.getLunoraClient).not.toBe(setter.getLunoraClient);

        setter.setLunoraClient(client);

        expect(reader.getLunoraClient()).toBe(client);
    });
});
