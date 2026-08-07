import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AuthAuditPanel from "../../../src/features/auth/auth-audit-panel";
import type { AuthAuditEntry } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const ENTRIES: AuthAuditEntry[] = [
    {
        actorEmail: "alice@example.com",
        actorId: "u1",
        event: "sign-in",
        ip: "203.0.113.7",
        outcome: "success",
        seq: 2,
        ts: 1_700_000_002_000,
        userAgent: "curl/8",
    },
    { actorId: "u2", event: "password-change", ip: "198.51.100.4", outcome: "failure", seq: 1, ts: 1_700_000_001_000 },
];

const createClient = (entries: AuthAuditEntry[] = ENTRIES): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getAuthAuditLog) {
                return { entries };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <AuthAuditPanel />
    </LunoraProvider>
);

const bodyRows = (): HTMLElement[] => screen.getAllByTestId("aa-row");

describe("authAuditPanel", () => {
    it("renders a row per recorded auth event on mount, newest first", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        await screen.findByTestId("aa-table");

        const rows = bodyRows();

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("sign-in");
        expect(rows[1]?.textContent).toContain("password-change");
    });

    it("renders the actor, ip, and outcome columns for an entry", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        await screen.findByTestId("aa-table");

        const signIn = bodyRows()[0] as HTMLElement;
        const cells = within(signIn).getAllByRole("cell");

        // columns: time, event, actor, ip/ua, outcome
        expect(cells[2]?.textContent).toContain("alice@example.com");
        expect(cells[3]?.textContent).toContain("203.0.113.7");
        expect(cells[4]?.textContent?.toLowerCase()).toContain("success");
    });

    it("shows the empty state when there are no events", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([])));

        const empty = await screen.findByTestId("aa-empty");

        expect(empty.textContent).toContain("No security events.");
    });

    it("filters events by event/actor/ip substring", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        await screen.findByTestId("aa-table");

        fireEvent.change(screen.getByTestId("aa-search"), { target: { value: "password" } });

        const rows = await screen.findAllByTestId("aa-row");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.textContent).toContain("password-change");
    });

    it("filters by actor id as well", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        await screen.findByTestId("aa-table");

        fireEvent.change(screen.getByTestId("aa-search"), { target: { value: "u1" } });

        await expect(screen.findAllByTestId("aa-row")).resolves.toHaveLength(1);
    });

    it("surfaces an error", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        const error = await screen.findByTestId("aa-error");

        expect(error.textContent).toBe("ADMIN_FORBIDDEN");
    });
});
