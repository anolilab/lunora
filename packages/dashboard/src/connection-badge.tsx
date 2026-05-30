import { useConnectionStatus } from "@cirrus/react";
import type { ReactElement } from "react";

/** Human-readable label + dot colour per connection status. */
const LABELS = {
    connected: { color: "#1a7f37", text: "Connected" },
    connecting: { color: "#9a6700", text: "Connecting…" },
    idle: { color: "#6e7781", text: "Idle" },
    offline: { color: "#cf222e", text: "Offline" },
} as const;

/**
 * Live-socket status indicator. Reflects the client's aggregate WebSocket health
 * so an operator can tell a healthy live channel from a silently-dropped socket
 * (a panel showing "Live: on" while the socket is down would otherwise look
 * identical to one that's simply idle).
 */
export function ConnectionBadge(): ReactElement {
    const status = useConnectionStatus();
    const { color, text } = LABELS[status];

    return (
        <span
            aria-live="polite"
            data-status={status}
            data-testid="dash-connection"
            role="status"
            style={{ alignItems: "center", display: "inline-flex", gap: 6 }}
        >
            <span aria-hidden="true" style={{ backgroundColor: color, borderRadius: "50%", display: "inline-block", height: 8, width: 8 }} />
            {text}
        </span>
    );
}
