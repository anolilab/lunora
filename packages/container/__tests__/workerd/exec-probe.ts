import { DurableObject } from "cloudflare:workers";

/**
 * Stands in for a container DO on the exec path: exposes the same
 * `lunoraExec(request)` RPC `LunoraContainer` does (which cannot boot here
 * without a container runtime), so `handle.exec` crosses a REAL RPC boundary —
 * the one that refuses to serialize an AbortSignal. Answers the exec contract
 * after `args[0]` milliseconds.
 */
class ExecProbe extends DurableObject {
    /** Calls served — state that makes this a real instance, not a free function. */
    private served = 0;

    public async lunoraExec(request: Request): Promise<Response> {
        const { args, command } = await request.json<{ args: string[]; command: string }>();

        await new Promise((resolve) => {
            setTimeout(resolve, Number(args[0] ?? 0));
        });

        this.served += 1;

        return Response.json({ code: 0, stderr: "", stdout: `${command} ${request.method} ${new URL(request.url).pathname} #${String(this.served)}` });
    }
}

export default ExecProbe;
