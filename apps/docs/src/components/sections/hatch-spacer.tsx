import type { FC } from "react";

/**
 * Full-width hatched divider band used between sections — a thin top border
 * over a 135° repeating-line texture on the charcoal background.
 *
 * The band is bounded by one hairline, not two. `Section` draws its own
 * `border-t`, which is the separation when bands butt up against each other —
 * but directly under a spacer it lands 64px below this one and the divider
 * reads as a boxed strip. The sibling selector drops it, so the section that
 * follows a spacer needs no say in the matter.
 */
const HatchSpacer: FC = () => (
    <div
        aria-hidden="true"
        className="h-16 w-full border-t border-hairline bg-canvas [&+section]:border-t-0"
        style={{ backgroundImage: "repeating-linear-gradient(135deg, rgba(46,48,56,0.45) 0 1px, rgba(0,0,0,0) 1px 8px)" }}
    />
);

export default HatchSpacer;
