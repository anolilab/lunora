import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider, useLunora } from "../src/lunora-provider";
import { createMockClient } from "./mock-client";

const Probe = (): ReactElement => {
    const client = useLunora();

    return <div data-testid="probe">{typeof client.subscribe === "function" ? "ok" : "missing"}</div>;
};

describe("lunoraProvider", () => {
    it("useLunora returns the provided client", () => {
        expect.assertions(1);

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <Probe />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("probe").textContent).toBe("ok");
    });

    it("useLunora throws when used outside the provider", () => {
        expect.assertions(1);

        // Suppress React's error logging for this test.
        const { error } = console;

        // eslint-disable-next-line no-console -- intentionally muting React's noisy error logging while asserting the provider-missing throw.
        console.error = (): void => undefined;

        try {
            expect(() => render(<Probe />)).toThrow(/LunoraProvider/);
        } finally {
            // eslint-disable-next-line no-console -- restoring the original console.error captured above.
            console.error = error;
        }
    });
});
