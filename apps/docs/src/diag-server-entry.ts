// TEMPORARY diagnostic entry (never merge): exposes per-instance timing headers
// to tell a per-request cold start apart from slow in-handler work on Netlify.
const instanceId = Math.random().toString(36).slice(2, 10);
const evalAt = performance.now();
let count = 0;
let bootMs = -1;

const handlerPromise = import("@tanstack/react-start/server-entry").then((module_) => {
    bootMs = Math.round(performance.now() - evalAt);

    return module_.default;
});

export default {
    async fetch(request: Request): Promise<Response> {
        const start = performance.now();

        count += 1;

        const handler = await handlerPromise;
        const response = await handler.fetch(request);
        const headers = new Headers(response.headers);

        headers.set("x-diag-instance", instanceId);
        headers.set("x-diag-count", String(count));
        headers.set("x-diag-boot-ms", String(bootMs));
        headers.set("x-diag-handler-ms", String(Math.round(performance.now() - start)));
        headers.set("x-diag-uptime-ms", String(Math.round(performance.now())));

        return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
    },
};
