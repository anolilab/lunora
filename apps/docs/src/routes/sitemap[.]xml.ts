import { createFileRoute } from "@tanstack/react-router";

import { packages } from "@/data/packages";
import { source } from "@/lib/docs-source";

const SITE_URL = "https://lunora.sh";

const staticRoutes = [
    { changefreq: "weekly", path: "/", priority: 1 },
    { changefreq: "weekly", path: "/packages", priority: 0.9 },
    { changefreq: "weekly", path: "/docs", priority: 0.9 },
    { changefreq: "monthly", path: "/changelog", priority: 0.6 },
    { changefreq: "monthly", path: "/brand", priority: 0.4 },
    { changefreq: "yearly", path: "/privacy", priority: 0.3 },
    { changefreq: "yearly", path: "/code-of-conduct", priority: 0.3 },
];

function generateSitemap(): string {
    const urls: string[] = [];

    for (const route of staticRoutes) {
        urls.push(`  <url>
    <loc>${SITE_URL}${route.path}</loc>
    <changefreq>${route.changefreq}</changefreq>
    <priority>${route.priority}</priority>
  </url>`);
    }

    for (const pkg of packages) {
        urls.push(`  <url>
    <loc>${SITE_URL}/packages/${pkg.slug}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`);
    }

    const pages = source.getPages();

    for (const page of pages) {
        const slugPath = page.slugs.join("/");

        urls.push(`  <url>
    <loc>${SITE_URL}/docs/${slugPath}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;
}

export const Route = createFileRoute("/sitemap.xml")({
    server: {
        handlers: {
            GET() {
                return new Response(generateSitemap(), {
                    headers: {
                        "Cache-Control": "public, max-age=3600",
                        "Content-Type": "application/xml",
                    },
                });
            },
        },
    },
});
