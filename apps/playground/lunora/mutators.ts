import { defineMutator, v } from "lunorash/server";

/**
 * Custom mutator — the client runs `client` optimistically against its local
 * TanStack collections, the shard DO runs `server` as the authoritative
 * linearization point, and the resulting `__cdc_log` rows poke back to every
 * subscriber. The client rebase is free (TanStack re-derives pending overlays).
 */
export const sendMessage = defineMutator({
    args: { channelId: v.id("channels"), text: v.string(), userId: v.id("users") },
    client: () => {
        // Optimistic overlay is applied by the binding; nothing extra to do here.
    },
    server: (_ctx, arguments_) => {
        return { channelId: arguments_.channelId, text: arguments_.text };
    },
});
