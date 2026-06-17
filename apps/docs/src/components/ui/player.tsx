import "@vidstack/react/player/styles/base.css";

import { Controls, Gesture, MediaPlayer, MediaProvider, PlayButton, Poster, Tooltip, useMediaState } from "@vidstack/react";
import { PauseIcon, PlayIcon } from "@vidstack/react/icons";
import type { FC } from "react";

const Play = ({ tooltipPlacement }: { tooltipPlacement?: any }) => {
    const isPaused = useMediaState("paused");

    return (
        <Tooltip.Root>
            <Tooltip.Trigger asChild>
                <PlayButton className="ring-media-focus group relative inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md outline-hidden ring-inset hover:bg-white/20 data-focus:ring-4">
                    {isPaused ? <PlayIcon className="h-8 w-8" /> : <PauseIcon className="h-8 w-8" />}
                </PlayButton>
            </Tooltip.Trigger>
            <Tooltip.Content
                className="parent-data-[open]:hidden animate-out fade-out slide-out-to-bottom-2 data-visible:animate-in data-visible:fade-in data-visible:slide-in-from-bottom-4 z-10 rounded-sm bg-black/90 px-2 py-0.5 text-sm font-medium text-white"
                placement={tooltipPlacement}
            >
                {isPaused ? "Play" : "Pause"}
            </Tooltip.Content>
        </Tooltip.Root>
    );
};

const Player: FC<{ posterSrc?: string; src: string; title: string }> = ({ posterSrc, src, title }) => (
    <MediaPlayer
        className="ring-media-focus aspect-video w-full overflow-hidden rounded-md bg-slate-900 font-sans text-white data-focus:ring-4"
        crossOrigin
        playsInline
        src={src}
        title={title}
    >
        <MediaProvider>
            {posterSrc && (
                <Poster
                    alt={title}
                    className="absolute inset-0 block h-full w-full rounded-md object-cover opacity-0 transition-opacity data-visible:opacity-100"
                    src={posterSrc}
                />
            )}

            <Gesture />
            <Controls.Root className="media-controls:opacity-100 absolute inset-0 z-10 flex h-full w-full flex-col bg-linear-to-t from-black/10 to-transparent opacity-0 transition-opacity">
                <div className="flex-1" />
            </Controls.Root>
        </MediaProvider>
    </MediaPlayer>
);

export default Player;
