import { createFileRoute } from "@tanstack/react-router";

// Region is EU, matching VITE_PUBLIC_POSTHOG_HOST. On a US project these become
// us-assets.i.posthog.com / us.i.posthog.com.
const ASSETS_HOST = "https://eu-assets.i.posthog.com";
const INGEST_HOST = "https://eu.i.posthog.com";

// Headers that describe this hop, not the analytics payload, so they are not forwarded.
const HOP_HEADERS = new Set(["cf-connecting-ip", "cf-ipcountry", "connection", "cookie", "host", "x-forwarded-for"]);

/**
 * First-party reverse proxy for PostHog (`api_host: "/pr/posthog"`), so analytics
 * leaves as same-origin requests rather than to a known tracker host.
 *
 * `posthog-js` loads its remote config and toolbar bundles from the assets host
 * and sends events to the ingestion host. The `static/` prefix routes to assets;
 * everything else is ingestion. Responses are passed through unchanged (not a
 * redirect), since a 30x would break the CORS preflight on ingestion POSTs.
 */
const proxy = async (request: Request, splat: string): Promise<Response> => {
    const isAssets = splat.startsWith("static/");
    const upstreamPath = isAssets ? splat.slice("static/".length) : splat;
    const base = isAssets ? `${ASSETS_HOST}/static/` : `${INGEST_HOST}/`;
    const incoming = new URL(request.url);
    const target = new URL(`${base}${upstreamPath}${incoming.search}`);

    const headers = new Headers();

    for (const [name, value] of request.headers) {
        if (!HOP_HEADERS.has(name)) {
            headers.set(name, value);
        }
    }

    // Give PostHog the real client address, which the stripped hop headers would otherwise drop.
    const clientIp = request.headers.get("cf-connecting-ip");

    if (clientIp) {
        headers.set("x-forwarded-for", clientIp);
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    return fetch(target, {
        body: hasBody ? request.body : undefined,
        duplex: "half",
        headers,
        method: request.method,
    } as RequestInit);
};

const handle = ({ request, params }: { params: { _splat?: string }; request: Request }) => proxy(request, params._splat ?? "");

export const Route = createFileRoute("/pr/posthog/$")({
    server: {
        handlers: {
            DELETE: handle,
            GET: handle,
            HEAD: handle,
            OPTIONS: handle,
            PATCH: handle,
            POST: handle,
            PUT: handle,
        },
    },
});
