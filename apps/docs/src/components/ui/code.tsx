"use client";

import type { ClassValue } from "clsx";
import { Code2, Copy, Eye, FileIcon } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { CodeOptionsSingleTheme } from "shiki/bundle/web";
import { codeToHtml } from "shiki/bundle/web";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

interface CodeProperties {
    darkTheme?: CodeOptionsSingleTheme["theme"];
    lightTheme?: CodeOptionsSingleTheme["theme"];
    mode?: "light" | "dark";
}

interface CodeComparisonProperties extends CodeProperties {
    afterCode: string;
    afterLanguage: string;
    beforeCode: string;
    beforeLanguage: string;
    filename?: string;
    minHeight?: number | string;
}

const renderCode = (code: string, highlighted: string, className?: ClassValue) => {
    if (highlighted) {
        return (
            <div
                className={cn("text-md font-mono [&_code]:py-4 [&_code]:pr-4 [&>pre]:h-full [&>pre]:p-4", className)}
                dangerouslySetInnerHTML={{ __html: highlighted }}
            />
        );
    }

    return <pre className={cn("text-md h-full overflow-auto p-4 font-mono", className)}>{code}</pre>;
};

export const Code: FC<
    CodeProperties & {
        classes?: {
            code?: ClassValue;
            root?: ClassValue;
            scrollArea?: ClassValue;
            wrapper?: ClassValue;
        };
        code: string;
        filePath?: string;
        language: string;
        showCopyButton?: boolean;
    }
> = ({ classes, code, darkTheme = "github-dark", filePath, language, lightTheme = "github-light", mode = "light", showCopyButton = true }) => {
    const [highlighted, setHighlighted] = useState("");

    useEffect(() => {
        const currentTheme = mode;
        const selectedTheme = currentTheme === "dark" ? darkTheme : lightTheme;

        async function highlightCode() {
            const html = await codeToHtml(code, {
                lang: language,
                theme: selectedTheme,
            });

            setHighlighted(html);
        }

        highlightCode();
    }, [mode, code, language, lightTheme, darkTheme]);

    return (
        <div className={cn("relative w-full", classes?.root)}>
            <div
                className={cn("rounded-xl p-3", classes?.wrapper, {
                    "bg-gray-100": mode === "light",
                    "bg-gray-500": mode === "dark",
                })}
            >
                <ScrollArea
                    className={cn(
                        "relative flex max-h-[600px] flex-col overflow-hidden rounded-[11px] bg-white text-sm leading-5 font-medium tracking-normal shadow-md md:text-sm md:leading-[22px]",
                        classes?.scrollArea,
                    )}
                >
                    {renderCode(code, highlighted, classes?.code)}
                </ScrollArea>
            </div>
        </div>
    );
};

export const CodePreview: FC<
    CodeProperties & { code: string; defaultView?: "code" | "preview"; language: string; preview?: ReactNode; showCopyButton?: boolean }
> = ({ code, darkTheme = "github-dark", defaultView = "code", language, lightTheme = "github-light", mode = "light", preview, showCopyButton = true }) => {
    const [highlighted, setHighlighted] = useState("");

    useEffect(() => {
        const currentTheme = mode;
        const selectedTheme = currentTheme === "dark" ? darkTheme : lightTheme;

        async function highlightCode() {
            const html = await codeToHtml(code, {
                lang: language,
                theme: selectedTheme,
            });

            setHighlighted(html);
        }

        highlightCode();
    }, [mode, code, language, lightTheme, darkTheme]);

    return (
        <div className="mt-5 w-full">
            <Tabs className="w-full" defaultValue={defaultView}>
                <div className="flex items-center justify-between gap-3 pb-4">
                    <TabsList>
                        <TabsTrigger value="preview">
                            <Eye className="mr-2.5 size-4" /> Preview
                        </TabsTrigger>
                        <TabsTrigger value="code">
                            <Code2 className="mr-2.5 size-4" /> Code
                        </TabsTrigger>
                    </TabsList>

                    {showCopyButton && (
                        <button className="flex h-7 items-center gap-1 rounded-lg bg-gray-100 pr-3 pl-1.5 text-sm" type="button">
                            <Copy className="text-gray-450 size-4" />
                            Copy
                        </button>
                    )}
                </div>
                <TabsContent value="preview">{preview}</TabsContent>
                <TabsContent className="rounded-xl bg-gray-100 p-3" value="code">
                    <ScrollArea className="relative flex max-h-[600px] flex-col overflow-hidden rounded-[11px] bg-white text-sm leading-5 font-medium tracking-normal shadow-md md:text-sm md:leading-[22px]">
                        {renderCode(code, highlighted)}
                    </ScrollArea>
                </TabsContent>
            </Tabs>
        </div>
    );
};

export const CodeComparison: FC<CodeComparisonProperties> = ({
    afterCode,
    afterLanguage,
    beforeCode,
    beforeLanguage,
    darkTheme = "vitesse-dark",
    filename,
    lightTheme = "github-light",
    minHeight,
    mode = "light",
}) => {
    const [highlightedBefore, setHighlightedBefore] = useState("");
    const [highlightedAfter, setHighlightedAfter] = useState("");

    useEffect(() => {
        const currentTheme = mode;
        const selectedTheme = currentTheme === "dark" ? darkTheme : lightTheme;

        async function highlightCode() {
            const before = await codeToHtml(beforeCode, {
                lang: beforeLanguage,
                theme: selectedTheme,
            });
            const after = await codeToHtml(afterCode, {
                lang: afterLanguage,
                theme: selectedTheme,
            });

            setHighlightedBefore(before);
            setHighlightedAfter(after);
        }

        highlightCode();
    }, [mode, beforeCode, afterCode, afterLanguage, beforeLanguage, lightTheme, darkTheme]);

    return (
        <div className="mx-auto w-full max-w-5xl">
            <div className="relative w-full overflow-hidden rounded-xl border">
                <div className="md:divide-border relative grid md:grid-cols-2 md:divide-x" style={{ minHeight }}>
                    <div>
                        <div className="bg-accent text-foreground flex items-center p-2 text-sm">
                            <FileIcon className="mr-2 h-4 w-4" />
                            {filename}
                            <span className="ml-auto">before</span>
                        </div>
                        {renderCode(beforeCode, highlightedBefore)}
                    </div>
                    <div>
                        <div className="bg-accent text-foreground flex items-center p-2 text-sm">
                            <FileIcon className="mr-2 h-4 w-4" />
                            {filename}
                            <span className="ml-auto">after</span>
                        </div>
                        {renderCode(afterCode, highlightedAfter, "[&>pre]:pl-8")}
                    </div>
                </div>
                <div className="bg-accent text-foreground absolute top-1/2 left-1/2 mt-5 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md text-sm">
                    VS
                </div>
            </div>
        </div>
    );
};
