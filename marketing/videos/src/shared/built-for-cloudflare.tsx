import { Img, staticFile } from "remotion";

import { FONT_MONO } from "./fonts";
import { BRAND, COPY } from "./theme";

/**
 * "BUILT FOR CLOUDFLARE" lockup — the official Cloudflare brand glyph
 * (`public/brand/cloudflare.svg`, downloaded from simple-icons), rendered white via
 * `invert` for the monochrome video, next to the name in mono. Nominative
 * attribution: Lunora runs on Cloudflare.
 */
export const BuiltForCloudflare: React.FC<{ size?: number; opacity?: number }> = ({ size = 22, opacity = 1 }) => (
    <div style={{ alignItems: "center", display: "flex", gap: 12, opacity }}>
        <span
            style={{
                color: BRAND.inkFaint,
                fontFamily: FONT_MONO,
                fontSize: size * 0.62,
                letterSpacing: 2,
                textTransform: "uppercase",
            }}
        >
            Built for
        </span>
        <Img src={staticFile("brand/cloudflare.svg")} style={{ filter: "invert(1)", height: size, opacity: 0.92, width: size * 1.4 }} />
        <span
            style={{
                color: BRAND.ink,
                fontFamily: FONT_MONO,
                fontSize: size * 0.72,
                letterSpacing: 1,
            }}
        >
            Cloudflare
        </span>
    </div>
);
