"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "../../lib/utils";

function Popover({ ...props }: PopoverPrimitive.Root.Props): React.ReactElement {
    return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props): React.ReactElement {
    return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
    align = "end",
    alignOffset = 0,
    className,
    keepMounted = false,
    side = "bottom",
    sideOffset = 6,
    ...props
}: PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & { keepMounted?: boolean }): React.ReactElement {
    return (
        <PopoverPrimitive.Portal keepMounted={keepMounted}>
            <PopoverPrimitive.Positioner align={align} alignOffset={alignOffset} className="isolate z-50 outline-none" side={side} sideOffset={sideOffset}>
                <PopoverPrimitive.Popup
                    className={cn(
                        "z-50 w-72 origin-(--transform-origin) rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
                        className,
                    )}
                    data-slot="popover-content"
                    {...props}
                />
            </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
    );
}

export { Popover, PopoverContent, PopoverTrigger };
