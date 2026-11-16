/**
 * Renders every generated social card to `public/og/**.png` before `vite build`.
 *
 * This runs in Node rather than in the Worker on purpose. satori >= 0.33 lays
 * text out with HarfBuzz, whose emscripten loader compiles wasm from bytes at
 * runtime, which workerd forbids; the last release that ran there (0.32) has an
 * SVG escaping advisory (GHSA-wx4j-mvgx-mqwp). Every card's input is known at
 * build time, so the images ship as static assets instead.
 *
 * Run with `node --experimental-strip-types`: the page data and the path helper
 * are imported from the app's own TypeScript so the cards and the `og:image`
 * meta cannot drift apart.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import matter from "gray-matter";
import { createElement as h } from "react";
import satori from "satori";

import { examples } from "../src/data/examples.ts";
import { packages } from "../src/data/packages.ts";
import { isFallbackImage, ogImagePath } from "../src/lib/seo.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = join(webRoot, "public");
const blogDirectory = join(webRoot, "src", "content", "blog");

const ACCENT_COLORS = {
    "crimson-energy": "#ED5AA3",
    "royal-amethyst": "#9273E8",
    "sky-sapphire": "#31DAED",
};

const FONT_BASE = "https://cdn.jsdelivr.net/fontsource/fonts";

const fetchFont = async (url) => {
    const response = await fetch(url);

    // A CDN error page handed to satori fails later with an opaque font-parse error.
    if (!response.ok) {
        throw new Error(`Fetching OG font ${url} failed: ${response.status} ${response.statusText}`);
    }

    return response.arrayBuffer();
};

const loadFonts = async () => {
    const [regular, bold, mono] = await Promise.all([
        fetchFont(`${FONT_BASE}/geist@latest/latin-400-normal.ttf`),
        fetchFont(`${FONT_BASE}/geist@latest/latin-700-normal.ttf`),
        fetchFont(`${FONT_BASE}/geist-mono@latest/latin-400-normal.ttf`),
    ]);

    return [
        { data: regular, name: "Geist", style: "normal", weight: 400 },
        { data: bold, name: "Geist", style: "normal", weight: 700 },
        { data: mono, name: "Geist Mono", style: "normal", weight: 400 },
    ];
};

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const card = ({ accent, description, eyebrow, title }) =>
    h(
        "div",
        { style: { backgroundColor: "#0e0e11", display: "flex", fontFamily: "Geist", height: "630px", width: "1200px" } },
        h("div", { style: { background: "linear-gradient(180deg, #31DAED 0%, #9273E8 50%, #ED5AA3 100%)", height: "630px", width: "10px" } }),
        h(
            "div",
            { style: { display: "flex", flex: 1, flexDirection: "column", justifyContent: "space-between", padding: "84px 80px" } },
            h(
                "div",
                { style: { display: "flex", flexDirection: "column" } },
                h("div", { style: { color: accent, fontFamily: "Geist Mono", fontSize: "22px", letterSpacing: "3px" } }, eyebrow.toUpperCase()),
                h("div", { style: { color: "#F2F3F8", fontSize: "62px", fontWeight: 700, lineHeight: 1.12, marginTop: "30px" } }, title),
                h("div", { style: { color: "#A0A0A8", fontSize: "27px", lineHeight: 1.4, marginTop: "26px" } }, truncate(description, 130)),
            ),
            h("div", { style: { color: "#6B7280", display: "flex", fontFamily: "Geist Mono", fontSize: "22px" } }, "lunora.sh"),
        ),
    );

const listBlogCards = async () => {
    const files = (await readdir(blogDirectory)).filter((file) => [".md", ".mdx"].includes(extname(file)));

    const posts = await Promise.all(
        files.map(async (file) => {
            const { data } = matter(await readFile(join(blogDirectory, file), "utf8"));

            return { data, slug: file.slice(0, -extname(file).length) };
        }),
    );

    // A post with its own cover art shares that instead, so it needs no card.
    return posts
        .filter(({ data }) => isFallbackImage(data.image))
        .map(({ data, slug }) => {
            return {
                accent: "royal-amethyst",
                description: data.description ?? "",
                eyebrow: data.category ?? "Blog",
                page: `blog/${slug}`,
                title: data.title ?? "Lunora",
            };
        });
};

const cards = [
    {
        accent: "royal-amethyst",
        description: "News, insights, and engineering deep dives from the team building Lunora.",
        eyebrow: "Blog",
        page: "blog",
        title: "News & insights",
    },
    ...(await listBlogCards()),
    ...packages.map((pkg) => {
        return { accent: pkg.accentColor, description: pkg.description, eyebrow: "Package", page: `packages/${pkg.slug}`, title: pkg.name };
    }),
    ...examples.map((example) => {
        return { accent: "royal-amethyst", description: example.what, eyebrow: "Example", page: `examples/${example.dir}`, title: example.dir };
    }),
];

const require = createRequire(import.meta.url);

const [fonts] = await Promise.all([loadFonts(), readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")).then((wasm) => initWasm(wasm))]);

const outputRoot = join(publicDirectory, "og");

// Cleared first so a renamed or deleted page does not leave its card deployed.
await rm(outputRoot, { force: true, recursive: true });

const started = performance.now();

for (const { accent, description, eyebrow, page, title } of cards) {
    const svg = await satori(card({ accent: ACCENT_COLORS[accent] ?? ACCENT_COLORS["royal-amethyst"], description, eyebrow, title }), {
        fonts,
        height: 630,
        width: 1200,
    });

    const resvg = new Resvg(svg);
    const rendered = resvg.render();
    const target = join(publicDirectory, ogImagePath(page));

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rendered.asPng());

    rendered.free();
    resvg.free();
}

console.log(`Generated ${String(cards.length)} OG images in ${String(Math.round(performance.now() - started))}ms`);
