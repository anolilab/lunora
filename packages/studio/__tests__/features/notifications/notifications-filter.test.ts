import { describe, expect, it } from "vitest";

import { partitionDevices } from "../../../src/features/notifications/notifications-filter";
import type { PushSubscriptionDevice } from "../../../src/lib/admin";

const device = (overrides: Partial<PushSubscriptionDevice> & Pick<PushSubscriptionDevice, "id" | "kind">): PushSubscriptionDevice => {
    return {
        createdAt: 0,
        lastSeenAt: 0,
        ...overrides,
    };
};

const devices: PushSubscriptionDevice[] = [
    device({ endpoint: "https://push.example/ok", id: "wp-ok", kind: "web-push", lastStatus: "ok", userId: "ada" }),
    device({ endpoint: "https://push.example/bad", id: "wp-bad", kind: "web-push", lastStatus: "failed", userId: "grace" }),
    device({ id: "fcm-bad-token", kind: "fcm", lastStatus: "failed" }),
    device({ id: "fcm-ok-token", kind: "fcm", lastStatus: "ok", userId: "linus" }),
];

describe("partitionDevices", () => {
    it("shows every device, and counts the failing ones, when nothing is filtered", () => {
        expect.hasAssertions();

        const result = partitionDevices(devices, "all", "", false);

        expect(result.filtered).toHaveLength(4);
        expect(result.failing.map((entry) => entry.id)).toStrictEqual(["wp-bad", "fcm-bad-token"]);
    });

    it("scopes to one kind, and the failing count follows that scope", () => {
        expect.hasAssertions();

        const result = partitionDevices(devices, "fcm", "", false);

        expect(result.filtered.map((entry) => entry.id)).toStrictEqual(["fcm-bad-token", "fcm-ok-token"]);
        expect(result.failing.map((entry) => entry.id)).toStrictEqual(["fcm-bad-token"]);
    });

    it("matches the search against the endpoint or id and the owner, case-insensitively", () => {
        expect.hasAssertions();

        expect(partitionDevices(devices, "all", "PUSH.EXAMPLE/BAD", false).filtered.map((entry) => entry.id)).toStrictEqual(["wp-bad"]);
        expect(partitionDevices(devices, "all", "linus", false).filtered.map((entry) => entry.id)).toStrictEqual(["fcm-ok-token"]);
    });

    it("shows only the failing devices in the failing-only view, within the scope", () => {
        expect.hasAssertions();

        const result = partitionDevices(devices, "web-push", "", true);

        expect(result.filtered.map((entry) => entry.id)).toStrictEqual(["wp-bad"]);
        expect(result.failing.map((entry) => entry.id)).toStrictEqual(["wp-bad"]);
    });

    it("returns nothing for a search that matches no device", () => {
        expect.hasAssertions();

        expect(partitionDevices(devices, "all", "nobody", false).filtered).toHaveLength(0);
    });
});
