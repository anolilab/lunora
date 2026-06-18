import { Command, Cpu, MessageSquareText } from "lucide-react";
import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The "AI reasoning log" column to the left of each product section
 * (Langbase-style): blueprint rows with a `[ role ]` gutter label, an icon
 * box, and the line text, separated by hairline rules. Decorative; aria-hidden.
 */

interface TranscriptLine {
    role: "out" | "tool" | "user";
    text: string;
}

const ROLE_LABEL: Record<TranscriptLine["role"], string> = {
    out: "Output",
    tool: "Thinking",
    user: "Input",
};

const ROLE_ICON: Record<TranscriptLine["role"], ReactNode> = {
    out: <Command />,
    tool: <Cpu />,
    user: <MessageSquareText />,
};

const ChatTranscript: FC<{ className?: string; lines: TranscriptLine[] }> = ({ className, lines }) => (
    <div aria-hidden="true" className={cn("flex flex-col", className)}>
        {lines.map((line, index) => {
            const showLabel = index === 0 || lines[index - 1].role !== line.role;

            return (
                <div className="grid grid-cols-[96px_1fr] items-stretch" key={index}>
                    <span className="flex items-center justify-end pr-4 font-mono text-[10px] whitespace-nowrap text-white/30">
                        {showLabel ? `[ ${ROLE_LABEL[line.role]} ]` : ""}
                    </span>
                    <div className="flex items-center gap-3 border-b border-dashed border-white/[0.1] py-3.5 pr-4">
                        <span className="flex size-7 shrink-0 items-center justify-center border border-white/12 text-white/55 [&>svg]:size-3.5">
                            {ROLE_ICON[line.role]}
                        </span>
                        <span className="truncate text-[13px] text-white/65">{line.text}</span>
                    </div>
                </div>
            );
        })}
    </div>
);

export type { TranscriptLine };
export default ChatTranscript;
