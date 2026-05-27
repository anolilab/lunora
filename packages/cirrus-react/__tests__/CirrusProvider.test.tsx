import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";

import { CirrusProvider, useCirrus } from "../src/CirrusProvider.js";
import { createMockClient } from "./mockClient.js";

const Probe = (): ReactElement => {
    const client = useCirrus();

    return <div data-testid="probe">{typeof client.subscribe === "function" ? "ok" : "missing"}</div>;
};

describe("CirrusProvider", () => {
    test("useCirrus returns the provided client", () => {
        const mock = createMockClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <Probe />
            </CirrusProvider>,
        );

        expect(screen.getByTestId("probe").textContent).toBe("ok");
    });

    test("useCirrus throws when used outside the provider", () => {
        // Suppress React's error logging for this test.
        const error = console.error;

        console.error = (): void => undefined;

        try {
            expect(() => render(<Probe />)).toThrow(/CirrusProvider/);
        } finally {
            console.error = error;
        }
    });
});
