import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
    readonly children: ReactNode;
    /** Optional label naming the boundary's region, shown in the fallback. */
    readonly label?: string;
}

interface ErrorBoundaryState {
    readonly error: Error | null;
}

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

    public componentDidCatch(error: Error, info: ErrorInfo): void {
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
            <div data-testid="dash-error-boundary" role="alert" style={{ border: "1px solid #cf222e", borderRadius: 6, padding: 12 }}>
                <strong>{this.props.label === undefined ? "Something went wrong" : `${this.props.label} failed`}</strong>
                <pre data-testid="dash-error-message" style={{ overflow: "auto", whiteSpace: "pre-wrap" }}>
                    {error.message}
                </pre>
                <button data-testid="dash-error-retry" onClick={this.reset} type="button">
                    Try again
                </button>
            </div>
        );
    }
}
