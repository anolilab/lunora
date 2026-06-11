import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { isbot } from "isbot";

export const streamTimeout = 5_000;

/**
 * Cloudflare Workers entry.server — uses the Web Streams API (`renderToReadableStream`)
 * rather than the Node.js `renderToPipeableStream` path in the default
 * `@react-router/node` handler. This file is required because the React Router
 * build tool looks for `@react-router/node` in `dependencies` before falling
 * back to the built-in Node entry; for a CF Worker we supply our own entry
 * that works in the workerd runtime.
 *
 * The handler streams the React tree as HTML, waiting for all shell content
 * on bot/crawler requests and using progressive streaming for browsers.
 */
export default async function handleRequest(
    request: Request,
    responseStatusCode: number,
    responseHeaders: Headers,
    routerContext: EntryContext,
    _loadContext: AppLoadContext,
): Promise<Response> {
    // https://httpwg.org/specs/rfc9110.html#HEAD
    if (request.method.toUpperCase() === "HEAD") {
        return new Response(null, {
            status: responseStatusCode,
            headers: responseHeaders,
        });
    }

    const userAgent = request.headers.get("user-agent");
    // Bots and SPA-mode renders get the full shell before the stream closes.
    const waitForAllContent = (userAgent && isbot(userAgent)) || routerContext.isSpaMode;

    let status = responseStatusCode;

    const stream = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} />, {
        onError(error: unknown) {
            status = 500;
            console.error(error);
        },
    });

    if (waitForAllContent) {
        await stream.allReady;
    }

    responseHeaders.set("Content-Type", "text/html; charset=utf-8");

    return new Response(stream, {
        headers: responseHeaders,
        status,
    });
}
