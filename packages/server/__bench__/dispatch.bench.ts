import { bench, describe } from "vitest";

import type { Id } from "../src/index.js";
import { mutation, query, v } from "../src/index.js";

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
        text: v.string(),
        kind: v.union(v.literal("text"), v.literal("image")),
        tags: v.optional(v.array(v.string())),
    },
    handler: (_context, args) => args,
});

const heavyMutation = mutation({
    args: {
        user: v.object({
            id: v.id("users"),
            email: v.string(),
            name: v.string(),
            age: v.number(),
            roles: v.array(v.union(v.literal("admin"), v.literal("user"))),
        }),
        metadata: v.record(v.string(), v.string()),
        notes: v.optional(v.string()),
    },
    handler: (_context, args) => args,
});

const sampleContext = {};

const smallArgs = { id: "users:abc" as Id<"users"> };
const messageArgs = {
    channelId: "channels:c1" as Id<"channels">,
    text: "hello",
    kind: "text" as const,
    tags: ["urgent"],
};
const heavyArgs = {
    user: {
        id: "users:a" as Id<"users">,
        email: "a@b.c",
        name: "alice",
        age: 30,
        roles: ["admin" as const, "user" as const],
    },
    metadata: { ip: "127.0.0.1", agent: "bench" },
};

describe("query/mutation dispatch", () => {
    bench("empty args", () => {
        emptyArgsQuery.handler(sampleContext, {});
    });

    bench("single id arg", () => {
        smallArgsQuery.handler(sampleContext, smallArgs);
    });

    bench("4-field mutation with optional + union", () => {
        messageMutation.handler(sampleContext, messageArgs);
    });

    bench("nested object + array + record + optional", () => {
        heavyMutation.handler(sampleContext, heavyArgs);
    });
});

describe("validation failure path", () => {
    bench("throws ValidationError on bad arg type", () => {
        try {
            smallArgsQuery.handler(sampleContext, { id: 123 } as unknown as { id: Id<"users"> });
        } catch {
            /* expected — measuring the rejection cost */
        }
    });
});
