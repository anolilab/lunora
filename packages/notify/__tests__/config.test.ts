import { describe, expect, it } from "vitest";

import { fcmFromEnv, webPushFromEnv } from "../src/config";

describe("webPushFromEnv", () => {
    it("resolves a config when all three VAPID vars are present", () => {
        expect.hasAssertions();

        const config = webPushFromEnv({ VAPID_PRIVATE_KEY: "priv", VAPID_PUBLIC_KEY: "pub", VAPID_SUBJECT: "mailto:a@b.c" });

        expect(config).toStrictEqual({ vapidPrivateKey: "priv", vapidPublicKey: "pub", vapidSubject: "mailto:a@b.c" });
    });

    it("returns undefined when any VAPID var is missing or empty", () => {
        expect.hasAssertions();

        expect(webPushFromEnv({ VAPID_PRIVATE_KEY: "priv", VAPID_PUBLIC_KEY: "pub" })).toBeUndefined();
        expect(webPushFromEnv({ VAPID_PRIVATE_KEY: "", VAPID_PUBLIC_KEY: "pub", VAPID_SUBJECT: "s" })).toBeUndefined();
        expect(webPushFromEnv({})).toBeUndefined();
    });

    it("merges overrides (ttl/urgency)", () => {
        expect.hasAssertions();

        const config = webPushFromEnv({ VAPID_PRIVATE_KEY: "priv", VAPID_PUBLIC_KEY: "pub", VAPID_SUBJECT: "s" }, { urgency: "high" });

        expect(config?.urgency).toBe("high");
    });
});

describe("fcmFromEnv", () => {
    it("resolves a config from projectId + access token", () => {
        expect.hasAssertions();

        const config = fcmFromEnv({ FCM_ACCESS_TOKEN: "tok", FCM_PROJECT_ID: "proj" });

        expect(config).toStrictEqual({ accessToken: "tok", projectId: "proj" });
    });

    it("returns undefined without a project id", () => {
        expect.hasAssertions();

        expect(fcmFromEnv({ FCM_ACCESS_TOKEN: "tok" })).toBeUndefined();
    });

    it("keeps accessToken undefined when only projectId is set (getAccessToken supplied elsewhere)", () => {
        expect.hasAssertions();

        const config = fcmFromEnv({ FCM_PROJECT_ID: "proj" });

        expect(config?.projectId).toBe("proj");
        expect(config?.accessToken).toBeUndefined();
    });
});
