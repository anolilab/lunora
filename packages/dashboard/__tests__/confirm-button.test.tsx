import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmButton } from "../src/confirm-button.js";

describe("confirmButton", () => {
    it("does not fire onConfirm until the confirm step is clicked", () => {
        expect.assertions(3);

        const onConfirm = vi.fn<() => void>();

        render(
            <ConfirmButton onConfirm={onConfirm} testId="act">
                Delete
            </ConfirmButton>,
        );

        // First click only reveals the confirm/cancel prompt.
        fireEvent.click(screen.getByTestId("act"));

        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.getByTestId("act-confirm")).toBeDefined();

        fireEvent.click(screen.getByTestId("act-confirm"));

        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("cancel dismisses the prompt without firing", () => {
        expect.assertions(2);

        const onConfirm = vi.fn<() => void>();

        render(
            <ConfirmButton onConfirm={onConfirm} testId="act">
                Delete
            </ConfirmButton>,
        );

        fireEvent.click(screen.getByTestId("act"));
        fireEvent.click(screen.getByTestId("act-cancel"));

        expect(onConfirm).not.toHaveBeenCalled();
        // Back to the initial trigger.
        expect(screen.getByTestId("act")).toBeDefined();
    });

    it("disabled blocks both the trigger and the confirm step", () => {
        expect.assertions(2);

        const onConfirm = vi.fn<() => void>();

        render(
            <ConfirmButton disabled onConfirm={onConfirm} testId="act">
                Delete
            </ConfirmButton>,
        );

        const trigger = screen.getByTestId<HTMLButtonElement>("act");

        expect(trigger.disabled).toBe(true);

        fireEvent.click(trigger);

        // A disabled trigger never advances to the confirm step.
        expect(screen.queryByTestId("act-confirm")).toBeNull();
    });
});
