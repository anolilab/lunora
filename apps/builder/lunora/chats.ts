import { LunoraError } from "lunorash/errors";
import { rateLimit } from "lunorash/ratelimit";

import { internalMutation, mutation, query, v } from "#lunora/_generated/server.js";

import { limiter, limitKey } from "./limits";

/** Cap on a rendered transcript, so an old thread cannot return unboundedly. */
const MAX_MESSAGES = 400;

/** How much of an opening prompt becomes the thread title. */
const TITLE_LENGTH = 60;

/** The chats belonging to a project, newest first. */
export const list = query.input({ projectId: v.string().meta({ schema: { maxLength: 64 } }) }).query(async ({ args, ctx }) => {
    const chats = await ctx.db
        .query("chats")
        .withIndex("by_project_created", (q) => q.eq("projectId", args.projectId))
        .order("desc")
        .take(50);

    return { chats };
});

/**
 * A chat's transcript.
 *
 * This is the query the workbench subscribes to, so it is also the streaming
 * transport (plan 335 §D18): the agent appends rows, and every connected client
 * re-renders. There is no second protocol and no SSE endpoint to operate.
 */
export const messages = query.input({ chatId: v.id("chats"), projectId: v.string().meta({ schema: { maxLength: 64 } }) }).query(async ({ args, ctx }) => {
    const rows = await ctx.db
        .query("messages")
        .withIndex("by_chat_created", (q) => q.eq("chatId", args.chatId))
        .take(MAX_MESSAGES);

    return { messages: rows };
});

/**
 * Start a chat and record its opening turn.
 *
 * Both rows are written in one mutation deliberately — a chat with no first
 * message is a thread the UI renders as empty and the agent has nothing to
 * answer, so the two are one logical write.
 */
export const start = mutation
    .input({ projectId: v.string().meta({ schema: { maxLength: 64 } }), prompt: v.string().meta({ schema: { maxLength: 8000 } }) })
    .use(rateLimit(limiter, "chat", { key: limitKey }))
    .mutation(async ({ args, ctx }) => {
        const prompt = args.prompt.trim();

        if (prompt.length === 0) {
            throw new LunoraError("BAD_REQUEST", "A chat needs an opening prompt");
        }

        const now = Date.now();
        const title = prompt.length > TITLE_LENGTH ? `${prompt.slice(0, TITLE_LENGTH)}…` : prompt;

        const chatId = await ctx.db.insert("chats", { createdAt: now, projectId: args.projectId, title });

        await ctx.db.insert("messages", { chatId, content: prompt, createdAt: now, projectId: args.projectId, role: "user" });

        ctx.log.info("chat.start", { chatId, projectId: args.projectId });

        return { chatId, title };
    });

/** Append a turn to an existing chat. */
export const send = mutation
    .input({ chatId: v.id("chats"), projectId: v.string().meta({ schema: { maxLength: 64 } }), prompt: v.string().meta({ schema: { maxLength: 8000 } }) })
    .use(rateLimit(limiter, "chat", { key: limitKey }))
    .mutation(async ({ args, ctx }) => {
        const prompt = args.prompt.trim();

        if (prompt.length === 0) {
            throw new LunoraError("BAD_REQUEST", "A message needs text");
        }

        const id = await ctx.db.insert("messages", {
            chatId: args.chatId,
            content: prompt,
            createdAt: Date.now(),
            projectId: args.projectId,
            role: "user",
        });

        ctx.log.info("chat.send", { chatId: args.chatId, projectId: args.projectId });

        return { id };
    });

/**
 * Append an assistant or tool turn. Internal: only the agent writes these, and
 * exposing it publicly would let any client forge the assistant's side of a
 * conversation.
 */
export const appendInternal = internalMutation
    .input({
        chatId: v.id("chats"),
        content: v.string(),
        projectId: v.string(),
        role: v.union(v.literal("assistant"), v.literal("tool")),
        tokens: v.optional(v.number()),
    })
    .mutation(async ({ args, ctx }) => {
        const id = await ctx.db.insert("messages", {
            chatId: args.chatId,
            content: args.content,
            createdAt: Date.now(),
            projectId: args.projectId,
            role: args.role,
            ...(args.tokens === undefined ? {} : { tokens: args.tokens }),
        });

        return { id };
    });
