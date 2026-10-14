/**
 * Example durable workflow: a per-channel welcome sequence.
 *
 * Start it from a mutation/action with `context.workflows.get("channelWelcome")
 * .create({ params: { channelId } })` (the typed `context.workflows` handle is
 * codegen-wired once this file exists; see `channels.create` for the call site).
 * It posts a greeting, waits a minute, then posts a
 * follow-up tip. Each `context.step.do` is a durable, memoized, retried step and the
 * `context.step.sleep` survives Worker evictions and redeploys — the whole sequence
 * resumes exactly where it left off. Every `context.run` targets the channel's shard
 * via `shardKey`, so the writes land on the same DO that owns the channel.
 */
import { defineWorkflow } from "@lunora/workflow";

import { api } from "./_generated/api.js";
import type { Id } from "./_generated/server.js";

// Fixed namespace for deriving the welcome posts' deterministic ids (any UUID).
const WELCOME_NS = "9f1a6e9c-2b7d-4e1a-8c3f-2d5e7a1b4c6d";

/**
 * Deterministic UUIDv5 (RFC 4122 §4.3) from a name. The welcome posts need a
 * STABLE id per channel so an at-least-once `step.do` retry dedupes instead of
 * double-posting — but a client-supplied row id must be a real UUID (the
 * `ctx.db.insert` contract rejects a prefixed id like `welcome-greet:…`), so we
 * hash the name into one rather than prefixing.
 */
const uuidV5 = async (name: string): Promise<string> => {
    const nsHex = WELCOME_NS.replaceAll("-", "");
    const ns = new Uint8Array(16);

    for (let index = 0; index < 16; index += 1) {
        ns[index] = Number.parseInt(nsHex.slice(index * 2, index * 2 + 2), 16);
    }

    const nameBytes = new TextEncoder().encode(name);
    const input = new Uint8Array(ns.length + nameBytes.length);
    input.set(ns);
    input.set(nameBytes, ns.length);

    // eslint-disable-next-line sonarjs/hashing -- SHA-1 is mandated by RFC 4122 §4.3 for UUIDv5; this is deterministic id derivation, not a security/integrity context.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
    // Read/written through a DataView rather than by index: `getUint8` is typed
    // `number`, where `digest[6]` widens to `number | undefined` under
    // `noUncheckedIndexedAccess` (which `tsconfig.generated.json` turns on).
    const view = new DataView(digest.buffer);

    // eslint-disable-next-line no-bitwise -- RFC 4122 requires setting the version (5) and variant (10) bits.
    view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x50);
    // eslint-disable-next-line no-bitwise -- variant bits per RFC 4122 §4.1.1.
    view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);

    const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export const channelWelcome = defineWorkflow<{ channelId: Id<"channels"> }, { channelId: Id<"channels">; posted: number }>({
    handler: async (context) => {
        const { channelId } = context.params;

        // The E2E suite asserts exact, deterministic channel contents (e.g. the
        // sharding spec counts only its own sends), so skip the welcome posts there.
        if (context.env.LUNORA_E2E === "true") {
            return { channelId, posted: 0 };
        }

        // `createdAt` is stamped inside the durable step (which runs once and
        // memoizes its result) — `messages.send` is a deterministic mutation that
        // takes the timestamp as an arg rather than calling `Date.now()` itself.
        // The deterministic-UUID `id` (clientId) makes the send idempotent: `step.do`
        // is at-least-once, so a retry after a partial success would otherwise
        // double-post — keying the row by a stable per-channel UUID dedupes it.
        const greetId = await uuidV5(`welcome-greet:${channelId}`);
        const tipId = await uuidV5(`welcome-tip:${channelId}`);

        await context.step.do("greet", () =>
            context.run(
                api.messages.send,
                { channelId, createdAt: Date.now(), id: greetId, text: "👋 Welcome to the channel! Say hi to get started." },
                { shardKey: channelId },
            ),
        );

        // Durable wait — the workflow hibernates here and resumes after a minute.
        await context.step.sleep("settle", "1 minute");

        await context.step.do("tips", () =>
            context.run(
                api.messages.send,
                { channelId, createdAt: Date.now(), id: tipId, text: "Tip: messages stream in real time over a WebSocket subscription." },
                { shardKey: channelId },
            ),
        );

        context.log.info("channel welcome sequence complete", { channelId });

        return { channelId, posted: 2 };
    },
});
