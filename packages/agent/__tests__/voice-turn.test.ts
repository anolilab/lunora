import { describe, expect, it, vi } from "vitest";

import { defineAgent } from "../src/define-agent";
import { agentBindingName, voiceBindingName, voiceClassName } from "../src/naming";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentFunctionReference, AgentRunFunction, AgentStreamGenerate } from "../src/types";
import type { VoiceServerFrame, VoiceSynthesize } from "../src/voice-turn";
import { runVoiceTurn } from "../src/voice-turn";

/** An in-memory model of the shared agent thread functions the voice turn dispatches to. */
const createThreadStore = (): { calls: { args: Record<string, unknown>; path: string }[]; run: AgentRunFunction } => {
    const messages: { content: string; role: string }[] = [];
    const calls: { args: Record<string, unknown>; path: string }[] = [];

    const run: AgentRunFunction = async (reference: AgentFunctionReference, args?: Record<string, unknown>) => {
        const path = reference["__lunoraRef"];

        calls.push({ args: args ?? {}, path });

        if (path === DEFAULT_AGENT_FUNCTION_PATHS.appendMessage) {
            messages.push({ content: (args?.["content"] as string | undefined) ?? "", role: (args?.["role"] as string | undefined) ?? "" });

            return { seq: messages.length };
        }

        if (path === DEFAULT_AGENT_FUNCTION_PATHS.listMessages) {
            return messages.map((message, index) => {
                return { ...message, seq: index };
            });
        }

        if (path === DEFAULT_AGENT_FUNCTION_PATHS.ensureThread) {
            return { created: true };
        }

        return undefined;
    };

    return { calls, run };
};

/** A scripted streaming seam that tees `deltas` then resolves the joined text. */
const scriptedStream =
    (deltas: string[]): AgentStreamGenerate =>
    async (_options, onDelta) => {
        for (const delta of deltas) {
            onDelta(delta);
        }

        return { text: deltas.join(""), toolCalls: [] };
    };

