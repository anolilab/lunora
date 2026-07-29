/**
 * React Doctor configuration for `@lunora/studio`.
 *
 * Package-wide policy lives here rather than as a suppression comment repeated
 * at every site — the same call the ESLint config already makes for the
 * react-perf and context-value rules (see `eslint.config.js`, "React Compiler is
 * enabled for this package"). Twenty copies of one decision mean a reader cannot
 * tell a file with a real reason from one that was blanket-stamped, and
 * revisiting the decision becomes a twenty-file edit.
 *
 * Anything that is genuinely per-site — a false positive, a load-bearing
 * identity, a deliberate trade-off in one component — stays an inline
 * `react-doctor-disable-next-line` with its own reason. This file is only for
 * rules we have decided do not apply to this package at all.
 */
export default {
    rules: {
        /*
         * The Studio ships one feature per file: the panel plus the helpers,
         * types, and small subcomponents it owns. This rule wants each of those
         * split in two so Fast Refresh can preserve component state during dev —
         * an HMR-only gain, paid for with a package-wide file split and the
         * import churn that follows it.
         *
         * Where a helper is genuinely reusable it already lives in its own module
         * (`features/data/column-window.ts`, `highlight-segments.ts`,
         * `features/sql/editor-spans.ts` were split out for exactly this reason).
         * That is a judgement per helper, not a rule we want enforced everywhere.
         */
        "react-doctor/only-export-components": "off",
    },
};
