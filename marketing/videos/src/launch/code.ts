/** Code shown in the launch video. Kept in one place so snippets stay in sync. */

export const SCHEMA_CODE = `import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
  messages: defineTable({
    author: v.string(),
    body: v.string(),
    ts: v.number(),
  }).index("by_ts", ["ts"]),
});`;

export const FUNCTIONS_CODE = `import { query, mutation, v } from "./_generated/server";

export const list = query.query(async ({ ctx }) =>
  ctx.db.query("messages").order("desc").take(50),
);

export const send = mutation
  .input({ author: v.string(), body: v.string() })
  .mutation(async ({ ctx, args }) => {
    await ctx.db.insert("messages", { ...args, ts: Date.now() });
  });`;

export const SCALE_CODE = `cursors: defineTable({
  roomId: v.string(),
  x: v.number(),
  y: v.number(),
})
  .shardBy("roomId")
  .global()
  .index("by_room", ["roomId"]),`;

export const CLIENT_CODE = `import { useQuery, useMutation } from "@lunora/react";
import { api } from "../lunora/_generated/api";

function Chat() {
  const messages = useQuery(api.messages.list) ?? [];
  const send = useMutation(api.messages.send);
  // messages is fully typed — re-renders live when anyone sends.
}`;
