import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
    VERB: string;
}

/** An RPC service: each public method is callable as `ctx.services.gateway.<method>()`. */
export class Gateway extends WorkerEntrypoint<Env> {
    public complete(prompt: string): string {
        return `${this.env.VERB} ${prompt}`;
    }
}

export default {
    fetch: (): Response => new Response("Reach this Worker through its RPC entrypoint.", { status: 404 }),
};
