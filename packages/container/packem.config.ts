import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    failOnWarn: false,
    // `@cloudflare/containers` is a devDependency, NOT a runtime dependency, so
    // packem inlines its source into our `dist/do` chunk instead of leaving an
    // `import … from "@cloudflare/containers"` edge. Two reasons:
    //   1. We carry a `pnpm patch` backport of upstream alarm-spinloop +
    //      not-listening fixes (cloudflare/containers#191, #230). A patch only
    //      rewrites *our* node_modules — a published runtime dep would resolve to
    //      the pristine, still-buggy npm release on a consumer's machine. Bundling
    //      the patched source bakes the fixes into what we ship.
    //   2. `@lunora/container/do` becomes self-contained — a consuming worker no
    //      longer needs `@cloudflare/containers` installed at all.
    // The inlined code's only non-relative import is the workerd built-in
    // `cloudflare:workers`, which must stay external (the runtime provides it).
    externals: [/^cloudflare:/],
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
