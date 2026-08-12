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
 */
const twMerge = extendTailwindMerge({
    extend: {
        classGroups: {
            "font-size": [{ text: ["display", "h1", "h2", "h3", "body", "blurb", "kicker", "micro"] }],
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
