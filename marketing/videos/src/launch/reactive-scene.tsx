// Short one-shot SFX use core `remotion` <Audio> (lenient PCM playback in both
// preview and render); `@remotion/media`'s strict parser drops short mono WAVs.
import { AbsoluteFill, Audio, Easing, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";

import { useFormat } from "../shared/format";
import { FONT_MONO, FONT_SANS } from "../shared/fonts";
import { KeyClicks } from "../shared/key-sound";
import { SceneLabel } from "../shared/scene-label";
import { BRAND } from "../shared/theme";
import { Window } from "../shared/window";
import { beatsToFrames } from "./timings";

const EASE = Easing.out(Easing.cubic);

interface Msg {
    author: string;
    body: string;
    color: string;
}

const SEED: Msg[] = [
    { author: "ada", body: "deploying to prod 🚀", color: "#7DD3FC" },
    { author: "lin", body: "types are green ✅", color: "#C4B5FD" },
];

const NEW: Msg = { author: "you", body: "ship it.", color: "#FDE68A" };

// Local-frame choreography, snapped to the beat so the message pop lands on a
// downbeat of the track. Send = beat 7, receive = beat 8.
const TYPE_START = beatsToFrames(2);
const TYPE_FRAMES = beatsToFrames(4);
const SEND_AT = beatsToFrames(7);
const PROPAGATE_AT = beatsToFrames(8);

export const ReactiveScene: React.FC = () => {
    const frame = useCurrentFrame();
    const { isLandscape, fitWidth, pick } = useFormat();

    // Side-by-side on 16:9; stacked on 9:16 / 1:1 so both windows stay large.
    const winW = isLandscape ? 600 : fitWidth(860);
    const winH = pick(540, 520, 380);

    const draftChars = Math.round(
        interpolate(frame, [TYPE_START, TYPE_START + TYPE_FRAMES], [0, NEW.body.length], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
        }),
    );
    const sent = frame >= SEND_AT;
    const draft = sent ? "" : NEW.body.slice(0, draftChars);
    const caretOn = !sent && Math.floor(frame / 12) % 2 === 0;

    const leftMessages = sent ? [...SEED, NEW] : SEED;
    const rightMessages = frame >= PROPAGATE_AT ? [...SEED, NEW] : SEED;

    // A key-click on each character as the draft is typed (1:1 — the composer
    // types slowly enough to land one per character).
    const composerClicks = Array.from({ length: NEW.body.length }, (_, i) => TYPE_START + Math.round(((i + 1) / NEW.body.length) * TYPE_FRAMES));

    return (
        <AbsoluteFill>
            {/* One key-click per character as the message is composed. */}
            <KeyClicks frames={composerClicks} volume={0.55} />
            {/* One-shot ping on send (window A) and receive (window B). */}
            <Sequence from={SEND_AT} durationInFrames={20} layout="none">
                <Audio src={staticFile("audio/sfx-message-ping.wav")} volume={0.8} />
            </Sequence>
            <Sequence from={PROPAGATE_AT} durationInFrames={20} layout="none">
                <Audio src={staticFile("audio/sfx-message-ping.wav")} volume={0.66} />
            </Sequence>

            <SceneLabel title="Write once. Every client updates live." />
            <AbsoluteFill
                style={{
                    flexDirection: isLandscape ? "row" : "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: pick(64, 8),
                    paddingTop: pick(60, 0),
                }}
            >
                <ChatWindow
                    label="localhost:5173 — window A"
                    width={winW}
                    height={winH}
                    messages={leftMessages}
                    draft={draft}
                    caretOn={caretOn}
                    newSince={sent ? SEND_AT : null}
                    appearedFrame={SEND_AT}
                />
                <Wire active={frame >= SEND_AT && frame < PROPAGATE_AT + 24} vertical={!isLandscape} />
                <ChatWindow
                    label="localhost:5173 — window B"
                    width={winW}
                    height={winH}
                    messages={rightMessages}
                    draft=""
                    caretOn={false}
                    newSince={frame >= PROPAGATE_AT ? PROPAGATE_AT : null}
                    appearedFrame={PROPAGATE_AT}
                />
            </AbsoluteFill>
            <Caption />
        </AbsoluteFill>
    );
};

