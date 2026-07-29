/**
 * Solid port: the pieces that live outside a card. The toast store itself is
 * covered framework-agnostically in `__tests__/core`; this asserts what only the
 * Solid binding can get wrong — the subscription that turns a pushed toast into
 * rendered markup, and the dismiss button that removes it again.
 */
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { pushToast, resetToasts } from "../../src/core/toast";
import { ErrorToaster } from "../../src/solid";

afterEach(() => {
    // The store is module-level, so a leftover toast would leak into every
    // suite that renders after this one.
    resetToasts();
});

describe("solid ErrorToaster", () => {
    it("renders nothing until a toast is pushed", () => {
        expect.assertions(2);

        const { container } = render(() => <ErrorToaster />);

        expect(container.querySelector(".lunora-auth-toaster")).toBeNull();

        pushToast("Could not sign in with GitHub.");

        expect(screen.getByRole("status")).toHaveTextContent("Could not sign in with GitHub.");
    });

    it("removes the toast when its dismiss button is pressed", () => {
        expect.assertions(2);

        render(() => <ErrorToaster />);
        pushToast("Could not sign out.");

        expect(screen.getByText("Could not sign out.")).toBeDefined();

        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

        expect(screen.queryByText("Could not sign out.")).toBeNull();
    });
});
