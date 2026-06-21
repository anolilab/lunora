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
