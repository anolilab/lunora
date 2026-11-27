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

// What the admin plane records: the account it acted on, by address and by id.
const ADMIN_ENTRY: AuthAuditEntry = {
    actorId: "admin:token:oncall",
    detail: { path: "/_lunora/admin/auth/users/create", targetUserId: "u9" },
    event: "admin-user-create",
    outcome: "success",
    seq: 3,
    targetEmail: "new@example.com",
    ts: 1_700_000_003_000,
};

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

        // columns: time, event, actor, target, ip/ua, outcome
        expect(cells[2]?.textContent).toContain("alice@example.com");
        expect(cells[4]?.textContent).toContain("203.0.113.7");
        expect(cells[5]?.textContent?.toLowerCase()).toContain("success");
    });

    it("names the account an admin operation acted on, and finds the row by it", async () => {
        expect.assertions(3);

        render(renderPanel(createClient([ADMIN_ENTRY, ...ENTRIES])));

        await screen.findByTestId("aa-table");

        const target = within(bodyRows()[0] as HTMLElement).getAllByRole("cell")[3];

        expect(target?.textContent).toContain("new@example.com");
        expect(target?.textContent).toContain("u9");

        fireEvent.change(screen.getByTestId("aa-search"), { target: { value: "u9" } });

        await expect(screen.findAllByTestId("aa-row")).resolves.toHaveLength(1);
    });

    it("finds a row by any id it names, and shows an OAuth or SCIM target", async () => {
        expect.assertions(2);

        const memberAdd: AuthAuditEntry = {
            actorId: "admin:root",
            detail: { memberId: "m9", organizationId: "org_1", path: "/_lunora/admin/auth/organizations/members/add", targetUserId: "u9" },
            event: "org-member-add",
            outcome: "success",
            seq: 4,
            ts: 1_700_000_004_000,
        };
        const consent: AuthAuditEntry = {
            actorId: "u1",
            detail: { clientId: "client_42" },
            event: "oauth-consent",
            outcome: "success",
            seq: 5,
            ts: 1_700_000_005_000,
        };

        render(renderPanel(createClient([consent, memberAdd, ...ENTRIES])));

        await screen.findByTestId("aa-table");

        expect(within(bodyRows()[0] as HTMLElement).getAllByRole("cell")[3]?.textContent).toContain("client_42");

        fireEvent.change(screen.getByTestId("aa-search"), { target: { value: "org_1" } });

        await expect(screen.findAllByTestId("aa-row")).resolves.toHaveLength(1);
    });

    it("shows a new organization, not its owner, as the target of an org create", async () => {
        expect.assertions(2);

        const orgCreate: AuthAuditEntry = {
            actorId: "admin:root",
            detail: { organizationId: "org_7", path: "/_lunora/admin/auth/organizations/create", targetUserId: "u9" },
            event: "org-create",
            outcome: "success",
            seq: 6,
            ts: 1_700_000_006_000,
        };

        render(renderPanel(createClient([orgCreate])));

        await screen.findByTestId("aa-table");

        const target = within(bodyRows()[0] as HTMLElement).getAllByRole("cell")[3];

        expect(target?.textContent).toContain("org_7");
        expect(target?.textContent).not.toContain("u9");
    });

    it("shows a failed sign-in's hashed identifier as a short label, with the full digest in its title", async () => {
        expect.assertions(5);

        const digest = `hmac-sha256:${"ab12cd34".repeat(8)}`;
        const failedSignIn: AuthAuditEntry = { event: "sign-in", outcome: "failure", seq: 7, targetEmail: digest, ts: 1_700_000_007_000 };

        render(renderPanel(createClient([failedSignIn, ADMIN_ENTRY])));

        await screen.findByTestId("aa-table");

        const [hashedTarget, plainTarget] = bodyRows().map((row) => within(row).getAllByRole("cell")[3]);
        const label = within(hashedTarget as HTMLElement).getByTestId("aa-hashed-target");

        expect(hashedTarget?.textContent).not.toContain(digest);
        expect(label.textContent).toBe("ab12cd34… hashed");
        expect(label.getAttribute("title")).toBe(digest);
        expect(plainTarget?.textContent).toContain("new@example.com");

        fireEvent.change(screen.getByTestId("aa-search"), { target: { value: digest.slice(0, 20) } });

        await expect(screen.findAllByTestId("aa-row")).resolves.toHaveLength(1);
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
