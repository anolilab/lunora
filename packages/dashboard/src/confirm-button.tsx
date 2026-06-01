import type { ReactElement } from "react";
import { useState } from "react";

export interface ConfirmButtonProps {
    /** Label for the initial trigger (e.g. `Delete`). */
    readonly children: string;
    /** Label for the confirm step; defaults to `Confirm`. */
    readonly confirmLabel?: string;
    /** Disable the trigger (e.g. while a write is in flight). */
    readonly disabled?: boolean;
    /** Action run only after the operator confirms. */
    readonly onConfirm: () => void;
    /** `data-testid` for the initial trigger; the confirm/cancel steps derive `${testId}-confirm` / `${testId}-cancel`. */
    readonly testId: string;
}

/**
 * A destructive-action button that requires a second click to fire. The first
 * click swaps the trigger for an inline `Confirm` / `Cancel` pair rather than a
 * blocking `window.confirm`, so the guard is testable and non-modal. The
 * trigger keeps its `testId` (so existing tests that click it still reach the
 * first step); the actual action only runs on the `${testId}-confirm` click.
 */
export function ConfirmButton({ children, confirmLabel = "Confirm", disabled = false, onConfirm, testId }: ConfirmButtonProps): ReactElement {
    const [confirming, setConfirming] = useState(false);

    if (!confirming) {
        return (
            <button
                data-testid={testId}
                disabled={disabled}
                onClick={() => {
                    setConfirming(true);
                }}
                type="button"
            >
                {children}
            </button>
        );
    }

    return (
        <span data-testid={`${testId}-prompt`} role="group">
            <button
                data-testid={`${testId}-confirm`}
                disabled={disabled}
                onClick={() => {
                    setConfirming(false);
                    onConfirm();
                }}
                type="button"
            >
                {confirmLabel}
            </button>
            <button
                data-testid={`${testId}-cancel`}
                onClick={() => {
                    setConfirming(false);
                }}
                type="button"
            >
                Cancel
            </button>
        </span>
    );
}
