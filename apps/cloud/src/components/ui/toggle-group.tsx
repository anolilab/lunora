import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";

import { cn } from "../../lib/utils";

/**
 * A segmented control on `@base-ui`'s toggle group: a recessed track with the pressed
 * segment raised on a tile. Single-select, since base-ui's `multiple` is off by default.
 *
 * Hand-written in the shadcn style rather than added with the CLI, because this app has
 * no `components.json` and both primitives already ship in the installed `@base-ui/react`.
 */
function ToggleGroup<Value extends string>({ className, ...props }: ToggleGroupPrimitive.Props<Value>): React.ReactElement {
    return (
        <ToggleGroupPrimitive
            data-slot="toggle-group"
            className={cn("inline-flex h-9 w-fit items-center gap-0.5 rounded-xl border border-border bg-card p-1 shadow-card", className)}
            {...props}
        />
    );
}

function ToggleGroupItem<Value extends string>({ className, ...props }: TogglePrimitive.Props<Value>): React.ReactElement {
    return (
        <TogglePrimitive
            data-slot="toggle-group-item"
            className={cn(
                "inline-flex h-full min-w-10 items-center justify-center rounded-lg px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-accent data-pressed:text-foreground data-pressed:shadow-[inset_0_0_0_1px_var(--border)]",
                className,
            )}
            {...props}
        />
    );
}

export { ToggleGroup, ToggleGroupItem };
