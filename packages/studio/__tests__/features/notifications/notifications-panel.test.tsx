import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import NotificationsPanel from "../../../src/features/notifications/notifications-panel";
import type { PushSubscriptionDevice } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const DEVICES: PushSubscriptionDevice[] = [
    { createdAt: 1, endpoint: "https://push.example/ep-web", id: "web:1", kind: "web-push", lastSeenAt: 2, lastStatus: "ok", userId: "user-1" },
    { createdAt: 3, id: "fcm:1", kind: "fcm", lastError: "UNREGISTERED", lastSeenAt: 4, lastStatus: "failed", userId: "user-2" },
];

const createClient = (subscriptions: PushSubscriptionDevice[] = DEVICES): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listPushSubscriptions) {
                return { subscriptions };
            }

            return undefined;
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <NotificationsPanel />
    </LunoraProvider>
);

describe("notificationsPanel", () => {
    it("renders the fetched registered devices with their endpoint and last-send status", async () => {
        expect.assertions(4);

        render(renderPanel(createClient()));

        const rows = await screen.findAllByTestId("nt-row");

        expect(rows).toHaveLength(2);
        expect(screen.getByText("https://push.example/ep-web").textContent).toBe("https://push.example/ep-web");
        // The delivery-error column surfaces the FCM failure reason…
        expect(screen.getByText("UNREGISTERED").textContent).toBe("UNREGISTERED");
        // …and the per-device status badge reflects each device's last outcome.
        expect(screen.getByTestId("nt-status-fcm:1").textContent).toBe("failed");
    });

    it("filters devices by kind client-side", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        await screen.findAllByTestId("nt-row");
        fireEvent.click(screen.getByTestId("nt-kind-fcm"));

        expect(screen.getAllByTestId("nt-row")).toHaveLength(1);
    });

    it("shows the empty state when no devices are registered", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([])));

        const empty = await screen.findByTestId("nt-empty");

        expect(empty.dataset["testid"]).toBe("nt-empty");
    });
});
