import type { FC } from "react";
import { useId, useMemo, useState } from "react";

import Section from "@/components/sections/section";
import { MultiSelect } from "@/components/ui/multi-select";
import { ScrollArea } from "@/components/ui/scroll-area";

import SupportSection from "../home/sections/support";

const Timeline: FC = () => {
    const id = useId();

    return (
        <div className="pointer-events-none absolute inset-0 z-50 overflow-hidden lg:right-0 lg:left-0 lg:mx-auto lg:w-2 lg:overflow-visible">
            <svg
                aria-hidden="true"
                className="absolute top-0 left-[max(0px,calc(50%-18.125rem))] h-full w-1.5 lg:left-full lg:ml-1 xl:right-1 xl:left-auto xl:ml-0"
            >
                <defs>
                    <pattern height="8" id={id} patternUnits="userSpaceOnUse" width="6">
                        <path className="stroke-sky-900/10 xl:stroke-white/10 dark:stroke-white/10" d="M0 0H6M0 8H6" fill="none" />
                    </pattern>
                </defs>
                <rect fill={`url(#${id})`} height="100%" width="100%" />
            </svg>
        </div>
    );
};

const Changelog: FC<{ data: { key: string; MdxContent: FC; title: string }[] }> = ({ data }) => {
    const changelogList = useMemo(
        () =>
            data.map((item) => {
                return {
                    label: item.title,
                    value: item.key,
                };
            }),
        [data],
    );

    const [selectedChangelogs, setSelectedChangelogs] = useState(changelogList.map((item) => item.value));

    const changelogs = useMemo(() => data.filter((item) => selectedChangelogs.includes(item.key)), [data, selectedChangelogs]);

    return (
        <>
            <div className="bg-background relative flex h-screen flex-col">
                <Section
                    classes={{
                        childrenWrapper: "h-full",
                        root: "py-0 min-h-screen border-x border-b border-white/[0.08]",
                    }}
                    gridLength={2}
                    mode="dark"
                >
                    <div className="col-span-2 flex h-full items-center justify-center">
                        <div className="px-6 sm:px-12 lg:px-24">
                            <h1 className="mt-14 font-sans text-4xl font-semibold tracking-tighter text-balance sm:text-5xl">
                                All of the changes made will be <span className="">available here.</span>
                            </h1>
                            <p className="mt-4 text-sm">
                                Lunora is a type-safe, real-time backend framework on Cloudflare Workers and Durable Objects with a Vite-first developer
                                experience. Follow along here as the framework evolves.
                            </p>
                        </div>
                    </div>
                    <Timeline />
                    <div className="relative col-span-2 mt-16">
                        <div className="h-10 flex items-end z-10 bg-background">
                            <MultiSelect
                                className="rounded-none border-x-0"
                                defaultValue={selectedChangelogs}
                                maxCount={3}
                                onValueChange={setSelectedChangelogs}
                                options={changelogList}
                                placeholder="Select a changelog"
                                variant="inverted"
                            />
                        </div>
                        {changelogs.length > 0 && (
                            <ScrollArea className="h-[calc(100vh-140px)] px-6 mt-4 prose prose-invert">
                                {changelogs.map((item, index) => (
                                    <div className={index > 0 ? "mt-12 border-t border-white/[0.08] pt-12" : ""} key={item.key}>
                                        <h2 className="mt-0">{item.title}</h2>
                                        <item.MdxContent />
                                    </div>
                                ))}
                            </ScrollArea>
                        )}
                        {changelogs.length === 0 && (
                            <div className="flex items-center justify-center h-[calc(100vh-140px)]">
                                <p className="text-lg text-muted-foreground">No changelogs selected</p>
                            </div>
                        )}
                    </div>
                </Section>
            </div>
            <SupportSection />
        </>
    );
};

export default Changelog;
