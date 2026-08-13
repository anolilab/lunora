import type { FC } from "react";

/**
 * Full-width hatched divider band used between sections — a thin top border
 * over a 135° repeating-line texture.
 *
 * The band is bounded on both edges, which is what lets the sections either
 * side sit flush against it: the spacer is the separation, drawn once, rather
 * than each band padding itself away from it.
 *
 * The following `Section` drops its own `border-t` — that border is the
 * separation when two bands butt up directly, but under a spacer it would
 * double this one's lower edge.
 *
 * `tone` exists because the page alternates grounds. A spacer belongs to the
 * band it introduces, so it takes that band's tone and the colour change
 * happens on its own top edge — one clean line rather than a mismatched strip
 * between two bands. Both the ruling and the ground come from tokens; the
 * ruling used to be a fixed dark grey and disappeared entirely on a light
 * ground, leaving an unexplained 64px gap.
 */
const HatchSpacer: FC<{ tone?: "dark" | "light" }> = ({ tone = "dark" }) => (
    <div
        aria-hidden="true"
        className="h-16 w-full border-y border-hairline bg-canvas [&+section]:border-t-0"
        data-site-theme={tone === "light" ? "light" : undefined}
        style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--site-hatch) 0 1px, rgb(0 0 0 / 0) 1px 8px)" }}
    />
);

export default HatchSpacer;
