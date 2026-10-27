/**
 * The exact string a shard-registry request is signed over, shared by the
 * registry Durable Object (which verifies it) and both of its clients (the
 * worker and the shard, which sign it) so the three cannot disagree.
 *
 * The method and the path-plus-query are part of the frame, not just the body:
 * `GET /list` and `GET /snapshot` carry no body, so a body-only signature would
 * be one fixed value that authenticates every read of every table.
 *
 * Like the other `shared/` files this is inlined by the bundler — keep it free
 * of imports.
 */
const shardRegistryFrame = (method: string, url: string, body: string): string => {
    const { pathname, search } = new URL(url);

    return `${method.toUpperCase()} ${pathname}${search}\n${body}`;
};

export { shardRegistryFrame };
