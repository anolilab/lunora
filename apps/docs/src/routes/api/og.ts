import { createFileRoute } from "@tanstack/react-router";

import { getPackageBySlug } from "@/data/packages";

const ACCENT_COLORS: Record<string, string> = {
    "crimson-energy": "#DC2626",
    "royal-amethyst": "#7C3AED",
    "sky-sapphire": "#0284C7",
};

const escapeXml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

const generateOgSvg = (title: string, description: string, accentColor: string): string => {
    const accent = ACCENT_COLORS[accentColor] ?? "#4F46E5";
    const truncatedDesc = description.length > 120 ? `${description.slice(0, 117)}...` : description;

    return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#0a0a0a"/>
  <rect x="0" y="0" width="8" height="630" fill="${accent}"/>
  <text x="80" y="260" font-family="system-ui, sans-serif" font-size="56" font-weight="bold" fill="white">${escapeXml(title)}</text>
  <text x="80" y="320" font-family="system-ui, sans-serif" font-size="24" fill="#999999">${escapeXml(truncatedDesc)}</text>
  <text x="80" y="560" font-family="system-ui, sans-serif" font-size="20" fill="#666666">lunora.sh</text>
  <circle cx="1100" cy="540" r="30" fill="${accent}" opacity="0.3"/>
</svg>`;
};

export const Route = createFileRoute("/api/og")({
    server: {
        handlers: {
            GET(request) {
                const url = new URL(request.request.url);
                const slug = url.searchParams.get("slug");

                let title = "Lunora";
                let description = "The type-safe, real-time backend for Cloudflare.";
                let accentColor = "sky-sapphire";

                if (slug) {
                    const pkg = getPackageBySlug(slug);

                    if (pkg) {
                        title = pkg.name;
                        description = pkg.description;
                        accentColor = pkg.accentColor;
                    }
                }

                const svg = generateOgSvg(title, description, accentColor);

                return new Response(svg, {
                    headers: {
                        "Cache-Control": "public, max-age=86400",
                        "Content-Type": "image/svg+xml",
                    },
                });
            },
        },
    },
});
