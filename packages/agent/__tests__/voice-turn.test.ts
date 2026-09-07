import { describe, expect, it, vi } from "vitest";

import { encodeIdentityHeader } from "../../../shared/identity-header";
import { defineAgent } from "../src/define-agent";
import { agentBindingName, voiceBindingName, voiceClassName } from "../src/naming";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentFunctionReference, AgentMessageRow, AgentRunFunction, AgentStreamGenerate } from "../src/types";
import type { VoiceServerFrame, VoiceSynthesize } from "../src/voice-turn";
import { parseIdentity, runVoiceTurn } from "../src/voice-turn";

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

const HISTORY_DISPATCH_FAILED = /agents:agentMessages failed/u;
const INSTRUCTIONS_THUNK_BOOM = /instructions thunk boom/u;
const ANOTHER_OWNER = /another owner/u;

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

describe("sentence chunking", () => {
    /** Run one turn through the real chunker, returning what TTS was asked to speak. */
    const spokenFor = async (deltas: string[]): Promise<string[]> => {
        const store = createThreadStore();
        const spoken: string[] = [];

        await runVoiceTurn({
            agent,
            connectionId: "c1",
            env,
            exportName: "support",
            paths,
            run: store.run,
            send: () => {},
            sendAudio: () => {},
            signal: new AbortController().signal,
            streamGenerate: scriptedStream(deltas),
            synthesize: async (text) => {
                spoken.push(text);

                return new Uint8Array([1]);
            },
            text: "hello",
            threadKey: "t1",
            transcribe: async () => "",
            turn: 0,
        });

        return spoken;
    };

    it("keeps the text before a period that is not followed by whitespace", async () => {
        expect.assertions(1);

        // The chunker sliced by the match's LENGTH while the match could begin past
        // offset 0. Any `.` not followed by whitespace — a version, a decimal, a
        // filename, an `e.g.` — pushed the match right, so the text before it was
        // dropped and the tail was spoken twice: this came out as
        // ["2 here.", "here.", "Next one."].
        const spoken = await spokenFor(["See v1.2 here. Next one. "]);

        expect(spoken).toStrictEqual(["See v1.2 here.", "Next one."]);
    });

    it("does not stall the turn on a reply with no sentence terminator", async () => {
        expect.assertions(2);

        // The chunker runs on the whole accumulated buffer once per delta, so a
        // quadratic scan made the turn cubic. A code block, a URL list or a table —
        // ordinary model output — carries no `.` followed by whitespace for a long
        // stretch: a 20k-character reply measured 156 SECONDS of CPU in the DO.
        const deltas = Array.from<string>({ length: 1600 }).fill("const x = 1; ");
        const started = Date.now();

        const spoken = await spokenFor(deltas);
        const elapsedMs = Date.now() - started;

        // No terminator, so nothing chunks mid-stream; the whole reply is flushed
        // once at end of turn. Nothing is lost — it just must not take minutes.
        expect(spoken).toHaveLength(1);
        expect(elapsedMs).toBeLessThan(2000);
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
        expect(synthesize).not.toHaveBeenCalled();

        // Nothing is persisted — but the owner gate (`ensureThread`) still ran
        // before the transcription, so the thread it just marked "running" must
        // be handed back idle rather than wedged.
        expect(store.calls.filter((call) => call.path === paths.appendMessage)).toStrictEqual([]);
        expect(store.calls.map((call) => call.path)).toStrictEqual([paths.ensureThread, paths.patchThread]);
        expect(store.calls.at(-1)?.args).toMatchObject({ key: "t1", status: "idle" });
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

/** A `run` seam recording every `patchThread` status, with per-path failure injection. */
const statusRecordingRun = (options: { failPath?: string; history?: ReadonlyArray<AgentMessageRow> } = {}): { run: AgentRunFunction; statuses: string[] } => {
    const statuses: string[] = [];

    const run: AgentRunFunction = async (reference, args) => {
        const path = reference["__lunoraRef"];

        if (path === options.failPath) {
            throw new Error(`dispatch to ${path} failed`);
        }

        if (path === DEFAULT_AGENT_FUNCTION_PATHS.patchThread) {
            statuses.push(args?.["status"] as string);

            return undefined;
        }

        if (path === DEFAULT_AGENT_FUNCTION_PATHS.listMessages) {
            return options.history ?? [];
        }

        if (path === DEFAULT_AGENT_FUNCTION_PATHS.ensureThread) {
            return { outcome: "continued" };
        }

        return undefined;
    };

    return { run, statuses };
};

/** The options every bounded-voice-turn test shares, minus the seams each one varies. */
const turnOptions = (overrides: Partial<Parameters<typeof runVoiceTurn>[0]>): Parameters<typeof runVoiceTurn>[0] => {
    return {
        agent,
        connectionId: "c1",
        env,
        exportName: "support",
        paths,
        run: statusRecordingRun().run,
        send: () => {},
        sendAudio: () => {},
        signal: new AbortController().signal,
        streamGenerate: scriptedStream(["Hi."]),
        synthesize: async () => new Uint8Array(),
        text: "hello",
        threadKey: "t1",
        transcribe: async () => "unused",
        turn: 0,
        ...overrides,
    };
};

describe("voice turn thread status", () => {
    it("resets the shared thread to idle when the history read fails", async () => {
        const { run, statuses } = statusRecordingRun({ failPath: DEFAULT_AGENT_FUNCTION_PATHS.listMessages });

        // `status: "running"` was set three statements before the try opened, so
        // the catch that exists to prevent exactly this did not cover the history
        // dispatch. `agentEnsureThread` treats "running" as live, so one transient
        // failure rejected every later voice turn AND every durable text run on
        // the thread for ABANDONED_RUN_MS (13 hours).
        await expect(runVoiceTurn(turnOptions({ run }))).rejects.toThrow(HISTORY_DISPATCH_FAILED);

        expect(statuses).toStrictEqual(["running", "idle"]);
    });

    it("resets the shared thread to idle when a dynamic instructions thunk throws", async () => {
        const { run, statuses } = statusRecordingRun();
        const thunkAgent = defineAgent({
            instructions: () => {
                throw new Error("instructions thunk boom");
            },
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            voice: {},
        });

        await expect(runVoiceTurn(turnOptions({ agent: thunkAgent, run }))).rejects.toThrow(INSTRUCTIONS_THUNK_BOOM);

        expect(statuses).toStrictEqual(["running", "idle"]);
    });
});

describe("voice turn ownership gate", () => {
    it("refuses on the thread owner gate BEFORE paying for a transcription", async () => {
        let transcribed = 0;
        const run: AgentRunFunction = async (reference) => {
            if (reference["__lunoraRef"] === DEFAULT_AGENT_FUNCTION_PATHS.ensureThread) {
                throw new Error('@lunora/agent: thread "t1" belongs to another owner');
            }

            return undefined;
        };

        // STT ran BEFORE the ownership check, so a caller the thread refuses
        // still bought a full paid transcription of whatever it uploaded.
        await expect(
            runVoiceTurn(
                turnOptions({
                    pcm: new Uint8Array(8 * 1024 * 1024),
                    run,
                    text: undefined,
                    transcribe: async () => {
                        transcribed += 1;

                        return "my utterance";
                    },
                }),
            ),
        ).rejects.toThrow(ANOTHER_OWNER);

        expect(transcribed).toBe(0);
    });
});

describe("voice turn compaction", () => {
    it("applies the agent's compaction config — voice and text turns share ONE thread", async () => {
        const history: AgentMessageRow[] = Array.from({ length: 500 }, (_unused, index) => {
            return { content: `m${String(index)}`, role: "user" as const, seq: index };
        });
        const { run } = statusRecordingRun({ history });
        const compacting = defineAgent({
            compaction: { keepRecent: 2, maxMessages: 4 },
            instructions: "Be brief.",
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            voice: {},
        });
        let sent: ReadonlyArray<unknown> = [];

        await runVoiceTurn(
            turnOptions({
                agent: compacting,
                compact: async () => "THE BRIEF",
                run,
                streamGenerate: async (options, onDelta) => {
                    sent = options.messages;
                    onDelta("Hi.");

                    return { text: "Hi.", toolCalls: [] };
                },
            }),
        );

        // instructions + the compaction brief + the 2 kept rows — not all 500.
        expect(sent).toHaveLength(4);
        expect(JSON.stringify(sent)).toContain("THE BRIEF");
    });

    it("sends the full history when the agent declares no compaction (unchanged)", async () => {
        const history: AgentMessageRow[] = Array.from({ length: 12 }, (_unused, index) => {
            return { content: `m${String(index)}`, role: "user" as const, seq: index };
        });
        const { run } = statusRecordingRun({ history });
        let sent: ReadonlyArray<unknown> = [];

        await runVoiceTurn(
            turnOptions({
                compact: async () => "unused",
                run,
                streamGenerate: async (options) => {
                    sent = options.messages;

                    return { text: "Hi.", toolCalls: [] };
                },
            }),
        );

        expect(sent).toHaveLength(13);
    });
});

describe(parseIdentity, () => {
    it("decodes a base64url-encoded x-lunora-identity header (delegates to decodeIdentityHeader)", () => {
        expect.assertions(1);

        const claims = { name: "名前 🎌" };

        expect(parseIdentity(encodeIdentityHeader(claims))).toStrictEqual(claims);
    });

    it("still decodes a legacy raw-JSON header value", () => {
        expect.assertions(1);

        const claims = { email: "user@example.com" };

        expect(parseIdentity(JSON.stringify(claims))).toStrictEqual(claims);
    });

    it("returns undefined for null/malformed input rather than throwing", () => {
        expect.assertions(2);

        expect(parseIdentity(null)).toBeUndefined();
        expect(parseIdentity("{not json")).toBeUndefined();
    });
});
