import type { CSSProperties, FC } from "react";

import { cn } from "@/lib/utils";

/**
 * The signature "aurora mosaic / equalizer" visual (Langbase-style), tinted to
 * the Lunora aurora sweep — cyan (186°) → violet (256°) → rose (330°). Fully
 * deterministic (seeded), so it renders identically on server and client.
 */

// Deterministic pseudo-random in [0, 1] — SSR-stable (no Math.random at render).
const rand = (n: number): number => {
    const x = Math.sin(n * 127.1) * 43_758.5453;

    return x - Math.floor(x);
};

const AURORA_START = 186;
const AURORA_SPAN = 144;

interface GradientBarsProperties {
    className?: string;
    columns?: number;
    rows?: number;
    seed?: number;
    variant?: "bars" | "mosaic";
}

const mosaicCell = (index: number, columns: number, seed: number): CSSProperties => {
    const column = index % columns;
    const t = columns > 1 ? column / (columns - 1) : 0;
    const hue = AURORA_START + t * AURORA_SPAN + (rand(index + seed) - 0.5) * 28;
    const saturation = 72 + rand(index + seed + 1) * 20;
    const lightness = 44 + rand(index + seed + 2) * 28;
    const alpha = 0.32 + rand(index + seed + 3) * 0.68;

    return { backgroundColor: `hsl(${hue.toFixed(1)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}% / ${alpha.toFixed(3)})` };
};

const barStyle = (index: number, columns: number, seed: number): CSSProperties => {
    const t = columns > 1 ? index / (columns - 1) : 0;
    const hue = AURORA_START + t * AURORA_SPAN;
    const height = 24 + rand(index + seed) * 76;

    return {
        background: `linear-gradient(to top, hsl(${hue.toFixed(1)} 82% 62% / 0.95), hsl(${hue.toFixed(1)} 82% 62% / 0.12))`,
        height: `${height.toFixed(2)}%`,
    };
};

const GradientBars: FC<GradientBarsProperties> = ({ className, columns = 22, rows = 7, seed = 0, variant = "mosaic" }) => {
    if (variant === "bars") {
        return (
            <div aria-hidden="true" className={cn("flex items-end gap-px overflow-hidden", className)}>
                {Array.from({ length: columns }, (_, index) => (
                    <div className="w-full" key={index} style={barStyle(index, columns, seed)} />
                ))}
            </div>
        );
    }

    return (
        <div
            aria-hidden="true"
            className={cn("grid gap-px overflow-hidden", className)}
            style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
        >
            {Array.from({ length: columns * rows }, (_, index) => (
                <span key={index} style={mosaicCell(index, columns, seed)} />
            ))}
        </div>
    );
};

export default GradientBars;
