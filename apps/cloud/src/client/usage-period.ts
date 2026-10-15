/**
 * The usage tab's billing period, in its own module.
 *
 * It lives here rather than in `UsageSection.tsx` because that file is a component
 * module: exporting a plain helper alongside the component defeats React Fast
 * Refresh (an edit to either forces a full reload instead of a component swap) and
 * is what `react-doctor/only-export-components` flags. The route loader and the
 * component both import it, so SSR and the client agree on the period.
 */

/** Epoch ms for the first instant of the current UTC month. */
export const monthStart = (): number => {
    const now = new Date();

    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};
