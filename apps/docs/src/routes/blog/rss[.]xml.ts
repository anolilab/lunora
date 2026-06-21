import { createFileRoute } from "@tanstack/react-router";

import { listBlogPosts } from "@/lib/blog-source";
import { SITE_URL } from "@/lib/seo";

const XML_ESCAPE = /[&<>"]/g;

const escapeXml = (value: string): string =>
    value.replaceAll(XML_ESCAPE, (char) => {
        if (char === "&") {
            return "&amp;";
        }

        if (char === "<") {
            return "&lt;";
        }

        if (char === ">") {
            return "&gt;";
        }

        return "&quot;";
    });

const generateFeed = (): string => {
    const items = listBlogPosts()
        .map((post) => {
            const link = `${SITE_URL}/blog/${post.slug}`;
            const pubDate = post.publishedAt ? `\n      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>` : "";
            const category = post.category ? `\n      <category>${escapeXml(post.category)}</category>` : "";

            return `    <item>
      <title>${escapeXml(post.title ?? "")}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <description>${escapeXml(post.description ?? "")}</description>${category}${pubDate}
    </item>`;
        })
        .join("\n");

    // eslint-disable-next-line no-secrets/no-secrets -- RSS feed MIME type, not a secret
    const selfLink = `    <atom:link href="${SITE_URL}/blog/rss.xml" rel="self" type="application/rss+xml" />`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Lunora Blog</title>
    <link>${SITE_URL}/blog</link>
    <description>News, insights, and engineering deep dives from the team building Lunora.</description>
    <language>en</language>
${selfLink}
${items}
  </channel>
</rss>`;
};

export const Route = createFileRoute("/blog/rss.xml")({
    server: {
        handlers: {
            GET() {
                return new Response(generateFeed(), {
                    headers: {
                        "Cache-Control": "public, max-age=3600",
                        "Content-Type": "application/rss+xml; charset=utf-8",
                    },
                });
            },
        },
    },
});
