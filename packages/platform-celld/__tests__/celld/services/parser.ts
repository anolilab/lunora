/**
 * The service the services check binds: a `fetch` handler that answers with
 * the method and path it was called with, and a `WorkerEntrypoint` whose
 * method the app calls over RPC.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

class TckMath extends WorkerEntrypoint {
    // eslint-disable-next-line class-methods-use-this -- an RPC method lives on the entrypoint the binding names
    public double(value: number): number {
        return value * 2;
    }
}

export { TckMath };

// A Workers entry module: the runtime reads the handlers off the default export
// and each entrypoint class by name, so this file has to mix both.
export default {
    async fetch(request: Request): Promise<Response> {
        return new Response(`parsed ${request.method} ${new URL(request.url).pathname}`);
    },
};
