// TEMPORARY diagnostic entry (never merge): exposes per-instance timing headers
// to tell a per-request cold start apart from slow in-handler work on Netlify.
const instanceId = Math.random().toString(36).slice(2, 10);
const evalAt = performance.now();
let count = 0;
const caught: string[] = [];

for (const event of ["unhandledRejection", "uncaughtException"] as const) {
    process.on(event, (error: unknown) => {
        console.error(`[diag] ${event} on instance ${instanceId}:`, error);
        caught.push(
            `${event}#${count}: ${String((error as Error)?.stack ?? error)
                .replaceAll(/\s+/g, " ")
                .slice(0, 700)}`,
        );
    });
}

process.on("beforeExit", (code) => console.error(`[diag] beforeExit ${code} on instance ${instanceId}`));
process.on("exit", (code) => console.error(`[diag] exit ${code} on instance ${instanceId}`));

const runtimeInfo = [
    `node=${process.version}`,
    `mem=${process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? "?"}`,
    `exec=${process.env.AWS_EXECUTION_ENV ?? "?"}`,
    `init=${process.env.AWS_LAMBDA_INITIALIZATION_TYPE ?? "?"}`,
    `region=${process.env.AWS_REGION ?? "?"}`,
    `pid=${process.pid}`,
].join(" ");
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
        headers.set("x-diag-eval-at-ms", String(Math.round(evalAt)));
        headers.set("x-diag-process-uptime-s", process.uptime().toFixed(2));
        headers.set("x-diag-runtime", runtimeInfo);
        headers.set("x-diag-caught-count", String(caught.length));
        caught.slice(-2).forEach((entry, index) => headers.set(`x-diag-caught-${index}`, encodeURIComponent(entry)));
        headers.set("x-diag-pending", process.getActiveResourcesInfo().join(","));

        return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
    },
};