const agent = defineAgent({ instructions: "Be brief.", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", voice: {} });
const paths = DEFAULT_AGENT_FUNCTION_PATHS;
const env: Record<string, unknown> = {};

describe("voice naming", () => {
    it("derives the voice DO binding + class names, distinct from the workflow", () => {
        expect(voiceBindingName("support")).toBe("VOICE_SUPPORT");
        expect(voiceBindingName("supportBot")).toBe("VOICE_SUPPORT_BOT");
        expect(voiceClassName("support")).toBe("SupportVoiceDO");
        // The voice DO name must never collide with the agent's WorkflowEntrypoint.
        expect(voiceBindingName("support")).not.toBe(agentBindingName("support"));
    });
});

describe(runVoiceTurn, () => {
    it("transcribes, persists both turns, and streams sentence-chunked TTS", async () => {
        const store = createThreadStore();
        const frames: VoiceServerFrame[] = [];
        const audioChunks: Uint8Array[] = [];
        const synthesize = vi.fn<VoiceSynthesize>(async (text) => new Uint8Array([text.length]));

        const result = await runVoiceTurn({
            agent,
            connectionId: "c1",
            env,
            exportName: "support",
            paths,
            pcm: new Uint8Array([1, 2, 3, 4]),
            run: store.run,
            send: (frame) => frames.push(frame),
            sendAudio: (bytes) => audioChunks.push(bytes),
            signal: new AbortController().signal,
            streamGenerate: scriptedStream(["Hello there. ", "How can I help", " you today?"]),
            synthesize,
            threadKey: "t1",
            transcribe: async () => "what is the weather",
            turn: 0,
        });

        expect(result).toStrictEqual({ assistantText: "Hello there. How can I help you today?", interrupted: false, userText: "what is the weather" });

        // Two complete sentences synthesized (the trailing one has a terminal `?`).
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect(synthesize).toHaveBeenNthCalledWith(1, "Hello there.", expect.anything());
        expect(synthesize).toHaveBeenNthCalledWith(2, "How can I help you today?", expect.anything());
        expect(audioChunks).toHaveLength(2);

        // Persisted the user turn then the assistant turn, idempotently keyed.
        const appends = store.calls.filter((call) => call.path === paths.appendMessage);

        expect(appends).toHaveLength(2);
        expect(appends[0]?.args).toMatchObject({ content: "what is the weather", messageKey: "voice:c1:0:user", role: "user" });
        expect(appends[1]?.args).toMatchObject({ content: "Hello there. How can I help you today?", messageKey: "voice:c1:0:assistant", role: "assistant" });

        // Owner-gated bootstrap ran, and the client saw transcript + done frames.
        expect(store.calls.some((call) => call.path === paths.ensureThread)).toBe(true);
        expect(frames).toContainEqual({ text: "what is the weather", type: "user_transcript" });
        expect(frames).toContainEqual({ text: "Hello there. How can I help you today?", type: "assistant_done" });
    });

    it("passes the socket identity through as the thread owner", async () => {
        const store = createThreadStore();

        await runVoiceTurn({
            agent,
            connectionId: "c1",
            env,
            exportName: "support",
            owner: "user-42",
            paths,
            run: store.run,
            send: () => {},
            sendAudio: () => {},
            signal: new AbortController().signal,
            streamGenerate: scriptedStream(["Hi."]),
            synthesize: async () => new Uint8Array(),
            text: "hello",
            threadKey: "t1",
            transcribe: async () => "unused",
            turn: 0,
        });

        const ensure = store.calls.find((call) => call.path === paths.ensureThread);

        expect(ensure?.args).toMatchObject({ agent: "support", key: "t1", owner: "user-42" });
    });

    it("short-circuits on a silent utterance without persisting", async () => {
        const store = createThreadStore();
        const synthesize = vi.fn<VoiceSynthesize>();

        const result = await runVoiceTurn({
            agent,
            connectionId: "c1",
            env,
            exportName: "support",
            paths,
            pcm: new Uint8Array([0, 0]),
            run: store.run,
            send: () => {},
            sendAudio: () => {},
            signal: new AbortController().signal,
            streamGenerate: scriptedStream(["ignored"]),
            synthesize,
            threadKey: "t1",
            transcribe: async () => "   ",
            turn: 0,
        });

        expect(result).toStrictEqual({ assistantText: "", interrupted: false, userText: "" });
        expect(store.calls).toHaveLength(0);
        expect(synthesize).not.toHaveBeenCalled();
    });

    it("stops teeing output and reports interrupted on a barge-in", async () => {
        const store = createThreadStore();
        const frames: VoiceServerFrame[] = [];
        const controller = new AbortController();
        const synthesize = vi.fn<VoiceSynthesize>(async () => new Uint8Array([1]));

        // Abort as soon as the first delta arrives — later deltas must be dropped.
        const streamGenerate: AgentStreamGenerate = async (_options, onDelta) => {
            onDelta("First sentence. ");
            controller.abort();
            onDelta("Second sentence. ");

            return { text: "First sentence. Second sentence. ", toolCalls: [] };
        };

        const result = await runVoiceTurn({
            agent,
            connectionId: "c1",
            env,
            exportName: "support",
            paths,
            run: store.run,
            send: (frame) => frames.push(frame),
            sendAudio: () => {},
            signal: controller.signal,
            streamGenerate,
            synthesize,
            text: "hello",
            threadKey: "t1",
            transcribe: async () => "unused",
            turn: 0,
        });

        expect(result.interrupted).toBe(true);
        expect(frames).toContainEqual({ type: "interrupted" });
        expect(frames).not.toContainEqual({ text: "Second sentence. ", type: "assistant_delta" });
        // The barge-in cancels pending TTS: the post-abort sentence never synthesizes.
        expect(synthesize).not.toHaveBeenCalledWith("Second sentence.", expect.anything());
    });

    it("persists only the spoken (flushed) prefix on a barge-in, not the enqueued text", async () => {
        const store = createThreadStore();
        const audioChunks: Uint8Array[] = [];
        const controller = new AbortController();
        // Generation outpaces synthesis: all three sentences are enqueued while
        // only the first is played, then the user barges in over sentence one.
        const synthesize = vi.fn<VoiceSynthesize>(async () => new Uint8Array([1]));

        const result = await runVoiceTurn({
            agent,
            connectionId: "c1",
            env,
            exportName: "support",
            paths,
            run: store.run,
            send: () => {},
            sendAudio: (bytes) => {
                audioChunks.push(bytes);
                // Barge-in right after the first sentence's frame is flushed.
                controller.abort();
            },
            signal: controller.signal,
            streamGenerate: scriptedStream(["S1. ", "S2. ", "S3. "]),
            synthesize,
            text: "hello",
            threadKey: "t1",
            transcribe: async () => "unused",
            turn: 0,
        });

        expect(result.interrupted).toBe(true);
        // Only the sentence whose audio was actually flushed is persisted — the
        // later enqueued-but-unheard sentences are excluded.
        expect(result.assistantText).toBe("S1.");
        expect(audioChunks).toHaveLength(1);
        expect(synthesize).toHaveBeenCalledTimes(1);

        const appends = store.calls.filter((call) => call.path === paths.appendMessage);

        expect(appends.at(-1)?.args).toMatchObject({ content: "S1.", role: "assistant" });
    });

    it("resets the thread status to idle when the model turn throws", async () => {
        const store = createThreadStore();
        const boom: AgentStreamGenerate = async () => {
            throw new Error("provider unavailable");
        };

        await expect(
            runVoiceTurn({
                agent,
                connectionId: "c1",
                env,
                exportName: "support",
                paths,
                run: store.run,
                send: () => {},
                sendAudio: () => {},
                signal: new AbortController().signal,
                streamGenerate: boom,
                synthesize: async () => new Uint8Array(),
                text: "hello",
                threadKey: "t1",
                transcribe: async () => "unused",
                turn: 0,
            }),
        ).rejects.toThrow("provider unavailable");

        // The shared thread must not be left wedged at status:"running".
        const patches = store.calls.filter((call) => call.path === paths.patchThread);

        expect(patches.at(-1)?.args).toMatchObject({ key: "t1", status: "idle" });
    });
});
