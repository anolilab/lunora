import { LunoraProvider } from "@lunora/react";
import { act, renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { useDataViewPreferences } from "../../../src/features/data/hooks/use-data-view-preferences";
import { createMockClient } from "../../mock-client";

/**
 * The storage key the pins live under. Spelled out here rather than imported so the
 * test breaks if the constant is renamed — which is the whole point: the name is
 * live in operators' browsers, and a rename silently discards every pin they have
 * set, with nothing else in the codebase to notice.
 */
const PINNED_COLUMNS_KEY = "lunora-studio-pinned-columns";

/** `usePersistedValue` is built on `usePersistedList`, so the payload is the value in a one-element array. */
const storedPins = (): Record<string, string[]> | undefined => (JSON.parse(localStorage.getItem(PINNED_COLUMNS_KEY) ?? "[]") as Record<string, string[]>[])[0];

const seedPins = (pins: Record<string, string[]>): void => {
    localStorage.setItem(PINNED_COLUMNS_KEY, JSON.stringify([pins]));
};

const wrapper = ({ children }: { readonly children: ReactNode }): ReactElement => {
    const client = createMockClient({
        // The hook loads mask policies; an empty answer is enough for pin behaviour.
        query: (): unknown => {
            return { policies: [] };
        },
    });

    return <LunoraProvider client={client.asClient}>{children}</LunoraProvider>;
};

const renderPreferences = (initialPins?: string) =>
    renderHook(() => useDataViewPreferences({ columns: ["id", "email", "name"], initialPins, selectedTable: "users" }), { wrapper });

describe("useDataViewPreferences", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("persists pins under the established storage key", () => {
        expect.assertions(2);

        const { result } = renderPreferences();

        act(() => {
            result.current.onTogglePin("email");
        });

        expect(result.current.pinnedColumns.has("email")).toBe(true);
        expect(storedPins()).toStrictEqual({ users: ["email"] });
    });

    it("reads pins an earlier session wrote under that key", () => {
        expect.assertions(2);

        seedPins({ users: ["name"] });

        const { result } = renderPreferences();

        expect(result.current.pinnedColumns.has("name")).toBe(true);
        expect(result.current.pinnedColumns.has("email")).toBe(false);
    });

    it("seeds from the URL only for a table this browser has never pinned", () => {
        expect.assertions(2);

        // STORAGE wins; `?pins=` is only a seed. Otherwise every pin/unpin is a no-op
        // for the rest of the session whenever the URL carries pins.
        seedPins({ users: ["name"] });

        const { result: withStoredPins } = renderPreferences("email");

        expect(withStoredPins.current.pinnedColumns.has("email")).toBe(false);

        localStorage.clear();

        const { result: withoutStoredPins } = renderPreferences("email");

        expect(withoutStoredPins.current.pinnedColumns.has("email")).toBe(true);
    });
});
