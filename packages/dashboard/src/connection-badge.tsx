import { useConnectionStatus } from "@cirrus/react";
import type { CSSProperties, ReactElement } from "react";
import { useMemo } from "react";

import { useT } from "./i18n-context.js";

/** Dot colour per connection status; the label is localised in the component. */
const STATUS_COLORS = {
    connected: "#3ecf8e",
    connecting: "#f5c451",
    idle: "#8b949e",
    offline: "#f25c5c",
} as const;

/**
 * Live-socket status indicator. Reflects the client's aggregate WebSocket health
 * so an operator can tell a healthy live channel from a silently-dropped socket
 * (a panel showing "Live: on" while the socket is down would otherwise look
 * identical to one that's simply idle).
 */
const ConnectionBadge = (): ReactElement => {
    const t = useT();
    const status = useConnectionStatus();
    const color = STATUS_COLORS[status];

    // Only the active status is translated — no throwaway map of the other three.
    let text: string;

    switch (status) {
        case "connected": {
            text = t("Connected");

            break;
        }
        case "connecting": {
            text = t("Connecting…");

            break;
        }
        case "idle": {
            text = t("Idle");

            break;
        }
        case "offline": {
            text = t("Offline");

            break;
        }
        default: {
            // Exhaustive: every ConnectionStatus is handled above, so adding a new
            // member surfaces here as a compile error instead of silently rendering
            // a wrong label.
            text = status satisfies never;
        }
    }

    const dotStyle = useMemo<CSSProperties>(() => {
        return { backgroundColor: color };
    }, [color]);

    return (
        <span
            aria-live="polite"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            data-status={status}
            data-testid="dash-connection"
            role="status"
        >
            <span aria-hidden="true" className="size-2 rounded-full" style={dotStyle} />
            {text}
        </span>
    );
};

export default ConnectionBadge;
