import { LunoraError } from "lunorash/errors";
import { rateLimit } from "lunorash/ratelimit";

import type { Id } from "#lunora/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "#lunora/_generated/server.js";
import { internalMutation, mutation, query, v } from "#lunora/_generated/server.js";

import { authorizeProject } from "./authz";
import { limiter, limitKey } from "./limits";

/** Cap on a rendered transcript, so an old thread cannot return unboundedly. */
const MAX_MESSAGES = 400;

/** How much of an opening prompt becomes the thread title. */
const TITLE_LENGTH = 60;

/**
 * The agent thread a chat's turns run on.
 *
 * Derived from the chat id rather than taken from the client: `threadKey` is what
 * `agents:agentMessages` reads by, so a caller-chosen key would let one chat
 * attach to another's transcript.
 */
const threadKeyOf = (chatId: Id<"chats">): string => `chat:${chatId}`;

/**
 * Resolve a chat inside an ALREADY-authorized project.
 *
 * `chats` is `.shardBy("projectId")`, so the shard the read lands on is decided
 * by the project id — which `authorizeProject` has already vetted. A chat id
 * belonging to a different project simply does not exist in this shard, and this
 * turns that into a 404 rather than a silently empty transcript.
 */
const resolveChat = async (ctx: MutationCtx | QueryCtx, chatId: Id<"chats">, projectId: string): Promise<void> => {
    const chat = await ctx.db.get(chatId);

    if (chat?.projectId !== projectId) {
        throw new LunoraError("NOT_FOUND", "No such chat");
    }
};

/** The chats belonging to a project, newest first. */
export const list = query.input({ projectId: v.string().meta({ schema: { maxLength: 64 } }) }).query(async ({ args, ctx }) => {
    // The shard key is the tenancy boundary here, so it is vetted before it
    // routes anything: an authenticated caller naming somebody else's project id
    // gets a 404, not that project's chat titles.
    const { projectId } = await authorizeProject(ctx, args.projectId);

    const chats = await ctx.db
        .query("chats")
        .withIndex("by_project_created", (q) => q.eq("projectId", projectId))
        .order("desc")
        .take(50);

    return { chats };
});

/**
 * A chat's transcript.
 *
 * This is the query the workbench subscribes to for the user's own turns, and the
 * agent's durable thread (`agents:agentMessages`, keyed by {@link threadKeyOf})
 * carries the assistant side — two subscriptions, no bespoke stream and no SSE
 * endpoint to operate (plan 335 §D18).
 *
 * Ordered DESCENDING before the cap: `ctx.db` reads an index ascending, so a
 * plain `.take(MAX_MESSAGES)` would keep the OLDEST turns of a long thread and
 * render a transcript that stops before the conversation the user is having. The
 * page is reversed back to chronological order for display.
 */
export const messages = query.input({ chatId: v.id("chats"), projectId: v.string().meta({ schema: { maxLength: 64 } }) }).query(async ({ args, ctx }) => {
    const { projectId } = await authorizeProject(ctx, args.projectId);

    await resolveChat(ctx, args.chatId, projectId);

    const newestFirst = await ctx.db
        .query("messages")
        .withIndex("by_chat_created", (q) => q.eq("chatId", args.chatId))
        .order("desc")
        .take(MAX_MESSAGES);

    return { messages: newestFirst.toReversed(), threadKey: threadKeyOf(args.chatId) };
});

/**
 * Start a chat, record its opening turn, and hand it to the build agent.
 *
 * The rows and the dispatch are one mutation deliberately — a chat with no first
 * message is a thread the UI renders as empty, and a persisted prompt with no run
 * behind it is a submission that looks accepted and is never answered.
 *
 * `ctx.agents.builder.run(...)` only creates the workflow instance; the loop's
 * own bootstrap claims the thread. Every value it receives is server-resolved:
 * the trusted `projectId` from {@link authorizeProject}, the `chatId` this
 * mutation just minted, the trimmed prompt, and the verified owner (which makes
 * the agent's own thread queries owner-gated too).
 */
export const start = mutation
    .input({ projectId: v.string().meta({ schema: { maxLength: 64 } }), prompt: v.string().meta({ schema: { maxLength: 8000 } }) })
    .use(rateLimit(limiter, "chat", { key: limitKey }))
    .mutation(async ({ args, ctx }) => {
        const { ownerId, projectId } = await authorizeProject(ctx, args.projectId);

        const prompt = args.prompt.trim();

        if (prompt.length === 0) {
            throw new LunoraError("BAD_REQUEST", "A chat needs an opening prompt");
        }

        const now = Date.now();
        const title = prompt.length > TITLE_LENGTH ? `${prompt.slice(0, TITLE_LENGTH)}…` : prompt;

        const chatId = await ctx.db.insert("chats", { createdAt: now, projectId, title });

        await ctx.db.insert("messages", { chatId, content: prompt, createdAt: now, projectId, role: "user" });

        const { id: runId } = await ctx.agents.builder.run({ input: prompt, owner: ownerId, threadKey: threadKeyOf(chatId), title });

        ctx.log.info("chat.start", { chatId, projectId, runId });

        return { chatId, title };
    });

/** Append a turn to an existing chat and run the agent against it. */
export const send = mutation
    .input({
        chatId: v.id("chats"),
        projectId: v.string().meta({ schema: { maxLength: 64 } }),
        prompt: v.string().meta({ schema: { maxLength: 8000 } }),
    })
    .use(rateLimit(limiter, "chat", { key: limitKey }))
    .mutation(async ({ args, ctx }) => {
        const { ownerId, projectId } = await authorizeProject(ctx, args.projectId);

        await resolveChat(ctx, args.chatId, projectId);

        const prompt = args.prompt.trim();

        if (prompt.length === 0) {
            throw new LunoraError("BAD_REQUEST", "A message needs text");
        }

        const id = await ctx.db.insert("messages", {
            chatId: args.chatId,
            content: prompt,
            createdAt: Date.now(),
            projectId,
            role: "user",
        });

        // A second prompt while a build is still running parks behind it — the
        // agent declares `onConcurrentRun: "queue"`, so a follow-up is answered
        // in order rather than rejected.
        const { id: runId } = await ctx.agents.builder.run({ input: prompt, owner: ownerId, threadKey: threadKeyOf(args.chatId) });

        ctx.log.info("chat.send", { chatId: args.chatId, projectId, runId });

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
