import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * shadcn/ui Avatar on `@base-ui`, matching the primitive stack the rest of this
 * directory uses (copied from `packages/studio`). Written here rather than taken
 * from `apps/docs`, whose avatar-adjacent components sit on Radix + lucide — mixing
 * the two would pull a second primitive library and a second icon set into the app
 * for one component.
 */
function Avatar({ className, ...props }: AvatarPrimitive.Root.Props): React.ReactElement {
    return <AvatarPrimitive.Root className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full", className)} data-slot="avatar" {...props} />;
}

function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props): React.ReactElement {
    return <AvatarPrimitive.Image className={cn("aspect-square size-full", className)} data-slot="avatar-image" {...props} />;
}

function AvatarFallback({ className, ...props }: AvatarPrimitive.Fallback.Props): React.ReactElement {
    return (
        <AvatarPrimitive.Fallback
            className={cn("bg-muted flex size-full items-center justify-center rounded-full", className)}
            data-slot="avatar-fallback"
            {...props}
        />
    );
}

export { Avatar, AvatarFallback, AvatarImage };
