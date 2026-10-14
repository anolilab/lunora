import { renderToReadableStream } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";

/**
 * Server entry for the Cloudflare Workers runtime.
 *
 * React Router v7 only generates a default `entry.server` when it can detect a
 * server runtime package — and the ones it knows about (`@react-router/node`,
 * `@react-router/cloudflare`) are Node/Pages adapters this template does not use:
 * the worker entry is Lunora's composed `virtual:lunora/worker`. Without this
 * file the build fails outright with "Could not determine server runtime".
 *
 * `renderToReadableStream` (Web Streams) rather than `renderToPipeableStream`
 * (Node streams) because Workers has no `node:stream`.
 */
export default async function handleRequest(
    request: Request,
    responseStatusCode: number,
    responseHeaders: Headers,
    routerContext: EntryContext,
): Promise<Response> {
    let status = responseStatusCode;
    // Errors thrown before the shell flushes are recoverable — React retries on
    // the client. After it flushes, the status is already sent, so the only thing
    // left to do is log.
    let shellRendered = false;

    const body = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} />, {
        onError(error: unknown) {
            status = 500;

            if (shellRendered) {
                // eslint-disable-next-line no-console -- surface post-shell render failures in the worker log
                console.error(error);
            }
        },
    });

    shellRendered = true;

    // In SPA mode there is no streaming client to resume the shell, so the whole
    // document has to be ready before it goes out.
    if (routerContext.isSpaMode) {
        await body.allReady;
    }

    responseHeaders.set("Content-Type", "text/html");

    return new Response(body, { headers: responseHeaders, status });
}
