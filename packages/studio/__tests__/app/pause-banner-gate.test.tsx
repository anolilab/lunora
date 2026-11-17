import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Studio } from "../../src/app/studio";
import { createMockClient } from "../mock-client";

describe("deployment pause banner in a bare studio", () => {
    it("shows while paused when the client is injected without app chrome", async () => {
        expect.hasAssertions();

        const mock = createMockClient({ pause: { paused: true, supported: true } });

        render(
            <LunoraProvider client={mock.asClient}>
                <Studio />
            </LunoraProvider>,
        );

        await expect(screen.findByTestId("deployment-paused-banner", undefined, { timeout: 5000 })).resolves.toBeDefined();
    });
});
