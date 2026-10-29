/** A fetch service: the app calls it as `ctx.services.parser.fetch(…)`. */
export default {
    fetch: (request: Request): Response => Response.json({ parsed: new URL(request.url).pathname }),
};
