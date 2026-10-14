import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The theme's type-scale utilities are named (`text-h2`, `text-blurb`) rather
 * than sized (`text-lg`), which tailwind-merge cannot tell apart from a colour
 * utility on its own: it sees `text-h3` and `text-ink`, assumes both are text
 * colours, and silently drops the first.
 *
 * That is not a hypothetical. Before this was registered, every
 * `cn("text-h3 …", "text-ink")` in the app shipped without its size, and the
 * headings rendered at the browser default instead of the scale.
 *
 * Registering the names under `font-size` restores the real conflict groups:
 * size beats size, colour beats colour, and the two stop fighting. Any token
 * added to `--text-*` in `theme/tokens.css` must be added here too.
 *
 * The spacing scale has exactly the same problem, and it bit in exactly the same
 * way: `cn("pb-section-end", "pb-0")` shipped *both*, because tailwind-merge
 * does not know `section-end` is a length, and the named class won on source
 * order — so a caller passing `pb-0` got 56px of padding and no error.
 *
 * Any token added to `--spacing-*` must be listed here too.
 */
const SPACING = ["section", "section-end", "gutter", "col-gap"];

const twMerge = extendTailwindMerge({
    extend: {
        classGroups: {
            "font-size": [{ text: ["display", "h1", "h2", "h3", "body", "blurb", "kicker", "micro"] }],
            gap: [{ gap: SPACING }],
            m: [{ m: SPACING }],
            mb: [{ mb: SPACING }],
            ml: [{ ml: SPACING }],
            mr: [{ mr: SPACING }],
            mt: [{ mt: SPACING }],
            mx: [{ mx: SPACING }],
            my: [{ my: SPACING }],
            p: [{ p: SPACING }],
            pb: [{ pb: SPACING }],
            pl: [{ pl: SPACING }],
            pr: [{ pr: SPACING }],
            pt: [{ pt: SPACING }],
            px: [{ px: SPACING }],
            py: [{ py: SPACING }],
        },
    },
});

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function formatNumber(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }

    if (n >= 1000) {
        return `${(n / 1000).toFixed(1)}K`;
    }

    return n.toString();
}
