import { useConnectionStatus } from "@cirrus/react";
import type { ReactElement } from "react";

import { useT } from "./i18n-context";
import { cn } from "./lib/utils";

/**
 * Dot colour per connection status. Tailwind palette classes (not raw hex or
 * theme tokens) so the dot reads correctly in both light and dark mode while
 * still mapping each status to a distinct, conventional hue; the label below
 * carries the same information for non-colour cues.
 */
const STATUS_DOT = {
    connected: "bg-emerald-500",
    connecting: "bg-amber-500",
    idle: "bg-zinc-400 dark:bg-zinc-500",
    offline: "bg-red-500",
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

    return (
        <span
            aria-live="polite"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            data-status={status}
            data-testid="dash-connection"
            role="status"
        >
            <span aria-hidden="true" className={cn("size-2 rounded-full", STATUS_DOT[status])} />
            {text}
        </span>
    );
};

export default ConnectionBadge;
