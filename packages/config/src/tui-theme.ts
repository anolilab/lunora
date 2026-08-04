/**
 * Shared visual theme for Lunora's terminal surfaces — the create-astro-style
 * step badges plus the standard log-level badges. Lives in `@lunora/config` so
 * the CLI (`@lunora/cli`) and the Vite plugin (`@lunora/vite`) render an
 * identical look through the same `LunoraReporter` (`./lunora-reporter`).
 *
 * Framework-free (no React, no pail) — just data plus a `@visulima/colorize`
 * string painter — so any consumer can import it. The CLI's tui prompts read the
 * same `BadgeSpec` colors to render badges as `<Text>` elements on a TTY.
 */

import colorize from "@visulima/colorize";

/**
 * A badge: the short colored label that prefixes a line. `bg`/`fg` are hex so the
 * same value drives both colorize's `bgHex().hex()` and the tui `<Text>` props.
 */
interface BadgeSpec {
    bg: `#${string}`;
    fg: `#${string}`;
    text: string;
}

/** Lunora purple — the accent shared with the CLI prompt frames. */
const ACCENT: `#${string}` = "#a855f7";

/** Near-black foreground that reads on every badge background. */
const INK: `#${string}` = "#0b0b0b";

/** Standard log-level badge names (the restyled base output). */
type LevelBadgeName = "debug" | "error" | "info" | "success" | "warn";

/** Step-phase badge names (the create-astro-style flow transcript). */
type StepBadgeName = "add" | "deps" | "dir" | "git" | "lunora" | "next" | "tmpl";

type BadgeName = LevelBadgeName | StepBadgeName;

/** The ordered step-phase names, used to register custom pail log types. */
const STEP_BADGE_NAMES: ReadonlyArray<StepBadgeName> = ["lunora", "dir", "tmpl", "add", "deps", "git", "next"];

/**
 * Every badge, keyed by name. Levels get their conventional colors (red/amber/
 * green/blue/grey); step phases follow create-astro's green→purple→cyan rhythm.
 */
const BADGES: Record<BadgeName, BadgeSpec> = {
    add: { bg: ACCENT, fg: INK, text: "add" },
    debug: { bg: "#6b7280", fg: "#f3f4f6", text: "debug" },
    deps: { bg: ACCENT, fg: INK, text: "deps" },
    dir: { bg: ACCENT, fg: INK, text: "dir" },
    error: { bg: "#ef4444", fg: INK, text: "error" },
    git: { bg: "#f59e0b", fg: INK, text: "git" },
    info: { bg: "#3b82f6", fg: INK, text: "info" },
    lunora: { bg: "#22c55e", fg: INK, text: "lunora" },
    next: { bg: "#06b6d4", fg: INK, text: "next" },
    success: { bg: "#22c55e", fg: INK, text: "ok" },
    tmpl: { bg: ACCENT, fg: INK, text: "tmpl" },
    warn: { bg: "#f59e0b", fg: INK, text: "warn" },
};

/**
 * Luna, the mascot: the folklore rabbit-in-the-moon — a bunny tucked inside the
 * moon disc. Pure ASCII so it renders the same everywhere (including piped logs).
 * The CLI signs off the `init` flow with it, the way create-astro closes with
 * Houston.
 */
const LUNA_NAME = "Luna";

const LUNA_SIGNOFF = "Safe travels, voyager.";

const LUNA_BUNNY: string = String.raw`
   .-"""""-.
  /  (\(\   \
 |   ( -.-)  |
  \  o(")(") /
   '-._____.-'`;

/**
 * {@link LUNA_BUNNY} with its leading newline stripped, ready to render inline
 * (beside the name + sign-off). Both render paths — the tui mascot frame and the
 * pail off-TTY fallback — use this so neither re-implements the strip.
 */
const LUNA_ART: string = LUNA_BUNNY.startsWith("\n") ? LUNA_BUNNY.slice(1) : LUNA_BUNNY;

/**
 * Width the badge labels are right-aligned within so their colored boxes line up
 * in a gutter — create-astro's look. Sized to the longest badge text (`lunora`).
 * The right-alignment is done with plain leading spaces *outside* the colored
 * box, so each box hugs its word (` dir `) rather than being one wide block.
 */
const BADGE_GUTTER = 6;

/** The colored part of a badge — the word with one space of padding each side. */
const padBadge = (text: string): string => ` ${text} `;

/** Leading spaces that right-align a badge's box within the gutter. */
const badgeLead = (text: string): string => " ".repeat(Math.max(0, BADGE_GUTTER - text.length));

/** Total columns a rendered badge column occupies (lead + box), constant across badges. */
const BADGE_COLUMN_WIDTH: number = BADGE_GUTTER + 2;

/** Columns a rendered badge occupies — the gutter-aligned column width. */
const badgeWidth = (_spec: BadgeSpec): number => BADGE_COLUMN_WIDTH;

/** Paint a badge as an ANSI string (the non-tui path): right-aligning spaces + the colored box. */
const paintBadge = (spec: BadgeSpec): string =>
    // eslint-disable-next-line import/no-named-as-default-member -- see file header.
    badgeLead(spec.text) + colorize.bgHex(spec.bg).hex(spec.fg).bold(padBadge(spec.text));

/** Dim continuation text (a step's chosen answer, shown under the question). */
// eslint-disable-next-line import/no-named-as-default-member -- see file header.
const paintAnswer = (text: string): string => colorize.dim(text);

export type { BadgeName, BadgeSpec, LevelBadgeName, StepBadgeName };
export {
    ACCENT,
    BADGE_COLUMN_WIDTH,
    badgeLead,
    BADGES,
    badgeWidth,
    LUNA_ART,
    LUNA_BUNNY,
    LUNA_NAME,
    LUNA_SIGNOFF,
    padBadge,
    paintAnswer,
    paintBadge,
    STEP_BADGE_NAMES,
};
