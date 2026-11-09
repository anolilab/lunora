import { createRequire } from "node:module";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import mdx from "fumadocs-mdx/vite";
import Unfonts from "unplugin-fonts/vite";
import { defineConfig, UserConfig, type Plugin } from "vite";
import { imagetools } from "vite-imagetools";
import svgr from "vite-plugin-svgr";

const tryRequire = (id: string) => {
    try {
        const require = createRequire(import.meta.url);
        return require(id);
    } catch {
        return null;
    }
};

export default defineConfig(async ({ mode }) => {
    const plugins: Plugin[] = [];

    if (mode === "development") {
        const devToolbarModule = tryRequire("@visulima/dev-toolbar/vite");
        const viteOverlayModule = tryRequire("@visulima/vite-overlay");

        if (devToolbarModule) {
            const { devToolbar } = devToolbarModule;

            plugins.push(
                devToolbar({
                    apps: {
                        a11y: true,
                        assets: true,
                        inspector: true,
                        settings: true,
                        timeline: true,
                    },
                    defaultVisible: true,
                    placement: "bottom-center",
                }),
            );
        }

        if (viteOverlayModule) {
            const viteOverlay = viteOverlayModule.default ?? viteOverlayModule;

            plugins.push(viteOverlay({ showBallonButton: false }));
        }
    }

    return {
        resolve: {
            tsconfigPaths: true,
        },
        build: {
            assetsInlineLimit: 4096,
            chunkSizeWarningLimit: 1000,
            cssCodeSplit: true,
            cssMinify: "lightningcss",
            reportCompressedSize: true,
            sourcemap: false,
            target: "esnext",
        },
        optimizeDeps: {
            // @resvg/resvg-wasm (server-side OG route) ships a .wasm asset; keep it out of
            // the dep optimizer so it doesn't try to pre-bundle it.
            exclude: ["scripts/*", "@fumadocs/mdx-remote", "@fumadocs/mdx-remote/client", "@resvg/resvg-wasm"],
        },
        plugins: [
            // Must come first so it owns the `ssr` environment before `tanstackStart()` configures it.
            cloudflare({ viteEnvironment: { name: "ssr" } }),
            ...plugins,
            mdx(await import("./source.config")),
            tailwindcss(),
            svgr({
                svgrOptions: {
                    svgoConfig: {
                        floatPrecision: 2,
                    },
                },
            }),
            Unfonts({
                custom: {
                    families: [
                        {
                            name: "Geist Sans",
                            src: "./src/assets/fonts/geist/*.woff2",
                        },
                        {
                            name: "Geist Mono",
                            src: "./src/assets/fonts/geist-mono/*.woff2",
                        },
                    ],
                },
            }),
            imagetools({
                defaultDirectives: (url) => {
                    if (!url.searchParams.get("format") && (url.pathname.endsWith(".jpg") || url.pathname.endsWith(".jpeg"))) {
                        url.searchParams.set("format", "jpeg");
                    }

                    if (url.searchParams.get("format") === "jpeg") {
                        url.searchParams.set("progressive", "true");
                    }

                    // Product captures ship as 2880-wide PNGs and are never
                    // displayed above ~1024 CSS pixels. Re-encoding to WebP at
                    // 2048 still covers a 2x screen exactly and takes the hero
                    // capture from 185K to 44K.
                    //
                    // Applied here rather than as import query strings so the
                    // call sites stay plain `.png` imports and keep their types.
                    // Every capture is 2880x1760, so 2048 always yields
                    // 2048x1252 and the width/height attributes at the call
                    // sites hold for all of them.
                    if (url.pathname.endsWith(".png") && url.pathname.includes("/assets/studio/")) {
                        if (!url.searchParams.get("format")) {
                            url.searchParams.set("format", "webp");
                        }

                        if (!url.searchParams.get("w")) {
                            url.searchParams.set("w", "2048");
                        }
                    }

                    return url.searchParams;
                },
            }),
            tanstackStart({
                prerender: {
                    crawlLinks: true,
                    enabled: true,
                    // Retry transient prerender failures instead of crashing the
                    // build. The crawler's self-requests can race the local
                    // prerender server ("fetch failed"); without a retry that
                    // surfaces as an uncaught rejection and fails the whole build.
                    retryCount: 3,
                    retryDelay: 1000,
                },
                // Native sitemap: generated at build from the prerendered/crawled pages
                // (prerender.crawlLinks above discovers every linked route). Replaces the
                // hand-maintained sitemap route so new pages are picked up automatically.
                sitemap: {
                    enabled: true,
                    host: "https://lunora.sh",
                    outputPath: "sitemap.xml",
                },
            }),
            react(),
            babel({ presets: [reactCompilerPreset()] }),
        ],
        ssr: {
            // Bundle these into the Worker instead of resolving them from
            // node_modules at runtime. Workers have no node_modules, and a
            // wildcard `exports` map (c15t's primitives, the simple-icons `icons/*`
            // paths) cannot be resolved there at request time.
            noExternal: ["@c15t/react", "@c15t/ui", "@icons-pack/react-simple-icons"],
            optimizeDeps: {
                exclude: ["fumadocs-ui", "fumadocs-core", "@fumadocs/mdx-remote", "@resvg/resvg-wasm"],
                include: ["react", "react-dom"],
            },
        },
    } as UserConfig;
});
