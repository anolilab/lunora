import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { CirrusProvider, useCirrus } from "../src/cirrus-provider.js";
import { createMockClient } from "./mock-client.js";

const Probe = (): ReactElement => {
    const client = useCirrus();

    return <div data-testid="probe">{typeof client.subscribe === "function" ? "ok" : "missing"}</div>;
};

describe("cirrusProvider", () => {
    it("useCirrus returns the provided client", () => {
        expect.assertions(1);

        const mock = createMockClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <Probe />
            </CirrusProvider>,
        );

        expect(screen.getByTestId("probe").textContent).toBe("ok");
    });

    it("useCirrus throws when used outside the provider", () => {
        expect.assertions(1);

        // Suppress React's error logging for this test.
        const { error } = console;

        console.error = (): void => undefined;

        try {
            expect(() => render(<Probe />)).toThrow(/CirrusProvider/);
        } finally {
            console.error = error;
        }
    });
});
