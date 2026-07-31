"use client";

import { Check, Copy } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import posthog from "@/lib/posthog";

/**
 * Copyable install command for the starter-kits page — mirrors the home hero's
 * `InstallCommand` (click to copy, transient check). Isolated as a client
 * component so the rest of the `/start` page stays server-rendered for SEO.
 */
const COMMAND = "npx lunorash@alpha init my-app";

const InstallCommand: FC = () => {
    const [copied, setCopied] = useState(false);

    const copy = () => {
        const run = async () => {
            try {
                await navigator.clipboard.writeText(COMMAND);
            } catch {
                // Permission denied, or no secure context. Nothing was copied,
                // so neither the check mark nor the event should claim it was.
                return;
            }

            posthog.capture("install_command_copied", { location: "starter_kits" });
            setCopied(true);
            setTimeout(() => {
                setCopied(false);
            }, 1500);
        };

        void run();
    };

    return (
        <button
            className="group flex w-fit items-center gap-3 border border-white/12 px-4 py-2 font-mono text-sm text-white/60 transition-colors hover:border-white/25 hover:text-white"
            onClick={copy}
            type="button"
        >
            <span className="text-white/30 select-none">$</span>
            {COMMAND}
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-3.5 text-white/35 transition-colors group-hover:text-white/60" />}
        </button>
    );
};

export default InstallCommand;
