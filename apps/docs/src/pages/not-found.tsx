"use client";

import type { NotFoundRouteProps } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Frown } from "lucide-react";
import type { FC, PropsWithChildren } from "react";

import SpaceBackdrop from "@/components/sections/space-backdrop";

export const NotFound: FC<PropsWithChildren<NotFoundRouteProps>> = ({ children }) => (
    <section
        className="relative flex min-h-[100svh] flex-col overflow-hidden bg-canvas px-6 pt-32 pb-14 sm:px-10 lg:px-14"
        data-nav-theme="dark"
        data-theme="dark"
    >
        <SpaceBackdrop className="absolute inset-0 z-0" opacity={0.5} />

        {/* top — error label + return panel */}
        <div className="relative z-10 flex items-start justify-between gap-8">
            <span className="font-mono text-xs tracking-wider text-ink-faint">( ERROR 404 )</span>

            <div className="flex w-full max-w-xl flex-col gap-5">
                <p className="text-sm leading-relaxed text-ink-muted">
                    {children ?? "Maybe it moved, maybe it never existed — either way, let’s go somewhere better."}
                </p>
                <Link className="group flex min-h-40 flex-col justify-between gap-10 bg-panel p-6 text-on-panel transition-colors hover:bg-panel" to="/">
                    <span className="text-2xl font-medium tracking-tight">Back to home</span>
                    <span className="flex items-center gap-2 text-sm text-on-panel/60">
                        To homepage
                        <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                    </span>
                </Link>
            </div>
        </div>

        {/* bottom — headline + sign-off. The aurora ribbon is the single color event. */}
        <div className="relative z-10 mt-auto flex items-end justify-between gap-8 pt-20">
            <h1 className="max-w-3xl text-5xl leading-[1.02] font-semibold tracking-tight text-balance text-ink sm:text-6xl lg:text-7xl">
                This page doesn&apos;t exist — but{" "}
                <span className="bg-gradient-to-r from-cyan-300 via-violet-400 to-rose-300 bg-clip-text text-transparent">great backends do</span>
            </h1>
            <span className="flex shrink-0 items-center gap-2 font-mono text-xs text-ink-faint">
                Oops, wrong turn
                <Frown className="size-4" />
            </span>
        </div>
    </section>
);
