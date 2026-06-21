import { Composition } from "remotion";

import { CodeCard } from "./cards/card";
import { CLIENT_CODE, FUNCTIONS_CODE, SCALE_CODE, SCHEMA_CODE } from "./launch/code";
import { LunoraLaunch } from "./launch/composition";
import { TOTAL_DURATION as LAUNCH_DURATION } from "./launch/timings";

/**
 * Every Lunora launch/release video is registered here. The same `LunoraLaunch`
 * component renders at three aspect ratios — the scenes read `useFormat()` and
 * reflow (windows cap to the canvas; the reactive scene stacks on narrow cuts).
 * Run `pnpm dev` and pick one from the Studio sidebar, or render with
 * `pnpm render <id> out/<name>.mp4`.
 */
const SHARED = { component: LunoraLaunch, durationInFrames: LAUNCH_DURATION, fps: 30 } as const;

/**
 * Still-only code cards for social posts (`pnpm render:cards`) — the same window +
 * syntax as the launch video, at 16:9. Rendered, never played; the `render:cards`
 * script grabs a frame past the line-reveal stagger.
 */
const CARD = { component: CodeCard, durationInFrames: 120, fps: 30, height: 900, width: 1600 } as const;

export const RemotionRoot: React.FC = () => (
    <>
        {/* 16:9 — site hero, YouTube, embeds */}
        <Composition id="LunoraLaunch" {...SHARED} width={1920} height={1080} />
        {/* 9:16 — Stories / Reels / TikTok / Shorts */}
        <Composition id="LunoraLaunchVertical" {...SHARED} width={1080} height={1920} />
        {/* 1:1 — X / LinkedIn / Instagram feed */}
        <Composition id="LunoraLaunchSquare" {...SHARED} width={1080} height={1080} />

        {/* social code cards (stills) */}
        <Composition id="CardSchema" {...CARD} defaultProps={{ code: SCHEMA_CODE, filename: "lunora/schema.ts" }} />
        <Composition id="CardFunctions" {...CARD} defaultProps={{ code: FUNCTIONS_CODE, filename: "lunora/messages.ts" }} />
        <Composition id="CardClient" {...CARD} defaultProps={{ code: CLIENT_CODE, filename: "Chat.tsx" }} />
        <Composition id="CardScale" {...CARD} defaultProps={{ code: SCALE_CODE, filename: "lunora/schema.ts" }} />
    </>
);
