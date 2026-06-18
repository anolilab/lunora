import type { FC } from "react";

/**
 * Full-width hatched divider band used between sections — a thin top border
 * over a 135° repeating-line texture on the charcoal background.
 */
const HatchSpacer: FC = () => (
    <div
        aria-hidden="true"
        className="h-16 w-full border-t border-white/[0.08] bg-[#0e0e11]"
        style={{ backgroundImage: "repeating-linear-gradient(135deg, rgba(46,48,56,0.45) 0 1px, rgba(0,0,0,0) 1px 8px)" }}
    />
);

export default HatchSpacer;
