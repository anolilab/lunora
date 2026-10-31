import type { AdminTokenSummary, CreatedAdminToken } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen, waitForElementToBeRemoved } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AdminTokensCard from "../../../src/features/settings/admin-tokens-card";
import { createMockClient } from "../../mock-client";

describe("adminTokensCard", () => {
    it("shows a created token's secret once, lists it, and revokes it", async () => {
        expect.assertions(5);

        render(
            <LunoraProvider client={createMockClient({}).asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        fireEvent.change(screen.getByTestId("set-admin-token-name"), { target: { value: "ci" } });
        fireEvent.click(screen.getByTestId("set-admin-token-create"));

        const created = await screen.findByTestId("set-admin-token-created");

        expect(created.textContent).toContain(`lnat.ci.${"s".repeat(43)}`);
        await expect(screen.findAllByTestId("set-admin-token-row")).resolves.toHaveLength(1);

        const row = screen.getByTestId("set-admin-token-row");

        fireEvent.click(screen.getByTestId("set-admin-token-revoke-ci"));

        // The first click only asks for confirmation.
        expect(screen.queryAllByTestId("set-admin-token-row")).toHaveLength(1);

        fireEvent.click(screen.getByTestId("set-admin-token-revoke-ci-confirm"));

        await waitForElementToBeRemoved(row);

        expect(screen.queryAllByTestId("set-admin-token-row")).toHaveLength(0);

        // Revoking the token just created also clears its one-time secret.
        expect(screen.queryByTestId("set-admin-token-created")).toBeNull();
    });

    it("submits one create while one is in flight", async () => {
        expect.assertions(3);

        const mock = createMockClient({});
        const pending: { release?: (token: CreatedAdminToken) => void } = {};

        mock.createAdminToken.mockImplementationOnce(
            () =>
                new Promise<CreatedAdminToken>((resolve) => {
                    pending.release = resolve;
                }),
        );

        render(
            <LunoraProvider client={mock.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        fireEvent.change(screen.getByTestId("set-admin-token-name"), { target: { value: "ci" } });
        fireEvent.click(screen.getByTestId("set-admin-token-create"));
        fireEvent.click(screen.getByTestId("set-admin-token-create"));

        expect(mock.createAdminToken).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId<HTMLButtonElement>("set-admin-token-create").disabled).toBe(true);

        act(() => {
            pending.release?.({ createdAt: 1, name: "ci", token: `lnat.ci.${"s".repeat(43)}` });
        });

        await screen.findByTestId("set-admin-token-created");

        // Held until the shown secret is dismissed.
        expect(screen.getByTestId<HTMLButtonElement>("set-admin-token-create").disabled).toBe(true);
    });

    it("keeps the newest list when the mount-time load answers last", async () => {
        expect.assertions(1);

        const mock = createMockClient({});
        const pending: { release?: (tokens: AdminTokenSummary[]) => void } = {};

        mock.listAdminTokens.mockImplementationOnce(
            () =>
                new Promise<AdminTokenSummary[]>((resolve) => {
                    pending.release = resolve;
                }),
        );

        render(
            <LunoraProvider client={mock.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        fireEvent.change(screen.getByTestId("set-admin-token-name"), { target: { value: "ci" } });
        fireEvent.click(screen.getByTestId("set-admin-token-create"));

        await screen.findByTestId("set-admin-token-row");

        // The stale answer from before the create lands now.
        await act(async () => {
            pending.release?.([]);
        });

        expect(screen.queryAllByTestId("set-admin-token-row")).toHaveLength(1);
    });

    it("hides the shown secret on dismiss", async () => {
        expect.assertions(1);

        render(
            <LunoraProvider client={createMockClient({}).asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        fireEvent.change(screen.getByTestId("set-admin-token-name"), { target: { value: "ci" } });
        fireEvent.click(screen.getByTestId("set-admin-token-create"));
        fireEvent.click(await screen.findByTestId("set-admin-token-dismiss"));

        expect(screen.queryByTestId("set-admin-token-created")).toBeNull();
    });

    it("refuses a second create until the shown secret is dismissed", async () => {
        expect.assertions(5);

        const mock = createMockClient({});

        render(
            <LunoraProvider client={mock.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        fireEvent.change(screen.getByTestId("set-admin-token-name"), { target: { value: "ci" } });
        fireEvent.click(screen.getByTestId("set-admin-token-create"));
        await screen.findByTestId("set-admin-token-created");

        fireEvent.change(screen.getByTestId("set-admin-token-name"), { target: { value: "deploy" } });

        expect(screen.getByTestId<HTMLButtonElement>("set-admin-token-create").disabled).toBe(true);

        // A submit that bypasses the disabled button (Enter in the name field) is refused too.
        fireEvent.submit(screen.getByTestId("set-admin-token-name"));

        expect(mock.createAdminToken).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("set-admin-token-created").textContent).toContain(`lnat.ci.`);

        fireEvent.click(screen.getByTestId("set-admin-token-dismiss"));

        expect(screen.getByTestId<HTMLButtonElement>("set-admin-token-create").disabled).toBe(false);

        fireEvent.click(screen.getByTestId("set-admin-token-create"));

        await expect(screen.findByTestId("set-admin-token-created")).resolves.toBeDefined();
    });

    it("drops the previous client's rows while the new client's list is pending or fails", async () => {
        expect.assertions(2);

        const first = createMockClient({});

        first.listAdminTokens.mockResolvedValue([{ createdAt: 1, name: "from-first" }]);

        const second = createMockClient({});

        second.listAdminTokens.mockReturnValue(Promise.withResolvers<AdminTokenSummary[]>().promise);

        const { rerender } = render(
            <LunoraProvider client={first.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        await expect(screen.findByText("from-first")).resolves.toBeDefined();

        rerender(
            <LunoraProvider client={second.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        // The second deployment has not answered: nothing of the first one's may stand in for it.
        expect(screen.queryByText("from-first")).toBeNull();
    });

    it("never shows a secret created under the previous client, whether the client changes after it is shown or while it is in flight", async () => {
        expect.assertions(5);

        const first = createMockClient({});
        const second = createMockClient({});
        const pending: { release?: (token: CreatedAdminToken) => void } = {};

        first.createAdminToken.mockImplementationOnce(
            async () =>
                new Promise<CreatedAdminToken>((resolve) => {
                    pending.release = resolve;
                }),
        );

        const { rerender } = render(
            <LunoraProvider client={first.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        // A swap while the create is in flight: its late answer must not appear.
        fireEvent.change(screen.getByTestId("set-admin-token-name"), { target: { value: "ci" } });
        fireEvent.click(screen.getByTestId("set-admin-token-create"));
        rerender(
            <LunoraProvider client={second.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );
        await act(async () => {
            pending.release?.({ createdAt: 1, name: "ci", token: `lnat.ci.${"s".repeat(43)}` });
        });

        expect(screen.queryByTestId("set-admin-token-created")).toBeNull();
        // The new client is not held up by the old client's request.
        expect(screen.getByTestId<HTMLButtonElement>("set-admin-token-create").disabled).toBe(false);

        // A swap after the secret is on screen drops it.
        fireEvent.change(screen.getByTestId("set-admin-token-name"), { target: { value: "deploy" } });
        fireEvent.click(screen.getByTestId("set-admin-token-create"));
        await screen.findByTestId("set-admin-token-created");

        const third = createMockClient({});

        rerender(
            <LunoraProvider client={third.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        expect(screen.queryByTestId("set-admin-token-created")).toBeNull();
        expect(screen.queryByText(/lnat\.deploy\./u)).toBeNull();
        expect(screen.getByTestId<HTMLButtonElement>("set-admin-token-create").disabled).toBe(false);
    });

    it("does not let a revoke on the previous client supersede the new client's list", async () => {
        expect.assertions(3);

        const first = createMockClient({});
        const second = createMockClient({});
        const pending: { release?: () => void } = {};

        first.listAdminTokens.mockResolvedValue([{ createdAt: 1, name: "old" }]);
        first.revokeAdminToken.mockImplementation(
            async () =>
                new Promise<void>((resolve) => {
                    pending.release = resolve;
                }),
        );
        second.listAdminTokens.mockResolvedValue([{ createdAt: 2, name: "fresh" }]);

        const { rerender } = render(
            <LunoraProvider client={first.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        await screen.findByText("old");
        fireEvent.click(screen.getByTestId("set-admin-token-revoke-old"));
        fireEvent.click(screen.getByTestId("set-admin-token-revoke-old-confirm"));

        rerender(
            <LunoraProvider client={second.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );
        await screen.findByText("fresh");

        const callsBefore = first.listAdminTokens.mock.calls.length;

        await act(async () => {
            pending.release?.();
        });

        // The old client's revoke finished after the switch: it neither reloads nor hides the new list.
        expect(first.listAdminTokens).toHaveBeenCalledTimes(callsBefore);
        expect(second.listAdminTokens).toHaveBeenCalledTimes(1);
        expect(screen.getByText("fresh")).not.toBeNull();
    });

    it("reloads the list after a revoke that failed, since the token may already be refused", async () => {
        expect.assertions(3);

        const mock = createMockClient({});

        mock.listAdminTokens.mockResolvedValueOnce([{ createdAt: 1, name: "ci" }]).mockResolvedValue([]);
        mock.revokeAdminToken.mockRejectedValue(new Error("token table write failed"));

        render(
            <LunoraProvider client={mock.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        await screen.findByText("ci");
        fireEvent.click(screen.getByTestId("set-admin-token-revoke-ci"));
        fireEvent.click(screen.getByTestId("set-admin-token-revoke-ci-confirm"));

        await screen.findByTestId("set-admin-tokens-error");

        // The row is gone (the listing no longer carries it) and the failure is still reported.
        expect(mock.listAdminTokens).toHaveBeenCalledTimes(2);
        expect(screen.queryByText("ci")).toBeNull();
        expect(screen.getByTestId("set-admin-tokens-error").textContent).toContain("token table write failed");
    });

    it("labels a revoked token whose row is still stored, and still offers to clear it", async () => {
        expect.assertions(2);

        const mock = createMockClient({});

        mock.listAdminTokens.mockResolvedValue([{ createdAt: 1, name: "ci", revoked: true }]);

        render(
            <LunoraProvider client={mock.asClient}>
                <AdminTokensCard />
            </LunoraProvider>,
        );

        const row = await screen.findByTestId("set-admin-token-row");

        expect(row.textContent).toContain("Revoked");
        expect(screen.getByTestId("set-admin-token-revoke-ci")).toBeDefined();
    });
});
