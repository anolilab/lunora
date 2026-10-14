"use client";

import * as React from "react";

import { cn } from "../../lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">): React.ReactElement {
    return (
        <div data-slot="table-container" className="relative w-full overflow-x-auto overflow-y-clip">
            <table data-slot="table" className={cn("w-full caption-bottom text-xs", className)} {...props} />
        </div>
    );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">): React.ReactElement {
    return <thead data-slot="table-header" className={cn("bg-muted/50 [&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">): React.ReactElement {
    return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.ReactElement {
    return (
        <tr
            data-slot="table-row"
            className={cn("border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted", className)}
            {...props}
        />
    );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">): React.ReactElement {
    return (
        <th
            data-slot="table-head"
            className={cn(
                "h-9 border-e border-border px-3 text-start align-middle font-mono text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase last:border-e-0 [&:has([role=checkbox])]:pe-0",
                className,
            )}
            {...props}
        />
    );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">): React.ReactElement {
    return (
        <td
            data-slot="table-cell"
            className={cn("border-e border-border px-3 py-1.5 align-middle whitespace-nowrap last:border-e-0 [&:has([role=checkbox])]:pe-0", className)}
            {...props}
        />
    );
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
