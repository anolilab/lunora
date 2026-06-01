import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

interface ErrorBoundaryProps {
    readonly children: ReactNode;
    /** Optional label naming the boundary's region, shown in the fallback. */
    readonly label?: string;
}

interface ErrorBoundaryState {
    readonly error: Error | null;
}

/** Static inline styles, hoisted so they keep a stable reference across renders. */
const CONTAINER_STYLE = { border: "1px solid #cf222e", borderRadius: 6, padding: 12 } as const;
const MESSAGE_STYLE = { overflow: "auto", whiteSpace: "pre-wrap" } as const;

/**
 * Catches render/lifecycle errors in a panel so one throwing component doesn't
 * blank the whole dashboard shell. Shows the error message with a "Try again"
 * button that clears the boundary and re-renders its children.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    public constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { error: null };
    }

    public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    public override componentDidCatch(error: Error, info: ErrorInfo): void {
        // Surface to the console so the stack isn't lost; the UI shows the message.
        console.error("[cirrus-dashboard] panel error", error, info.componentStack);
    }

    private readonly reset = (): void => {
        this.setState({ error: null });
    };

    public override render(): ReactNode {
        const { error } = this.state;

        if (error === null) {
            return this.props.children;
        }

        return (
            <div data-testid="dash-error-boundary" role="alert" style={CONTAINER_STYLE}>
                <strong>{this.props.label === undefined ? "Something went wrong" : `${this.props.label} failed`}</strong>
                <pre data-testid="dash-error-message" style={MESSAGE_STYLE}>
                    {error.message}
                </pre>
                <button data-testid="dash-error-retry" onClick={this.reset} type="button">
                    Try again
                </button>
            </div>
        );
    }
}

export type { ErrorBoundaryProps };
