import { createFileRoute } from "@tanstack/react-router";

import { getPackageBySlug } from "@/data/packages";

const ACCENT_COLORS: Record<string, string> = {
    "crimson-energy": "#ED5AA3",
    "royal-amethyst": "#9273E8",
    "sky-sapphire": "#31DAED",
};

const WORD_SPLIT = /\s+/;

const escapeXml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** Wrap a title into at most `maxLines` lines of roughly `maxChars`, ellipsizing overflow. */
const wrapTitle = (title: string, maxChars: number, maxLines: number): string[] => {
    const words = title.trim().split(WORD_SPLIT).filter(Boolean);
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;

        if (candidate.length > maxChars && current) {
            lines.push(current);
            current = word;

            if (lines.length === maxLines) {
                break;
            }
        } else {
            current = candidate;
        }
    }

    if (current && lines.length < maxLines) {
        lines.push(current);
    }

    if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
        lines[maxLines - 1] = `${lines[maxLines - 1]!.slice(0, maxChars - 1).trimEnd()}…`;
    }

    return lines;
};

const generateOgSvg = (title: string, description: string, eyebrow: string, accent: string): string => {
    const titleLines = wrapTitle(title, 28, 3);
    const titleStartY = 252 - (titleLines.length - 1) * 33;
    const descriptionY = titleStartY + titleLines.length * 66 + 26;
    const truncatedDescription = description.length > 110 ? `${description.slice(0, 107)}...` : description;

    const titleTspans = titleLines
        .map((line, index) => `<text x="80" y="${titleStartY + index * 66}" font-family="system-ui, sans-serif" font-size="58" font-weight="700" fill="#F2F3F8">${escapeXml(line)}</text>`)
        .join("\n  ");

    return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="aurora" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#31DAED"/>
      <stop offset="0.5" stop-color="#9273E8"/>
      <stop offset="1" stop-color="#ED5AA3"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#0e0e11"/>
  <rect x="0" y="0" width="10" height="630" fill="url(#aurora)"/>
  <text x="80" y="150" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" letter-spacing="2" fill="${accent}">${escapeXml(eyebrow.toUpperCase())}</text>
  ${titleTspans}
  <text x="80" y="${descriptionY}" font-family="system-ui, sans-serif" font-size="26" fill="#A0A0A8">${escapeXml(truncatedDescription)}</text>
  <text x="80" y="560" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" fill="#6B7280">lunora.sh</text>
  <circle cx="1110" cy="540" r="30" fill="url(#aurora)" opacity="0.35"/>
</svg>`;
};

export const Route = createFileRoute("/api/og")({
    server: {
        handlers: {
            GET(request) {
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

                const svg = generateOgSvg(title, description, eyebrow, ACCENT_COLORS[accentColor] ?? "#9273E8");

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
