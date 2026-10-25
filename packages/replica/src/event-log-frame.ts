/**
 * The signed frame for one `EventLogDO` request: the method, the path and query,
 * then the body. The signature covers the frame rather than the body alone, so a
 * GET (whose body is empty) is authenticated too, and a captured signature
 * cannot be replayed against another route.
 *
 * The body is last because it may contain newlines; the three fields before it
 * never do. The prefix names the channel, so a frame signed for another DO's
 * control channel cannot verify here.
 */
export const eventLogFrame = (method: string, url: URL, body: string): string =>
    ["lunora.event-log.v1", method, `${url.pathname}${url.search}`, body].join("\n");
