import { defineBuildConfig } from "unbuild";

/**
 * `@nuxt/module-builder` already builds `src/module.ts` → `dist/module.mjs` and
 * mkdist-transpiles `src/runtime/` → `dist/runtime/` (so the `addServerHandler`
 * target resolves at the consumer's build). This adds the extra `./server`
 * entry — the framework-neutral SSR re-export from `@lunora/client/ssr`.
 */
export default defineBuildConfig({
    entries: ["src/server"],
});
