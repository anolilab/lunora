import { CirrusProvider } from "@cirrus/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { openCommandPalette } from "../../src/app/command-palette";
import { Studio } from "../../src/app/studio";
import { ADMIN_FUNCTIONS } from "../../src/lib/admin";
import type { MockClientHooks } from "../mock-client";
import { createMockClient } from "../mock-client";

const createClient = (): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getSecurityAudit) {
                return { findings: [] };
            }

            if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                return { functions: [], sinceMs: 0 };
            }

            return { columns: [], rows: [], total: 0 };
        },
    });

const renderStudio = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <Studio />
    </CirrusProvider>
);

describe("command palette", () => {
    it("opens on ⌘K", async () => {
        expect.assertions(1);

        render(renderStudio(createClient()));
        await screen.findByTestId("cirrus-studio");

        fireEvent.keyDown(document.body, { key: "k", metaKey: true });

        await expect(screen.findByTestId("dash-command-palette")).resolves.toBeDefined();
    });

    it("opens via the top-bar Search button's window event and navigates to a filtered destination", async () => {
        expect.assertions(2);

        render(renderStudio(createClient()));
        await screen.findByTestId("cirrus-studio");

        act(() => {
            openCommandPalette();
        });

        const input = await screen.findByTestId<HTMLInputElement>("dash-command-input");

        fireEvent.change(input, { target: { value: "Security" } });

        // Filtered to the Security sub-page; Enter selects the active (first) match.
        expect(screen.getByTestId("dash-command-list").textContent).toContain("Security");

        fireEvent.keyDown(input, { key: "Enter" });

        await expect(screen.findByTestId("cirrus-security-advisor")).resolves.toBeDefined();
    });
});
