import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ErrorBoundary } from "../src/error-boundary.js";

const Boom = (): ReactElement => {
    throw new Error("kaboom");
};

// A child whose throwing is controlled by a module-level flag, so a retry can
// be made to succeed by flipping the flag before re-render.
let shouldThrow = true;

function Toggle(): ReactElement {
    if (shouldThrow) {
        throw new Error("toggle boom");
    }

    return <p data-testid="recovered-ok">ok</p>;
}

describe("errorBoundary", () => {
    beforeEach(() => {
        shouldThrow = true;
        // The boundary logs caught errors; silence the expected noise.
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test("renders children when they don't throw", () => {
        expect.assertions(1);

        render(
            <ErrorBoundary>
                <p data-testid="ok">fine</p>
            </ErrorBoundary>,
        );

        expect(screen.getByTestId("ok")).toBeDefined();
    });

    test("catches a throwing child and shows the message with the label", () => {
        expect.assertions(2);

        render(
            <ErrorBoundary label="Metrics">
                <Boom />
            </ErrorBoundary>,
        );

        expect(screen.getByTestId("dash-error-boundary").textContent).toContain("Metrics failed");
        expect(screen.getByTestId("dash-error-message").textContent).toContain("kaboom");
    });

    test("Try again clears the boundary and re-renders recovered children", () => {
        expect.assertions(2);

        render(
            <ErrorBoundary>
                <Toggle />
            </ErrorBoundary>,
        );

        expect(screen.getByTestId("dash-error-boundary")).toBeDefined();

        // Flip the shared flag so the next render succeeds, then retry.
        shouldThrow = false;
        fireEvent.click(screen.getByTestId("dash-error-retry"));

        expect(screen.getByTestId("recovered-ok")).toBeDefined();
    });
});
