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

describe("fcmFromEnv with a service account", () => {
    const keyFile = JSON.stringify({ client_email: "svc@acme.iam", private_key: "PEM", project_id: "acme" });

    it("mints tokens from the key file and targets its project id", () => {
        expect.hasAssertions();

        const config = fcmFromEnv({ FCM_SERVICE_ACCOUNT: keyFile });

        expect(config?.projectId).toBe("acme");
        expect(config?.accessToken).toBeUndefined();
        expect(config?.getAccessToken).toBeTypeOf("function");
    });

    it("prefers FCM_PROJECT_ID over the key file's project id", () => {
        expect.hasAssertions();

        expect(fcmFromEnv({ FCM_PROJECT_ID: "override", FCM_SERVICE_ACCOUNT: keyFile })?.projectId).toBe("override");
    });

    it("returns undefined when neither the env nor the key file names a project", () => {
        expect.hasAssertions();

        const noProject = JSON.stringify({ client_email: "svc@acme.iam", private_key: "PEM" });

        expect(fcmFromEnv({ FCM_SERVICE_ACCOUNT: noProject })).toBeUndefined();
    });

    it("does not throw on a malformed key, so other channels still build; the token source rejects instead", async () => {
        expect.hasAssertions();

        const config = fcmFromEnv({ FCM_PROJECT_ID: "proj", FCM_SERVICE_ACCOUNT: "{oops" });

        expect(config?.projectId).toBe("proj");
        await expect(config?.getAccessToken?.()).rejects.toThrow("neither valid JSON nor base64-encoded JSON");
    });

    it("returns undefined for a malformed key when no project id can be resolved", () => {
        expect.hasAssertions();

        expect(fcmFromEnv({ FCM_SERVICE_ACCOUNT: "{oops" })).toBeUndefined();
    });

    it("prefers the service account over a static token when both are set", () => {
        expect.hasAssertions();

        const config = fcmFromEnv({ FCM_ACCESS_TOKEN: "dev-only", FCM_SERVICE_ACCOUNT: keyFile });

        expect(config?.accessToken).toBeUndefined();
        expect(config?.getAccessToken).toBeTypeOf("function");
    });
});
