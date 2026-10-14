import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import BindingsOverview from "../../../src/features/home/bindings-overview";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

// The cards navigate via TanStack Router; stub `useNavigate` with a stable spy
// (hoisted so it exists when vi.mock's factory runs).
const { navigateSpy } = vi.hoisted(() => {
    return { navigateSpy: vi.fn<() => Promise<void>>(async () => {}) };
});

vi.mock(import("@tanstack/react-router"), () => {
    return { useNavigate: () => navigateSpy };
});

const renderOverview = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <BindingsOverview />
    </LunoraProvider>
);

const makeClient = (): MockClientHooks =>
    createMockClient({
        kvNamespaces: [{ binding: "CACHE" }, { binding: "SESSIONS" }],
        listStorageBuckets: () => ["STORAGE"],
        listVectorIndexes: () => [{ name: "docs", table: "docs" }],
    });

describe("bindingsOverview", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("renders a card per configured binding with its names as chips", async () => {
        expect.assertions(3);

        render(renderOverview(makeClient()));

        await screen.findByTestId("home-binding-kv");

        // KV namespace names surface as chips.
        expect(screen.getByText("CACHE")).toBeDefined();
        expect(screen.getByText("SESSIONS")).toBeDefined();
        // R2 + Vectorize cards render too.
        expect(screen.getByTestId("home-binding-r2")).toBeDefined();
    });

    it("navigates to the binding's tab when its card is clicked", async () => {
        expect.assertions(1);

        render(renderOverview(makeClient()));

        fireEvent.click(await screen.findByTestId("home-binding-kv"));

        expect(navigateSpy).toHaveBeenCalledWith({ to: "/kv" });
    });
});
