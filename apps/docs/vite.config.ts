import { createRequire } from "node:module";

import netlify from "@netlify/vite-plugin-tanstack-start";
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
            minify: "esbuild",
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

                    return url.searchParams;
                },
            }),
            tanstackStart({
                prerender: {
                    crawlLinks: true,
                    enabled: true,
                    // Retry transient prerender failures instead of crashing the
                    // build. Netlify's concurrent crawler intermittently hits a
                    // "fetch failed" (ETIMEDOUT ::1 → ECONNREFUSED 127.0.0.1) when
                    // a self-request races the local prerender server; without a
                    // retry that surfaces as an uncaught rejection and fails the
                    // whole build.
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
            ...(mode !== "development" ? [netlify()] : []),
            react(),
            babel({ presets: [reactCompilerPreset()] }),
        ],
        server: {
            proxy: {
                // Dev-side mirror of the `/pr/posthog` rules in `public/_redirects`.
                // These two must stay in step: this block only exists in the dev
                // server, so production ingestion rides entirely on the Netlify
                // rules. Assets host first — Vite matches proxy keys by longest
                // prefix, but keeping the order explicit mirrors _redirects, where
                // order is what decides.
                "/pr/posthog/static": {
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/pr\/posthog/, ""),
                    target: "https://eu-assets.i.posthog.com",
                },
                "/pr/posthog": {
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/pr\/posthog/, ""),
                    target: "https://eu.i.posthog.com",
                },
            },
        },
        ssr: {
            // resvg-wasm: load from node_modules at runtime, don't bundle (avoids the
            // bundler resolving its .wasm asset at build time).
            external: ["@resvg/resvg-wasm"],
            optimizeDeps: {
                exclude: ["fumadocs-ui", "fumadocs-core", "@fumadocs/mdx-remote", "@resvg/resvg-wasm"],
                include: ["react", "react-dom"],
            },
        },
    } as UserConfig;
});
