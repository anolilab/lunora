import type { FC } from "react";

import { cn } from "@/lib/utils";

/**
 * A compact, syntax-tinted code panel (window dots + filename + optional line
 * numbers). Shared by the feature bento and steps sections. Aurora token tones.
 */

const KEYWORD = /^(?:import|from|const|export|async|await|function|return|new|default|type)$/;
const STRING = /^["'`]/;
const PUNCT = /^[{}()[\].,;:=><!]+$/;
const SPLIT_WS = /(\s+)/;

const tokenTone = (segment: string): string => {
    if (KEYWORD.test(segment)) {
        return "text-accent-2";
    }

    if (STRING.test(segment)) {
        return "text-accent-3";
    }

    if (PUNCT.test(segment)) {
        return "text-ink-faint";
    }

    return "text-ink-muted";
};

const CodeText: FC<{ text: string }> = ({ text }) => {
    if (!text.trim()) {
        return <span className="whitespace-pre"> </span>;
    }

    return (
        <span className="whitespace-pre">
            {text.split(SPLIT_WS).map((segment, index) => {
                if (!segment) {
                    return null;
                }

                return (
                    <span className={tokenTone(segment)} key={index}>
                        {segment}
                    </span>
                );
            })}
        </span>
    );
};

const CodeView: FC<{ className?: string; filename: string; lines: string[]; numbers?: boolean }> = ({ className, filename, lines, numbers = false }) => (
    // A console is dark in either band — on a light one it is the single black
    // object, and it earns that weight by being rare. It re-enters the dark
    // palette so its type stays light on it; without that the surface stayed
    // dark while the ink flipped and the listing measured 1.01:1.
    <div className={cn("flex flex-col overflow-hidden border border-hairline bg-[var(--site-console)]", className)} data-site-theme="dark">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
            <span className="size-2.5 rounded-full bg-hairline-strong" />
            <span className="size-2.5 rounded-full bg-hairline-strong" />
            <span className="size-2.5 rounded-full bg-hairline-strong" />
            <span className="ml-2 font-mono text-xs text-ink-faint">{filename}</span>
        </div>
        <pre className="grow overflow-auto p-4 font-mono text-[12.5px] leading-[1.7]">
            <code>
                {lines.map((line, index) => (
                    <div className="flex" key={index}>
                        {numbers ? <span className="mr-4 inline-block w-5 shrink-0 text-right text-ink-faint select-none">{index + 1}</span> : null}
                        <CodeText text={line} />
                    </div>
                ))}
            </code>
        </pre>
    </div>
);

export default CodeView;
