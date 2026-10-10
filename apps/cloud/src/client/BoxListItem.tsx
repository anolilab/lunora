import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

import type { BoxView } from "./boxes";
import { BOX_STATUS } from "./boxes";
import { interactiveRowClassName } from "./section-styles";
import { RelativeTime, StatusDot } from "./section-ui";

interface BoxListItemProps {
    box: BoxView;
    onSelect: () => void;
    selected: boolean;
}

/**
 * One box in the list beside the detail panel: status dot, name, how long since it
 * was last heard from, and the findings that need attention before opening it. Picking
 * it shows its detail. A revoked box keeps its row (its history is the point), dimmed.
 */
export const BoxListItem = ({ box, onSelect, selected }: BoxListItemProps): ReactElement => {
    const status = BOX_STATUS[box.status];

    return (
        <li>
            <button
                aria-controls="box-detail"
                aria-current={selected ? "true" : undefined}
                className={cn(interactiveRowClassName, "gap-2.5", selected && "bg-accent", box.status === "revoked" && "text-muted-foreground")}
                onClick={onSelect}
                type="button"
            >
                <StatusDot tone={status.tone} />
                <span className="min-w-0 flex-1 truncate font-medium">{box.name}</span>
                {box.dnsError ? <span className="font-mono text-[11px] text-destructive">dns error</span> : null}
                {!box.dnsError && box.singleTrust ? <span className="font-mono text-[11px] text-warning">single trust</span> : null}
                {box.outdated ? <span className="font-mono text-[11px] text-warning">outdated</span> : null}
                <span className="max-w-[9rem] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                    <span className="sr-only">{status.label}, last seen </span>
                    {box.lastSeenAt === undefined ? "never" : <RelativeTime at={box.lastSeenAt} />}
                </span>
            </button>
        </li>
    );
};