const ChatWindow: React.FC<{
    label: string;
    width: number;
    height: number;
    messages: Msg[];
    draft: string;
    caretOn: boolean;
    newSince: number | null;
    appearedFrame: number;
}> = ({ label, width, height, messages, draft, caretOn, newSince, appearedFrame }) => {
    const frame = useCurrentFrame();
    const reveal = interpolate(frame, [0, 18], [0, 1], { easing: EASE, extrapolateRight: "clamp" });

    return (
        <div style={{ opacity: reveal }}>
            <Window label={label} width={width} height={height} meta="WS">
                <div style={{ display: "flex", flexDirection: "column", fontFamily: FONT_SANS, height: "100%" }}>
                    {/* Messages */}
                    <div
                        style={{
                            flex: 1,
                            padding: "22px 24px",
                            display: "flex",
                            flexDirection: "column",
                            gap: 14,
                            justifyContent: "flex-end",
                        }}
                    >
                        {messages.map((m, i) => {
                            const isNew = newSince !== null && i === messages.length - 1 && messages.length > SEED.length;
                            return <MessageRow key={`${m.author}-${i}`} msg={m} isNew={isNew} appearedFrame={appearedFrame} />;
                        })}
                    </div>

                    {/* Composer — sharp, hairline, no glass */}
                    <div style={{ padding: "0 20px 20px" }}>
                        <div
                            style={{
                                alignItems: "center",
                                background: BRAND.surfaceSoft,
                                border: `1px solid ${BRAND.hairline}`,
                                color: BRAND.ink,
                                display: "flex",
                                fontFamily: FONT_MONO,
                                fontSize: 22,
                                height: 54,
                                padding: "0 18px",
                            }}
                        >
                            <span style={{ color: draft ? BRAND.ink : BRAND.inkFaint }}>{draft || "Message…"}</span>
                            {caretOn && <span style={{ background: BRAND.accent, display: "inline-block", height: 24, marginLeft: 2, width: 2 }} />}
                        </div>
                    </div>
                </div>
            </Window>
        </div>
    );
};

const MessageRow: React.FC<{ msg: Msg; isNew: boolean; appearedFrame: number }> = ({ msg, isNew, appearedFrame }) => {
    const frame = useCurrentFrame();

    // Snap in instantly on the send/receive frame (2-frame) so the message lands
    // the moment "send" is pressed — not a fade that trails after it.
    const enter = isNew ? interpolate(frame, [appearedFrame, appearedFrame + 2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
    // The one sanctioned aurora glow — a brief flare on the just-arrived message.
    const glow = isNew ? interpolate(frame, [appearedFrame, appearedFrame + 24], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, opacity: enter, transform: `translateY(${(1 - enter) * 8}px)` }}>
            <span style={{ color: BRAND.inkFaint, fontFamily: FONT_MONO, fontSize: 15, letterSpacing: 1, textTransform: "uppercase" }}>@{msg.author}</span>
            <div
                style={{
                    alignSelf: "flex-start",
                    background: BRAND.surfaceSoft,
                    borderLeft: `2px solid ${isNew ? BRAND.accent : BRAND.hairlineStrong}`,
                    boxShadow: glow > 0 ? `-6px 0 22px rgba(255, 255, 255, ${glow * 0.4})` : "none",
                    color: BRAND.ink,
                    fontSize: 24,
                    maxWidth: "85%",
                    padding: "12px 18px",
                }}
            >
                {msg.body}
            </div>
        </div>
    );
};

/** The "WebSocket" pulse between the two windows on send — a sharp white tick. */
const Wire: React.FC<{ active: boolean; vertical?: boolean }> = ({ active, vertical = false }) => (
    <div
        style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "center",
            height: vertical ? 56 : "auto",
            width: vertical ? "auto" : 64,
        }}
    >
        <div
            style={{
                background: BRAND.accent,
                boxShadow: active ? `0 0 22px ${BRAND.accent}` : "none",
                height: 10,
                opacity: active ? 1 : 0.25,
                width: 10,
            }}
        />
    </div>
);

const Caption: React.FC = () => {
    const frame = useCurrentFrame();
    const reveal = interpolate(frame, [PROPAGATE_AT + 6, PROPAGATE_AT + 26], [0, 1], {
        easing: Easing.bezier(0.16, 1, 0.3, 1),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    return (
        <div
            style={{
                position: "absolute",
                bottom: 70,
                left: 0,
                right: 0,
                textAlign: "center",
                opacity: reveal,
                color: BRAND.inkMuted,
                fontFamily: FONT_MONO,
                fontSize: 24,
                letterSpacing: 0.2,
            }}
        >
            reactive by default — zero cache invalidation, no refetch.
        </div>
    );
};
