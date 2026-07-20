"use client";

import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * The shared shell for a React Flow custom node — a bordered, rounded card that
 * matches the studio's `card` surface tokens. The schema diagram's table node
 * (`database-schema-node`) builds on this so every node reads like the rest of
 * the studio chrome instead of React Flow's default box.
 */
function BaseNode({ className, selected, ...props }: React.ComponentProps<"div"> & { selected?: boolean }): React.ReactElement {
    return (
        <div
            data-slot="base-node"
            data-selected={selected === true ? "" : undefined}
            className={cn(
                "rounded-md border border-border bg-card text-card-foreground shadow-sm transition-colors",
                "data-[selected]:border-ring data-[selected]:ring-[3px] data-[selected]:ring-ring/30",
                className,
            )}
            {...props}
        />
    );
}

/** The node's title bar — table name plus any badges. */
function BaseNodeHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div data-slot="base-node-header" className={cn("flex items-center gap-2 rounded-t-md bg-muted/50 px-3 py-1.5", className)} {...props} />;
}

/** The node's body — the list of columns. */
function BaseNodeContent({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div data-slot="base-node-content" className={cn("flex flex-col", className)} {...props} />;
}

export { BaseNode, BaseNodeContent, BaseNodeHeader };
