import { bench, describe } from "vitest";

import type { Id } from "../src/index";
import { mutation, query, v } from "../src/index";

/**
 * `query()`/`mutation()`/`action()` wrap the user's handler with the args
 * validator. Every RPC pays this cost on the way in. The bench measures the
 * full registered call (`registered.handler(ctx, args)`), not just the raw
 * validator — that way the wrap overhead and the error-path mapping stay
 * visible if either regresses.
 */

const emptyArgsQuery = query({
    args: {},
    handler: () => 42,
});

const smallArgsQuery = query({
    args: { id: v.id("users") },
    handler: (_context, args) => args.id,
});

const messageMutation = mutation({
    args: {
        channelId: v.id("channels"),
        kind: v.union(v.literal("text"), v.literal("image")),
        tags: v.optional(v.array(v.string())),
        text: v.string(),
    },
    handler: (_context, args) => args,
});

const heavyMutation = mutation({
    args: {
        metadata: v.record(v.string(), v.string()),
        notes: v.optional(v.string()),
        user: v.object({
            age: v.number(),
            email: v.string(),
            id: v.id("users"),
            name: v.string(),
            roles: v.array(v.union(v.literal("admin"), v.literal("user"))),
        }),
    },
    handler: (_context, args) => args,
});

const sampleContext = {};

const smallArgs = { id: "users:abc" as Id<"users"> };
const messageArgs = {
    channelId: "channels:c1" as Id<"channels">,
    kind: "text" as const,
    tags: ["urgent"],
    text: "hello",
};
const heavyArgs = {
    metadata: { agent: "bench", ip: "127.0.0.1" },
    user: {
        age: 30,
        email: "a@b.c",
        id: "users:a" as Id<"users">,
        name: "alice",
        roles: ["admin" as const, "user" as const],
    },
};

describe("query/mutation dispatch", () => {
    bench("empty args", async () => {
        await emptyArgsQuery.handler(sampleContext, {});
    });

    bench("single id arg", async () => {
        await smallArgsQuery.handler(sampleContext, smallArgs);
    });

    bench("4-field mutation with optional + union", async () => {
        await messageMutation.handler(sampleContext, messageArgs);
    });

    bench("nested object + array + record + optional", async () => {
        await heavyMutation.handler(sampleContext, heavyArgs);
    });
});

describe("validation failure path", () => {
    bench("throws ValidationError on bad arg type", async () => {
        try {
            await smallArgsQuery.handler(sampleContext, { id: 123 } as unknown as { id: Id<"users"> });
        } catch {
            /* expected — measuring the rejection cost */
        }
    });
});
