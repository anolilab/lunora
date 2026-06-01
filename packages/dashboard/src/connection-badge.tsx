import { useConnectionStatus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useMemo } from "react";

/** Human-readable label + dot colour per connection status. */
const LABELS = {
    connected: { color: "#1a7f37", text: "Connected" },
    connecting: { color: "#9a6700", text: "Connecting…" },
    idle: { color: "#6e7781", text: "Idle" },
    offline: { color: "#cf222e", text: "Offline" },
} as const;

/** Static wrapper styles, hoisted so they keep a stable reference across renders. */
const WRAPPER_STYLE = { alignItems: "center", display: "inline-flex", gap: 6 } as const;
/** Dot styles minus the status-dependent colour, hoisted; colour is merged in via `useMemo`. */
const DOT_BASE_STYLE = { borderRadius: "50%", display: "inline-block", height: 8, width: 8 } as const;

/**
 * Live-socket status indicator. Reflects the client's aggregate WebSocket health
 * so an operator can tell a healthy live channel from a silently-dropped socket
 * (a panel showing "Live: on" while the socket is down would otherwise look
 * identical to one that's simply idle).
 */
export function ConnectionBadge(): ReactElement {
    const status = useConnectionStatus();
    const { color, text } = LABELS[status];
    const dotStyle = useMemo(() => { return { ...DOT_BASE_STYLE, backgroundColor: color }; }, [color]);

    return (
        <span aria-live="polite" data-status={status} data-testid="dash-connection" role="status" style={WRAPPER_STYLE}>
            <span aria-hidden="true" style={dotStyle} />
            {text}
        </span>
    );
}
