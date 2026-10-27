/**
 * The signed frame for one `EventLogDO` request: the instance, the method, the path and query,
 * then the body. The signature covers the frame rather than the body alone, so a GET (whose body
 * is empty) is authenticated too, and a captured signature cannot be replayed against another route.
 *
 * `instance` is the `DurableObjectId` string of the object the request is for. Every instance in a
 * worker shares the relay secret, so the signature must name the object it was made for: the object
 * verifies with its own id, and a frame signed for another instance cannot verify here.
 *
 * The body is last because it may contain newlines; the fields before it never do. The prefix names
 * the channel, so a frame signed for another DO's control channel cannot verify here.
 */
export const eventLogFrame = (instance: string, method: string, url: URL, body: string): string =>
    ["lunora.event-log.v2", instance, method, `${url.pathname}${url.search}`, body].join("\n");
