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
});
