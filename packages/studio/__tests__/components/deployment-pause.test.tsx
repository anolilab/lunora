import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeploymentPauseBanner, DeploymentPauseToggle } from "../../src/components/deployment-pause";
import { createMockClient } from "../mock-client";

describe("deployment pause", () => {
    it("pauses from the toggle with a reason, shows the banner on every page, and resumes from it", async () => {
        expect.hasAssertions();

        const mock = createMockClient({ pause: { paused: false, supported: true } });

        render(
            <LunoraProvider client={mock.asClient}>
                <DeploymentPauseBanner />
                <DeploymentPauseToggle />
            </LunoraProvider>,
        );

        await screen.findByTestId("deployment-pause-toggle");

        expect(screen.queryByTestId("deployment-paused-banner")).toBeNull();

        fireEvent.change(screen.getByTestId("deployment-pause-reason"), { target: { value: "incident 42" } });
        fireEvent.click(screen.getByTestId("deployment-toggle-pause"));
        fireEvent.click(screen.getByTestId("deployment-toggle-pause-confirm"));

        await screen.findByTestId("deployment-paused-banner");

        expect(mock.setDeploymentPause).toHaveBeenCalledWith(true, "incident 42");
        expect(screen.getByTestId("deployment-paused-reason").textContent).toBe("incident 42");
        expect(screen.getByTestId("deployment-pause-state").textContent).toBe("Deployment paused");

        fireEvent.click(screen.getByTestId("deployment-resume"));
        fireEvent.click(screen.getByTestId("deployment-resume-confirm"));

        await waitFor(() => {
            expect(screen.queryByTestId("deployment-paused-banner")).toBeNull();
        });

        expect(mock.setDeploymentPause).toHaveBeenLastCalledWith(false);
    });

    it("hides the toggle on a worker that cannot pause", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <DeploymentPauseToggle />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.getDeploymentPause).toHaveBeenCalledWith();
        });

        expect(screen.queryByTestId("deployment-pause-toggle")).toBeNull();
    });

    it("keeps showing the banner when a later status read fails", async () => {
        expect.hasAssertions();

        const mock = createMockClient({ pause: { paused: true, pausedAt: 1, supported: true } });

        render(
            <LunoraProvider client={mock.asClient}>
                <DeploymentPauseBanner />
            </LunoraProvider>,
        );

        await screen.findByTestId("deployment-paused-banner");

        mock.getDeploymentPause.mockRejectedValue(new Error("network down"));
        // Resume answers but the read after it fails: the last known state stands.
        mock.setDeploymentPause.mockResolvedValue({ paused: false, supported: true });
        fireEvent.click(screen.getByTestId("deployment-resume"));
        fireEvent.click(screen.getByTestId("deployment-resume-confirm"));

        await waitFor(() => {
            expect(mock.getDeploymentPause).toHaveBeenCalledTimes(2);
        });

        expect(screen.getByTestId("deployment-paused-banner")).toBeDefined();
    });

    it("reads an older worker's 404 as unable to pause", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.getDeploymentPause.mockRejectedValue(new Error("LunoraClient: response was not JSON (status 404 Not Found)"));

        render(
            <LunoraProvider client={mock.asClient}>
                <DeploymentPauseToggle />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.getDeploymentPause).toHaveBeenCalledWith();
        });

        expect(screen.queryByTestId("deployment-pause-toggle")).toBeNull();
    });
});
