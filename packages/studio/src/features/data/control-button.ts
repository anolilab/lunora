/**
 * The Supabase-style toolbar button classes, shared by the data feature's toolbars.
 *
 * One definition rather than a copy per toolbar: this existed five times across
 * `data-browser-page.tsx`, `global-data-page.tsx`, `row-form.tsx`,
 * `grid-features.tsx` and `data-query-bar.tsx`, several with a comment calling
 * themselves "shared". A theme tweak had to land in five files, and the ones
 * nobody had open were the ones that would drift — two already had the same
 * classes in a different order.
 *
 * The two exports are a real distinction, not an accident of copying: three of the
 * five carried `aria-pressed:` styling for toggle buttons and two did not. The
 * pressed classes are inert without the attribute, so a single constant would have
 * rendered identically — but keeping them separate says which buttons are toggles,
 * which is the thing a reader needs.
 */

/** A plain toolbar button — no pressed state. */
const CONTROL_BTN =
    "inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

/** A toolbar button that carries `aria-pressed`, styled for its pressed state. */
const CONTROL_TOGGLE_BTN = `${CONTROL_BTN} aria-pressed:bg-accent aria-pressed:text-accent-foreground`;

export { CONTROL_BTN, CONTROL_TOGGLE_BTN };
