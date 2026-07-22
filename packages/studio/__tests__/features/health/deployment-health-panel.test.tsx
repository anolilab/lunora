import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { DeploymentHealthProbe, ProbeSnapshot } from "../../../src/features/health/deployment-health-panel";
import { DeploymentHealthPanel } from "../../../src/features/health/deployment-health-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/** A secret we plant on the client to prove the panel never renders it. */
const ADMIN_SECRET = "super-secret-admin-token-value"; // gitleaks:allow -- test fixture, not a real secret

/** Build a probe that answers `live` and `ready` with the given snapshots. */
const probeWith =
    (live: ProbeSnapshot, ready: ProbeSnapshot): DeploymentHealthProbe =>
    (kind) =>
        Promise.resolve(kind === "ready" ? ready : live);

const renderPanel = (mock: MockClientHooks, probe: DeploymentHealthProbe): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <DeploymentHealthPanel probe={probe} />
    </LunoraProvider>
);

const clientWithToken = (): MockClientHooks => {
    const mock = createMockClient();

    Object.assign(mock.asClient, { getAuthToken: () => ADMIN_SECRET, url: "https://app.example.com" });

    return mock;
};

describe("deploymentHealthPanel", () => {
    it("renders a green, healthy verdict when every critical check is up", async () => {
        expect.assertions(4);

        const live: ProbeSnapshot = {
            body: {
                appName: "chat",
                appVersion: "1.2.3",
                checks: [
                    { critical: true, name: "durable-object", status: "up" },
                    { critical: true, name: "d1", status: "up" },
                ],
                status: "healthy",
                timestamp: "2026-07-22T10:00:00.000Z",
            },
            ok: true,
            status: 200,
        };
        const ready: ProbeSnapshot = { body: null, ok: true, status: 200 };

        render(renderPanel(clientWithToken(), probeWith(live, ready)));

        const status = await screen.findByTestId("dh-status");

        expect(status.textContent).toBe("Healthy");
        expect(screen.getByTestId("dh-readiness").textContent).toBe("Ready");
        // Every check reads "Up" — no down/destructive status in a fully-healthy body.
        expect(screen.getByTestId("dh-check-status-d1").textContent).toBe("Up");
        expect(screen.getByTestId("dh-check-status-durable-object").textContent).toBe("Up");
    });

    it("renders a red, unhealthy verdict when a critical dependency is down", async () => {
        expect.assertions(3);

        const live: ProbeSnapshot = {
            body: {
                appName: "chat",
                appVersion: "1.2.3",
                checks: [
                    { critical: true, message: "d1 query failed", name: "d1", status: "down" },
                    { critical: false, name: "r2", status: "up" },
                ],
                status: "unhealthy",
                timestamp: "2026-07-22T10:00:00.000Z",
            },
            ok: false,
            status: 503,
        };
        const ready: ProbeSnapshot = { body: null, ok: false, status: 503 };

        render(renderPanel(clientWithToken(), probeWith(live, ready)));

        const status = await screen.findByTestId("dh-status");

        expect(status.textContent).toBe("Unhealthy");
        expect(screen.getByTestId("dh-readiness").textContent).toBe("Not ready");
        expect(screen.getByTestId("dh-check-status-d1").textContent).toBe("Down");
    });

    it("never renders the admin bearer token that authorizes the probe", async () => {
        expect.assertions(2);

        const live: ProbeSnapshot = {
            body: {
                appName: "chat",
                appVersion: "1.2.3",
                checks: [{ critical: true, message: "durable object unreachable", name: "durable-object", status: "up" }],
                status: "healthy",
                timestamp: "2026-07-22T10:00:00.000Z",
            },
            ok: true,
            status: 200,
        };

        render(renderPanel(clientWithToken(), probeWith(live, { body: null, ok: true, status: 200 })));

        const panel = await screen.findByTestId("deployment-health");

        // Only whitelisted body fields render — the admin token is never on screen.
        expect(panel.textContent).not.toContain(ADMIN_SECRET);
        // The runtime-authored message (admin posture) is fine to show.
        expect(panel.textContent).toContain("durable object unreachable");
    });

    it("shows the admin-posture empty state when the endpoint answers 403 with no body", async () => {
        expect.assertions(1);

        const gated: ProbeSnapshot = { body: null, error: "forbidden", ok: false, status: 403 };

        render(renderPanel(clientWithToken(), probeWith(gated, gated)));

        await expect(screen.findByTestId("deployment-health-error")).resolves.toBeDefined();
    });
});
