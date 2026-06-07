import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

interface ErrorBoundaryProps {
    readonly children: ReactNode;

    /**
     * Localised fallback heading. When omitted, falls back to `${label} failed`
     * (or `Something went wrong` with no label). A class component can't use the
     * `useT` hook, so localised text is passed in by its parents.
     */
    readonly fallbackTitle?: string;
    /** Optional label naming the boundary's region, shown in the fallback. */
    readonly label?: string;
    /** Localised label for the retry button; defaults to `Try again`. */
    readonly retryLabel?: string;
}

interface ErrorBoundaryState {
    readonly error: Error | null;
}

/** Static inline styles, hoisted so they keep a stable reference across renders. */
const CONTAINER_STYLE = { border: "1px solid #cf222e", borderRadius: 6, padding: 12 } as const;
const MESSAGE_STYLE = { overflow: "auto", whiteSpace: "pre-wrap" } as const;

/**
 * Catches render/lifecycle errors in a panel so one throwing component doesn't
 * blank the whole studio shell. Shows the error message with a "Try again"
 * button that clears the boundary and re-renders its children.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    public override state: ErrorBoundaryState = { error: null };

    public override componentDidCatch(error: Error, info: ErrorInfo): void {
        // Surface to the console so the stack isn't lost; the UI shows the message.
        // eslint-disable-next-line no-console -- deliberate operator-facing surface so a caught render error keeps its stack
        console.error("[cirrus-studio] panel error", error, info.componentStack);
    }

    public readonly reset = (): void => {
        this.setState({ error: null });
    };

    public override render(): ReactNode {
        const { children, fallbackTitle, label, retryLabel } = this.props;
        const { error } = this.state;

        if (error === null) {
            return <>{children}</>;
        }

        const title = fallbackTitle ?? (label === undefined ? "Something went wrong" : `${label} failed`);

        return (
            <div data-testid="dash-error-boundary" role="alert" style={CONTAINER_STYLE}>
                <strong>{title}</strong>
                <pre data-testid="dash-error-message" style={MESSAGE_STYLE}>
                    {error.message}
                </pre>
                <button data-testid="dash-error-retry" onClick={this.reset} type="button">
                    {retryLabel ?? "Try again"}
                </button>
            </div>
        );
    }
}

export type { ErrorBoundaryProps };
