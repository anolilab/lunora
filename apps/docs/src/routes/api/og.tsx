import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { createFileRoute } from "@tanstack/react-router";
import satori from "satori";

import { getPackageBySlug } from "@/data/packages";

// resvg-wasm (no native binary) so this works in serverless functions, where the
// native @resvg/resvg-js addon fails to bundle. The wasm version must match the
// installed @resvg/resvg-wasm version. Initialized once per cold start.
const RESVG_WASM_URL = "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm";

let wasmReady: Promise<void> | null = null;

const ensureWasm = (): Promise<void> => {
    wasmReady ??= initWasm(fetch(RESVG_WASM_URL));

    return wasmReady;
};

const ACCENT_COLORS: Record<string, string> = {
    "crimson-energy": "#ED5AA3",
    "royal-amethyst": "#9273E8",
    "sky-sapphire": "#31DAED",
};

const FONT_BASE = "https://cdn.jsdelivr.net/fontsource/fonts";

const fetchFont = async (url: string): Promise<ArrayBuffer> => {
    const response = await fetch(url);

    return response.arrayBuffer();
};

// Fonts are fetched once per cold start and reused (OG responses are cached a day).
let fontsPromise: Promise<{ data: ArrayBuffer; name: string; style: "normal"; weight: 400 | 700 }[]> | null = null;

const loadFonts = () => {
    fontsPromise ??= Promise.all([
        fetchFont(`${FONT_BASE}/geist@latest/latin-400-normal.ttf`),
        fetchFont(`${FONT_BASE}/geist@latest/latin-700-normal.ttf`),
        fetchFont(`${FONT_BASE}/geist-mono@latest/latin-400-normal.ttf`),
    ]).then(([regular, bold, mono]) => [
        { data: regular, name: "Geist", style: "normal" as const, weight: 400 as const },
        { data: bold, name: "Geist", style: "normal" as const, weight: 700 as const },
        { data: mono, name: "Geist Mono", style: "normal" as const, weight: 400 as const },
    ]);

    return fontsPromise;
};

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const renderPng = async (title: string, description: string, eyebrow: string, accent: string): Promise<Uint8Array<ArrayBuffer>> => {
    const svg = await satori(
        <div style={{ backgroundColor: "#0e0e11", display: "flex", fontFamily: "Geist", height: "630px", width: "1200px" }}>
            <div style={{ background: "linear-gradient(180deg, #31DAED 0%, #9273E8 50%, #ED5AA3 100%)", height: "630px", width: "10px" }} />
            <div style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "space-between", padding: "84px 80px" }}>
                <div style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ color: accent, fontFamily: "Geist Mono", fontSize: "22px", letterSpacing: "3px" }}>{eyebrow.toUpperCase()}</div>
                    <div style={{ color: "#F2F3F8", fontSize: "62px", fontWeight: 700, lineHeight: 1.12, marginTop: "30px" }}>{title}</div>
                    <div style={{ color: "#A0A0A8", fontSize: "27px", lineHeight: 1.4, marginTop: "26px" }}>{truncate(description, 130)}</div>
                </div>
                <div style={{ color: "#6B7280", display: "flex", fontFamily: "Geist Mono", fontSize: "22px" }}>lunora.sh</div>
            </div>
        </div>,
        { fonts: await loadFonts(), height: 630, width: 1200 },
    );

    await ensureWasm();

    const resvg = new Resvg(svg);
    const rendered = resvg.render();
    const png = rendered.asPng();

    // Copy out of wasm memory into a fresh ArrayBuffer-backed Uint8Array before
    // freeing (also a valid Response BodyInit, which the raw view is not).
    const bytes = new Uint8Array(png.byteLength);

    bytes.set(png);
    rendered.free();
    resvg.free();

    return bytes;
};

export const Route = createFileRoute("/api/og")({
    server: {
        handlers: {
            async GET(request) {
                const url = new URL(request.request.url);
                const slug = url.searchParams.get("slug");
                const titleParam = url.searchParams.get("title");

                let title = "Lunora";
                let description = "The type-safe, real-time backend for Cloudflare.";
                let eyebrow = "Lunora";
                let accentColor = "sky-sapphire";

                if (titleParam) {
                    // Direct mode: blog posts (and any page) pass their own title/description.
                    title = titleParam;
                    description = url.searchParams.get("description") ?? "";
                    eyebrow = url.searchParams.get("eyebrow") ?? "Lunora";
                    accentColor = url.searchParams.get("accent") ?? "royal-amethyst";
                } else if (slug) {
                    const pkg = getPackageBySlug(slug);

                    if (pkg) {
                        title = pkg.name;
                        description = pkg.description;
                        eyebrow = "Package";
                        accentColor = pkg.accentColor;
                    }
                }

                const png = await renderPng(title, description, eyebrow, ACCENT_COLORS[accentColor] ?? "#9273E8");

                return new Response(png, {
                    headers: {
                        "Cache-Control": "public, max-age=86400",
                        "Content-Type": "image/png",
                    },
                });
            },
        },
    },
});
