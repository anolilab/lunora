import type { ReactElement } from "react";

import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { useT } from "../../i18n/i18n-context";
import { CLOUDFLARE_OBSERVABILITY_URL } from "../../lib/cf-links";
import { cn } from "../../lib/utils";

/**
 * The panel's top bar: which log view is showing, the shard it targets, and
 * the live-subscription error when one is up.
 *
 * Its own component because it is the only part of the panel that is the same
 * in all three views — the filter bars below it swap per view, this does not.
 */
/** Which of the three log views is showing. Owned by the bar that switches them. */
type LogsView = "archive" | "errors" | "requests";

const LogsViewBar = ({
    liveError,
    onShardKeyChange,
    onShowArchive,
    onShowErrors,
    onShowRequests,
    shardKey,
    view,
}: {
    /** Message from the live channel, shown inline rather than replacing the view. */
    readonly liveError: string | undefined;
    readonly onShardKeyChange: (value: string) => void;
    readonly onShowArchive: () => void;
    readonly onShowErrors: () => void;
    readonly onShowRequests: () => void;
    readonly shardKey: string;
    readonly view: LogsView;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-lg border border-border" role="tablist">
                <button
                    aria-selected={view === "requests"}
                    className={cn("px-3 py-1 text-sm", view === "requests" ? "bg-muted font-medium" : "text-muted-foreground")}
                    data-testid="lg-view-requests"
                    onClick={onShowRequests}
                    role="tab"
                    type="button"
                >
                    {t("Requests")}
                </button>
                <button
                    aria-selected={view === "errors"}
                    className={cn("px-3 py-1 text-sm", view === "errors" ? "bg-muted font-medium" : "text-muted-foreground")}
                    data-testid="lg-view-errors"
                    onClick={onShowErrors}
                    role="tab"
                    type="button"
                >
                    {t("Errors")}
                </button>
                <button
                    aria-selected={view === "archive"}
                    className={cn("px-3 py-1 text-sm", view === "archive" ? "bg-muted font-medium" : "text-muted-foreground")}
                    data-testid="lg-view-archive"
                    onClick={onShowArchive}
                    role="tab"
                    type="button"
                >
                    {t("Archive")}
                </button>
            </div>
            <ShardInput onChange={onShardKeyChange} testId="lg-shard-input" value={shardKey} />
            {/* The Archive feed is HTTP-only (no WS), so it never has a live-connection
                            status — don't leak the (disabled) Errors feed's `liveError` into it. */}
            {view !== "archive" && <LiveError message={liveError} prefix="lg" />}
            <a
                className="text-sm text-primary underline-offset-4 hover:underline"
                data-testid="lg-cf-link"
                href={CLOUDFLARE_OBSERVABILITY_URL}
                rel="noreferrer"
                target="_blank"
            >
                {t("Open in Cloudflare")}
            </a>
        </div>
    );
};

export { LogsViewBar };
export type { LogsView };
