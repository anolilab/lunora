import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { openCommandPalette } from "../../src/app/command-palette";
import { Studio } from "../../src/app/studio";
import { ADMIN_FUNCTIONS } from "../../src/lib/admin";
import { resetShortcuts, setShortcut } from "../../src/lib/shortcuts";
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
    <LunoraProvider client={mock.asClient}>
        <Studio />
    </LunoraProvider>
);

describe("command palette", () => {
    afterEach(() => {
        resetShortcuts();
    });

    it("opens on the rebound key and no longer on the default", async () => {
        expect.assertions(2);

        render(renderStudio(createClient()));
        await screen.findByTestId("lunora-studio");

        act(() => {
            setShortcut("palette", "j");
        });

        fireEvent.keyDown(document.body, { key: "k", metaKey: true });

        // A rebinding that leaves the old key working is a rebinding that did not
        // happen — the effect has to re-subscribe on the new key, not add one.
        expect(screen.queryByTestId("dash-command-palette")).toBeNull();

        fireEvent.keyDown(document.body, { key: "j", metaKey: true });

        await expect(screen.findByTestId("dash-command-palette")).resolves.toBeDefined();
    });

    it("opens on ⌘K", async () => {
        expect.assertions(1);

        render(renderStudio(createClient()));
        await screen.findByTestId("lunora-studio");

        fireEvent.keyDown(document.body, { key: "k", metaKey: true });

        await expect(screen.findByTestId("dash-command-palette")).resolves.toBeDefined();
    });

    it("opens the operation console, which has no route and no button", async () => {
        expect.assertions(2);

        render(renderStudio(createClient()));
        await screen.findByTestId("lunora-studio");

        act(() => {
            openCommandPalette();
        });

        const input = await screen.findByTestId<HTMLInputElement>("dash-command-input");

        fireEvent.change(input, { target: { value: "operation console" } });

        expect(screen.getByTestId("dash-command-list").textContent).toContain("Toggle operation console");

        // The console is reachable by keyboard chord ONLY — no route, no button —
        // so this entry is what keeps it discoverable, and reachable at all once an
        // operator rebinds the chord and forgets what to.
        fireEvent.keyDown(input, { key: "Enter" });

        await expect(screen.findByTestId("lunora-operation-console")).resolves.toBeDefined();
    });

    it("opens via the top-bar Search button's window event and navigates to a filtered destination", async () => {
        expect.assertions(2);

        render(renderStudio(createClient()));
        await screen.findByTestId("lunora-studio");

        act(() => {
            openCommandPalette();
        });

        const input = await screen.findByTestId<HTMLInputElement>("dash-command-input");

        fireEvent.change(input, { target: { value: "Security" } });

        // Filtered to the Security sub-page; Enter selects the active (first) match.
        expect(screen.getByTestId("dash-command-list").textContent).toContain("Security");

        fireEvent.keyDown(input, { key: "Enter" });

        await expect(screen.findByTestId("lunora-security-advisor")).resolves.toBeDefined();
    });
});
