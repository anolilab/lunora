import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import NotificationsPanel from "../../../src/features/notifications/notifications-panel";
import type { PushSubscriptionDevice, PushSubscriptionsResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const device = (overrides: Partial<PushSubscriptionDevice> & Pick<PushSubscriptionDevice, "id" | "kind">): PushSubscriptionDevice => {
    return {
        createdAt: 0,
        lastSeenAt: 0,
        ...overrides,
    };
};

const subscriptions: PushSubscriptionDevice[] = [
    device({ endpoint: "https://push.example/ok", id: "wp-ok", kind: "web-push", lastStatus: "ok" }),
    device({ endpoint: "https://push.example/bad", id: "wp-bad", kind: "web-push", lastStatus: "failed" }),
    device({ id: "fcm-ok-token", kind: "fcm", lastStatus: "ok" }),
];

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <NotificationsPanel />
    </LunoraProvider>
);

const clientWith = (result: PushSubscriptionsResult) =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listPushSubscriptions) {
                return result;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

describe("notificationsPanel", () => {
    it("lists every device and counts the failing ones", async () => {
        expect.assertions(2);

        render(renderPanel(clientWith({ subscriptions })));

        await screen.findByTestId("nt-failing-filter");

        expect(screen.getByTestId("nt-count").textContent).toBe("3 devices");
        expect(screen.getByTestId("nt-failing-filter").textContent).toBe("1 failing");
    });

    it("narrows to the failing devices when the failing filter is pressed", async () => {
        expect.assertions(2);

        render(renderPanel(clientWith({ subscriptions })));

        fireEvent.click(await screen.findByTestId("nt-failing-filter"));

        await waitFor(() => {
            expect(screen.getByTestId("nt-failing-filter").getAttribute("aria-pressed")).toBe("true");
        });

        expect(screen.queryByTestId("nt-status-wp-ok")).toBeNull();
    });

    it("says no device matches when a search finds none, not that the registry is empty", async () => {
        expect.assertions(1);

        render(renderPanel(clientWith({ subscriptions })));

        fireEvent.change(await screen.findByTestId("nt-search"), { target: { value: "nobody-by-this-name" } });

        await expect(screen.findByText("No matching devices.")).resolves.toBe(true);
    });

    it("shows the registration guidance for an empty registry", async () => {
        expect.assertions(1);

        render(renderPanel(clientWith({ subscriptions: [] })));

        await expect(screen.findByText("No registered devices.")).resolves.toBe(true);
    });
});
