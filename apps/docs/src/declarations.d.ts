// The `@icons-pack/react-simple-icons/icons/*.mjs` deep imports ship sibling
// `*.d.ts` files, but the explicit `.mjs` specifier under bundler resolution
// doesn't pick them up — so type the default export here as an SVG component to
// keep icon assignments type-safe instead of `any`.
declare module "@icons-pack/react-simple-icons/icons/*.mjs" {
    import type { ComponentType, SVGProps } from "react";

    const icon: ComponentType<SVGProps<SVGSVGElement> & { color?: string; size?: number | string; title?: string }>;
    export default icon;
}

declare module "fumadocs-mdx:collections/browser";

// `?module` imports compile the wasm at build time, so the default export is a
// `WebAssembly.Module` (see `src/routes/api/og.tsx`).
declare module "*.wasm?module" {
    const module: WebAssembly.Module;

    export default module;
}

// Minimal type for the Worker bindings this app reads. Declared here rather than
// through `wrangler types`, whose global Cloudflare lib types change the DOM's
// `fetch` signatures for the whole client bundle.
declare module "cloudflare:workers" {
    // eslint-disable-next-line unicorn/prevent-abbreviations -- `cloudflare:workers` exports `env` by that name
    export const env: {
        WAITLIST: { put: (key: string, value: string) => Promise<void> };
    };
}
