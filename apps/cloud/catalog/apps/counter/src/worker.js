// Demo only: answers every request with a greeting and a count held in memory.
let count = 0;

export default {
    async fetch(request, env) {
        count += 1;

        return new Response(`${env.GREETING ?? "Hello"} from counter, request ${String(count)}\n`, {
            headers: { "content-type": "text/plain; charset=utf-8" },
        });
    },
};
