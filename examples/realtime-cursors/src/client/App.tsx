import { useMutation, useQuery } from "@lunora/react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc } from "../../lunora/_generated/dataModel.js";

const COLORS = ["#e63946", "#1d3557", "#2a9d8f", "#f4a261", "#9d4edd", "#0096c7"] as const;
const FRAME_INTERVAL_MS = 1000 / 30; // throttle pointer events to ~30fps

// Presence session id — a non-secret correlation handle. Minted from Web Crypto
// (never Math.random) so it isn't treated as insecure randomness in a security
// context; this demo only ever runs in the browser, where crypto is present.
const randomId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("");
// Cosmetic cursor color — not a security context, so plain Math.random is fine.
const pickColor = (): string => COLORS[Math.floor(Math.random() * COLORS.length)] ?? "#1d3557";

/**
 * Full-page cursor sharing demo. Drives one mutation per pointer move
 * (throttled), one subscription per room, with the server-side `.shardBy`
 * doing the horizontal scaling for us.
 *
 * Open this page in two tabs (same room) to see live cursors flow.
 */
export const App = (): ReactElement => {
    const [roomId, setRoomId] = useState<string>(() => {
        const fromHash = globalThis.location.hash.slice(1);

        return fromHash || "lobby";
    });

    const sessionId = useMemo(() => randomId(), []);
    const color = useMemo(() => pickColor(), []);
    const [name] = useState<string>(() => `guest-${sessionId.slice(0, 4)}`);

    const cursors = useQuery(api.cursors.listCursors, { roomId }, { shardKey: roomId }) as Doc<"cursors">[] | undefined;

    const { mutate: join } = useMutation(api.cursors.joinRoom);
    const { mutate: move } = useMutation(api.cursors.updateCursor);

    useEffect(() => {
        void join({ roomId, sessionId, name, color }, { shardKey: roomId });
    }, [join, roomId, sessionId, name, color]);

    const lastSentRef = useRef(0);

    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
        const now = performance.now();

        if (now - lastSentRef.current < FRAME_INTERVAL_MS) {
            return;
        }

        lastSentRef.current = now;

        void move({ roomId, sessionId, x: event.clientX, y: event.clientY }, { shardKey: roomId });
    };

    const onChangeRoom = (): void => {
        const next = globalThis.prompt("Room name", roomId) ?? roomId;

        globalThis.location.hash = next;
        setRoomId(next);
    };

    return (
        <div onPointerMove={onPointerMove} style={{ width: "100vw", height: "100vh", position: "relative", background: "#fafafa" }}>
            <header style={{ position: "absolute", top: 12, left: 12, padding: 8, background: "white", borderRadius: 6 }}>
                <strong>room:</strong> <code>{roomId}</code>{" "}
                <button onClick={onChangeRoom} style={{ marginLeft: 8 }} type="button">
                    change
                </button>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
                    you are <span style={{ color }}>{name}</span> — open this URL in a second tab to see live cursors
                </div>
            </header>
            {(cursors ?? [])
                .filter((cursor) => cursor.sessionId !== sessionId)
                .map((cursor) => (
                    <Cursor cursor={cursor} key={cursor.sessionId} />
                ))}
        </div>
    );
};

const Cursor = ({ cursor }: { cursor: Doc<"cursors"> }): ReactElement => (
    <div
        style={{
            position: "absolute",
            top: cursor.y,
            left: cursor.x,
            transform: "translate(-2px, -2px)",
            pointerEvents: "none",
            transition: "top 80ms linear, left 80ms linear",
        }}
    >
        <svg fill={cursor.color} height="20" viewBox="0 0 20 20" width="20">
            <path d="M0 0 L0 16 L5 12 L9 18 L11 17 L7 11 L14 11 Z" />
        </svg>
        <span style={{ marginLeft: 6, padding: "2px 6px", background: cursor.color, color: "white", borderRadius: 4, fontSize: 12 }}>{cursor.name}</span>
    </div>
);
