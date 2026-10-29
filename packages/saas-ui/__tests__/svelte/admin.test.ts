import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import AdminSubscriptions from "../../src/svelte/AdminSubscriptions.svelte";
import AdminUsers from "../../src/svelte/AdminUsers.svelte";
import ImpersonationBanner from "../../src/svelte/ImpersonationBanner.svelte";
import { adminClient, adminSubscription, adminUser, NOW, organization, PLANS } from "../cards.fixtures";

/**
 * The same behaviours `__tests__/react/admin.test.tsx` asserts, against the
 * same core and fixtures — the port differs only in how it mounts.
 */

describe("adminUsers", () => {
    it("lists users once loaded, offering nothing on the viewer's own row", async () => {
        const client = adminClient([adminUser("me", { role: "admin" }), adminUser("ada")]);

        render(AdminUsers, { client, now: NOW, onSessionChange: vi.fn(), viewerId: "me" });

        await expect(screen.findByText("ada@example.com")).resolves.toBeInTheDocument();

        expect(screen.getByText("2 users")).toBeInTheDocument();
        expect(screen.queryByLabelText("Suspend me")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Suspend ada")).toBeInTheDocument();
    });

    it("asks to confirm a suspension, then suspends with the reason and re-reads the list", async () => {
        const client = adminClient([adminUser("ada")]);

        render(AdminUsers, { client, now: NOW, onSessionChange: vi.fn(), viewerId: "me" });
        await fireEvent.click(await screen.findByLabelText("Suspend ada"));

        expect(client.banUser).not.toHaveBeenCalled();

        await fireEvent.input(screen.getByLabelText("Reason for suspending ada"), { target: { value: "chargeback fraud" } });
        await fireEvent.click(screen.getByLabelText("Confirm suspending ada"));

        // The step closes once the suspension and the re-read after it have settled.
        await vi.waitFor(() => {
            expect(screen.queryByLabelText("Confirm suspending ada")).not.toBeInTheDocument();
        });

        expect(client.banUser).toHaveBeenCalledWith({ banReason: "chargeback fraud", userId: "ada" });
        expect(client.listUsers).toHaveBeenCalledTimes(2);
    });

    it("backs out of a suspension without suspending anyone", async () => {
        const client = adminClient([adminUser("ada")]);

        render(AdminUsers, { client, now: NOW, onSessionChange: vi.fn(), viewerId: "me" });
        await fireEvent.click(await screen.findByLabelText("Suspend ada"));
        await fireEvent.click(screen.getByText("Cancel"));

        expect(screen.getByLabelText("Suspend ada")).toBeInTheDocument();
        expect(client.banUser).not.toHaveBeenCalled();
    });

    it("keeps the confirm step open beside a refused suspension", async () => {
        const client = adminClient([adminUser("ada")]);

        client.banUser.mockResolvedValueOnce({ error: { message: "You cannot ban an admin", status: 403 } });

        render(AdminUsers, { client, now: NOW, onSessionChange: vi.fn(), viewerId: "me" });
        await fireEvent.click(await screen.findByLabelText("Suspend ada"));
        await fireEvent.click(screen.getByLabelText("Confirm suspending ada"));

        await expect(screen.findByText("You cannot ban an admin")).resolves.toBeInTheDocument();

        expect(client.banUser).toHaveBeenCalledWith({ userId: "ada" });
        expect(screen.getByLabelText("Confirm suspending ada")).toBeInTheDocument();
    });

    it("offers the way back on a suspended user, and not impersonation", async () => {
        const client = adminClient([adminUser("ada", { banned: true, banReason: "spam" })]);

        render(AdminUsers, { client, now: NOW, onSessionChange: vi.fn(), viewerId: "me" });
        await fireEvent.click(await screen.findByLabelText("Unsuspend ada"));

        expect(screen.getByText("Suspended — spam")).toBeInTheDocument();
        expect(screen.queryByLabelText("Impersonate ada")).not.toBeInTheDocument();

        await vi.waitFor(() => {
            expect(client.unbanUser).toHaveBeenCalledWith({ userId: "ada" });
        });
    });

    it("navigates once an impersonation starts", async () => {
        const onSessionChange = vi.fn();
        const client = adminClient([adminUser("ada")]);

        render(AdminUsers, { client, now: NOW, onSessionChange, viewerId: "me" });
        await fireEvent.click(await screen.findByLabelText("Impersonate ada"));

        await vi.waitFor(() => {
            expect(onSessionChange).toHaveBeenCalledTimes(1);
        });
    });

    it("pages past the first 50 users", async () => {
        const client = adminClient(Array.from({ length: 51 }, (_, index) => adminUser(`user${String(index)}`)));

        render(AdminUsers, { client, now: NOW, onSessionChange: vi.fn(), viewerId: "me" });

        await expect(screen.findByText("1–50 of 51")).resolves.toBeInTheDocument();

        expect(screen.getByText("Previous")).toBeDisabled();

        await fireEvent.click(screen.getByText("Next"));

        await expect(screen.findByText("user50@example.com")).resolves.toBeInTheDocument();

        expect(client.listUsers.mock.lastCall?.[0].query.offset).toBe(50);
        expect(screen.getByText("51–51 of 51")).toBeInTheDocument();
        expect(screen.getByText("Next")).toBeDisabled();
    });

    it("drops the loading placeholder when the first load fails", async () => {
        const client = adminClient([]);

        client.listUsers.mockResolvedValueOnce({ error: { message: "Only admins may list users", status: 403 } });

        const { container } = render(AdminUsers, { client, now: NOW, onSessionChange: vi.fn(), viewerId: "me" });

        await expect(screen.findByText("Only admins may list users")).resolves.toBeInTheDocument();

        expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    it("searches by email on submit", async () => {
        const client = adminClient([]);

        render(AdminUsers, { client, now: NOW, onSessionChange: vi.fn(), viewerId: "me" });

        await expect(screen.findByText("No users yet")).resolves.toBeInTheDocument();

        await fireEvent.input(screen.getByLabelText("Search users by email"), { target: { value: "ada" } });
        await fireEvent.click(screen.getByText("Search"));

        await expect(screen.findByText("Nobody matches that search")).resolves.toBeInTheDocument();

        expect(client.listUsers.mock.lastCall?.[0].query.searchValue).toBe("ada");
    });
});

describe("impersonationBanner", () => {
    it("renders nothing for an admin acting as themselves", () => {
        render(ImpersonationBanner, { client: adminClient([]), onSessionChange: vi.fn(), session: { session: {}, user: { email: "me@example.com" } } });

        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("names the impersonated user and stops on request", async () => {
        const onSessionChange = vi.fn();
        const client = adminClient([]);

        render(ImpersonationBanner, {
            client,
            onSessionChange,
            session: { session: { impersonatedBy: "admin-1" }, user: { email: "ada@example.com", name: "Ada" } },
        });

        expect(screen.getByRole("status")).toHaveTextContent("You are signed in as Ada.");

        await fireEvent.click(screen.getByText("Stop impersonating"));

        await vi.waitFor(() => {
            expect(onSessionChange).toHaveBeenCalledTimes(1);
        });
    });
});

describe("adminSubscriptions", () => {
    it("names each tenant, totals paying and past-due, and filters by state", async () => {
        render(AdminSubscriptions, {
            organizations: [organization("Acme", "pro", 3), organization("Globex", "pro", 3)],
            plans: PLANS,
            rows: [adminSubscription("org-Acme", "active"), adminSubscription("org-Globex", "past_due")],
        });

        expect(screen.getByText("1 paying · 1 past due")).toBeInTheDocument();

        await fireEvent.change(screen.getByLabelText("Filter by state"), { target: { value: "past_due" } });

        expect(screen.queryByText("Acme")).not.toBeInTheDocument();
        expect(screen.getByText("Globex")).toBeInTheDocument();
    });

    it("asks for the next page while one remains, and says the totals are partial", async () => {
        const onLoadMore = vi.fn();
        const { rerender } = render(AdminSubscriptions, { onLoadMore, organizations: [], plans: PLANS, rows: [adminSubscription("org-Acme", "active")] });

        expect(screen.getByText("1 paying · 0 past due in the 1 loaded")).toBeInTheDocument();

        await fireEvent.click(screen.getByText("Load more"));

        expect(onLoadMore).toHaveBeenCalledTimes(1);

        await rerender({ onLoadMore: undefined });

        expect(screen.queryByText("Load more")).not.toBeInTheDocument();
    });

    it("lists two providers' subscriptions that share an id as two rows", () => {
        const rows = [adminSubscription("org-Acme", "active"), { ...adminSubscription("org-Acme", "past_due"), provider: "polar" }];

        render(AdminSubscriptions, { organizations: [], plans: PLANS, rows });

        expect(screen.getAllByText("sub_org-Acme")).toHaveLength(2);
    });

    it("lists a past-due tenant first although no loaded page holds it", () => {
        const older = adminSubscription("org-Globex", "past_due");

        render(AdminSubscriptions, {
            onLoadMore: vi.fn(),
            organizations: [organization("Acme", "pro", 3), organization("Globex", "pro", 3)],
            pastDue: { more: false, rows: [older] },
            plans: PLANS,
            rows: [adminSubscription("org-Acme", "active")],
        });

        const rows = screen.getAllByRole("row").slice(1);

        expect(rows.map((row) => row.querySelector("td")?.firstChild?.textContent)).toStrictEqual(["Globex", "Acme"]);
        expect(screen.getByText("1 paying in the 1 loaded · 1 past due")).toBeInTheDocument();
    });

    it("marks itself busy while the query is undefined", () => {
        const { container } = render(AdminSubscriptions, { organizations: undefined, plans: PLANS, rows: undefined });

        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });
});
