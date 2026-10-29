import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdminSubscriptions } from "../../src/react/admin";
import { AdminUsers, ImpersonationBanner } from "../../src/react/admin-users";
import { adminClient, adminSubscription, adminUser, NOW, organization, PLANS } from "../cards.fixtures";

describe("adminUsers", () => {
    it("lists users once loaded, offering nothing on the viewer's own row", async () => {
        const client = adminClient([adminUser("me", { role: "admin" }), adminUser("ada")]);

        render(<AdminUsers client={client} now={NOW} onSessionChange={vi.fn()} viewerId="me" />);

        await expect(screen.findByText("ada@example.com")).resolves.toBeInTheDocument();

        expect(screen.getByText("2 users")).toBeInTheDocument();
        expect(screen.queryByLabelText("Suspend me")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Suspend ada")).toBeInTheDocument();
    });

    it("suspends through the client, then re-reads the list", async () => {
        const client = adminClient([adminUser("ada")]);

        render(<AdminUsers client={client} now={NOW} onSessionChange={vi.fn()} viewerId="me" />);
        fireEvent.click(await screen.findByLabelText("Suspend ada"));

        await vi.waitFor(() => {
            expect(client.listUsers).toHaveBeenCalledTimes(2);
        });

        expect(client.banUser).toHaveBeenCalledWith({ userId: "ada" });
    });

    it("offers the way back on a suspended user, and not impersonation", async () => {
        const client = adminClient([adminUser("ada", { banned: true, banReason: "spam" })]);

        render(<AdminUsers client={client} now={NOW} onSessionChange={vi.fn()} viewerId="me" />);
        fireEvent.click(await screen.findByLabelText("Unsuspend ada"));

        expect(screen.getByText("Suspended — spam")).toBeInTheDocument();
        expect(screen.queryByLabelText("Impersonate ada")).not.toBeInTheDocument();

        await vi.waitFor(() => {
            expect(client.unbanUser).toHaveBeenCalledWith({ userId: "ada" });
        });
    });

    it("navigates once an impersonation starts", async () => {
        const onSessionChange = vi.fn();
        const client = adminClient([adminUser("ada")]);

        render(<AdminUsers client={client} now={NOW} onSessionChange={onSessionChange} viewerId="me" />);
        fireEvent.click(await screen.findByLabelText("Impersonate ada"));

        await vi.waitFor(() => {
            expect(onSessionChange).toHaveBeenCalledTimes(1);
        });
    });

    it("searches by email on submit", async () => {
        const client = adminClient([]);

        render(<AdminUsers client={client} now={NOW} onSessionChange={vi.fn()} viewerId="me" />);

        await expect(screen.findByText("No users yet")).resolves.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Search users by email"), { target: { value: "ada" } });
        fireEvent.click(screen.getByText("Search"));

        await expect(screen.findByText("Nobody matches that search")).resolves.toBeInTheDocument();

        expect(client.listUsers.mock.lastCall?.[0].query.searchValue).toBe("ada");
    });
});

describe("impersonationBanner", () => {
    it("renders nothing for an admin acting as themselves", () => {
        const { container } = render(
            <ImpersonationBanner client={adminClient([])} onSessionChange={vi.fn()} session={{ session: {}, user: { email: "me@example.com" } }} />,
        );

        expect(container).toBeEmptyDOMElement();
    });

    it("names the impersonated user and stops on request", async () => {
        const onSessionChange = vi.fn();
        const client = adminClient([]);

        render(
            <ImpersonationBanner
                client={client}
                onSessionChange={onSessionChange}
                session={{ session: { impersonatedBy: "admin-1" }, user: { email: "ada@example.com", name: "Ada" } }}
            />,
        );

        expect(screen.getByRole("status")).toHaveTextContent("You are signed in as Ada.");

        fireEvent.click(screen.getByText("Stop impersonating"));

        await vi.waitFor(() => {
            expect(onSessionChange).toHaveBeenCalledTimes(1);
        });
    });
});

describe("adminSubscriptions", () => {
    it("names each tenant, totals paying and past-due, and filters by state", () => {
        render(
            <AdminSubscriptions
                organizations={[organization("Acme", "pro", 3), organization("Globex", "pro", 3)]}
                plans={PLANS}
                rows={[adminSubscription("org-Acme", "active"), adminSubscription("org-Globex", "past_due")]}
            />,
        );

        expect(screen.getByText("1 paying · 1 past due")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Filter by state"), { target: { value: "past_due" } });

        expect(screen.queryByText("Acme")).not.toBeInTheDocument();
        expect(screen.getByText("Globex")).toBeInTheDocument();
    });

    it("asks for the next page while one remains, and says the totals are partial", () => {
        const onLoadMore = vi.fn();
        const { rerender } = render(
            <AdminSubscriptions onLoadMore={onLoadMore} organizations={[]} plans={PLANS} rows={[adminSubscription("org-Acme", "active")]} />,
        );

        expect(screen.getByText("1 paying · 0 past due in the 1 loaded")).toBeInTheDocument();

        fireEvent.click(screen.getByText("Load more"));

        expect(onLoadMore).toHaveBeenCalledTimes(1);

        rerender(<AdminSubscriptions organizations={[]} plans={PLANS} rows={[adminSubscription("org-Acme", "active")]} />);

        expect(screen.queryByText("Load more")).not.toBeInTheDocument();
    });

    it("marks itself busy while the query is undefined", () => {
        const { container } = render(<AdminSubscriptions organizations={undefined} plans={PLANS} rows={undefined} />);

        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });
});
