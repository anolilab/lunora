import { httpRoute, v } from "@lunora/server";

// A GET route with typed search params and a declared `.output()` schema —
// covers query-parameter + response-schema OpenAPI emission.
export const listMessages = httpRoute
    .get("/api/messages")
    .searchParams({ channelId: v.id("channels"), limit: v.optional(v.number()) })
    .output(v.object({ channelId: v.id("channels"), limit: v.number() }))
    .handler(async ({ searchParams }) => ({ channelId: searchParams.channelId, limit: searchParams.limit ?? 50 }));

// A POST route with a path param and a JSON body — covers path-parameter +
// requestBody OpenAPI emission, plus a multi-verb path item.
export const sendMessage = httpRoute
    .post("/api/messages/:channelId")
    .params({ channelId: v.id("channels") })
    .body({ text: v.string(), kind: v.union(v.literal("text"), v.literal("image")) })
    .handler(async ({ body, params }) => ({ channelId: params.channelId, kind: body.kind, text: body.text }));
