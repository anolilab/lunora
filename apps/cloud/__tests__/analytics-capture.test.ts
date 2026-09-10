import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureServerEvent } from "../src/analytics/capture";

/**
 * The server-side capture's contract is mostly about what it must NOT do.
 *
 * It runs beside deploys, provisioning and the billing sweeps, so the failure
 * modes that matter are "took the deploy down with it" and "shipped a tenant's
 * data to a third party" — not "missed an event". These pin both, plus the
 * inertness that lets a cell run with no PostHog project at all.
 */

const ORG = "org_1";

describe(captureServerEvent, () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
        vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("sends nothing at all when no project token is configured", async () => {
        expect.assertions(1);

        await captureServerEvent({}, "cloud_deployment_finished", { organizationId: ORG });

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("treats an empty token as unconfigured rather than authenticating with it", async () => {
        expect.assertions(1);

        await captureServerEvent({ POSTHOG_PROJECT_TOKEN: "" }, "cloud_deployment_finished", { organizationId: ORG });

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("keys the event on the organization, not on a person", async () => {
        expect.assertions(3);

        await captureServerEvent({ POSTHOG_PROJECT_TOKEN: "phc_1" }, "cloud_deployment_finished", { cell: "eu-1", organizationId: ORG }, { status: "live" });

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { distinct_id: string; event: string; properties: Record<string, unknown> };

        expect(body.distinct_id).toBe(ORG);
        expect(body.event).toBe("cloud_deployment_finished");
        expect(body.properties).toMatchObject({ cell: "eu-1", organizationId: ORG, status: "live" });
    });

    it.each([
        ["a bare origin", "https://ph.example", "https://ph.example/i/v0/e/"],
        ["a trailing slash", "https://ph.example/", "https://ph.example/i/v0/e/"],
        // A first-party proxy is a supported shape, and an absolute request path
        // would silently drop the prefix — sending every event to the wrong place
        // while looking configured.
        ["a path-carrying proxy host", "https://cloud.example/ph", "https://cloud.example/ph/i/v0/e/"],
    ])("posts to %s correctly", async (_label, host, expected) => {
        expect.assertions(1);

        await captureServerEvent({ POSTHOG_HOST: host, POSTHOG_PROJECT_TOKEN: "phc_1" }, "e", { organizationId: ORG });

        expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(expected);
    });

    it("swallows a rejected send — a telemetry outage must not fail the deploy that triggered it", async () => {
        expect.assertions(1);

        fetchSpy.mockRejectedValue(new Error("posthog unreachable"));

        await expect(captureServerEvent({ POSTHOG_PROJECT_TOKEN: "phc_1" }, "e", { organizationId: ORG })).resolves.toBeUndefined();
    });
});
