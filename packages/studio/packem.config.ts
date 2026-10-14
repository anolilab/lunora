import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import { createReactPreset } from "@visulima/packem/config/preset/react";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    externals: [/^react($|\/)/, /^react-dom($|\/)/],
    // Run React Compiler over the studio components so the compiler emits optimal
    // memoization at build time and manual `useMemo`/`useCallback`/`memo` can be
    // dropped from source. Babel (preset-react + the compiler) runs ahead of
    // esbuild. `panicThreshold: "none"` lets the compiler silently bail on a
    // component it can't yet optimize instead of failing the build — required for
    // incremental adoption over an existing codebase with compiler-bailout sites
    // (try/finally bodies, ref-in-render, set-state-in-effect, …).
    preset: createReactPreset({ plugins: [["babel-plugin-react-compiler", { panicThreshold: "none" }]] }),
    // Ship `.mjs`, not `.js`. In a `"type": "module"` package Node has to find,
    // read and parse the nearest package.json to classify a `.js` file before it
    // can execute it; `.mjs` is self-describing and skips that on every load.
    // Stated explicitly because packem otherwise infers the extension from the
    // exports map, and this package exports `./standalone/studio.js` — a static
    // browser bundle esbuild emits separately, not a packem entry. That one `.js`
    // value made packem emit `dist/index.js` / `dist/mount.js` for the whole
    // package while the exports map pointed at `.mjs`, which resolves to nothing.
    outputExtensionMap: { cjs: "cjs", esm: "mjs" },
    // The three subpaths packem does not build: the stylesheet comes from the
    // `build:css` tailwind step, the standalone bundle from `build:standalone`
    // (esbuild), and `./theme.css` ships as source. All three run AFTER packem,
    // which cleans `dist` first — so at validation time they legitimately do not
    // exist yet. Ignoring only these keeps the check live for `.` and `./mount`,
    // where a stale extension is a real broken-resolution bug.
    ignoreExportKeys: ["standalone/studio.js", "styles.css", "theme.css"],
    validation: {
        packageJson: {
            allowedExportExtensions: [".css"],
        },
    },
    rollup: {
        dts: {
            oxc: true,
        },
        license: {
            path: "./LICENSE.md",
        },
    },
    transformer,
}) as BuildConfig;
