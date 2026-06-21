import type { CSSProperties, ReactNode } from "react";

import { FONT_MONO } from "./fonts";
import { BRAND } from "./theme";

/**
 * Lunora "instrument-panel" window chrome (lunora-design): SHARP corners, a
 * single hairline border for depth (no blur, no drop shadow), and a title bar
 * with a mono ALL-CAPS label — no multi-color traffic-light dots. A lone aurora
 * status dot is the only accent.
 */
export const Window: React.FC<{
    label: string;
    width?: number;
    height?: number;
    children: ReactNode;
    /** Right-aligned status text in the title bar (mono, muted). */
    meta?: string;
    style?: CSSProperties;
}> = ({ label, width, height, children, meta, style }) => (
    <div
        style={{
            width,
            height,
            background: BRAND.surface,
            border: `1px solid ${BRAND.hairline}`,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            ...style,
        }}
    >
        <div
            style={{
                alignItems: "center",
                background: BRAND.surfaceSoft,
                borderBottom: `1px solid ${BRAND.hairline}`,
                display: "flex",
                gap: 12,
                height: 46,
                padding: "0 18px",
            }}
        >
            <span
                style={{
                    background: BRAND.accent,
                    height: 7,
                    width: 7,
                }}
            />
            <span
                style={{
                    color: BRAND.inkMuted,
                    fontFamily: FONT_MONO,
                    fontSize: 15,
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                }}
            >
                {label}
            </span>
            {meta && (
                <span
                    style={{
                        color: BRAND.inkFaint,
                        fontFamily: FONT_MONO,
                        fontSize: 14,
                        letterSpacing: 0.6,
                        marginLeft: "auto",
                    }}
                >
                    {meta}
                </span>
            )}
        </div>
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>{children}</div>
    </div>
);
