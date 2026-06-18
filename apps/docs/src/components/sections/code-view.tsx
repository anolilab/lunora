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
        return "text-royal-amethyst";
    }

    if (STRING.test(segment)) {
        return "text-crimson-energy/80";
    }

    if (PUNCT.test(segment)) {
        return "text-white/35";
    }

    return "text-white/75";
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
    <div className={cn("flex flex-col overflow-hidden border border-white/[0.08] bg-[hsl(240_22%_4%)]", className)}>
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="ml-2 font-mono text-xs text-white/40">{filename}</span>
        </div>
        <pre className="grow overflow-auto p-4 font-mono text-[12.5px] leading-[1.7]">
            <code>
                {lines.map((line, index) => (
                    <div className="flex" key={index}>
                        {numbers ? <span className="mr-4 inline-block w-5 shrink-0 text-right text-white/20 select-none">{index + 1}</span> : null}
                        <CodeText text={line} />
                    </div>
                ))}
            </code>
        </pre>
    </div>
);

export default CodeView;
