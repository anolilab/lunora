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
            exclude: ["scripts/*", "@fumadocs/mdx-remote", "@fumadocs/mdx-remote/client"],
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
                },
            }),
            ...(mode !== "development" ? [netlify()] : []),
            react(),
            babel({ presets: [reactCompilerPreset()] }),
        ],
        server: {
            proxy: {
                "/pr/posthog": {
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/pr\/posthog/, ""),
                    target: "https://eu.i.posthog.com",
                },
            },
        },
        ssr: {
            optimizeDeps: {
                exclude: ["fumadocs-ui", "fumadocs-core", "@fumadocs/mdx-remote"],
                include: ["react", "react-dom"],
            },
        },
    } as UserConfig;
});
