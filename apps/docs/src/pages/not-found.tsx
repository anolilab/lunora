"use client";

import type { NotFoundRouteProps } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Frown } from "lucide-react";
import type { FC, PropsWithChildren } from "react";

import SpaceBackdrop from "@/components/sections/space-backdrop";

const SPOTLIGHT = "radial-gradient(45% 40% at 32% 10%, rgba(255,255,255,0.12), transparent 70%)";

export const NotFound: FC<PropsWithChildren<NotFoundRouteProps>> = () => (
    <section
        className="relative flex min-h-[100svh] flex-col overflow-hidden bg-[#0e0e11] px-6 pt-32 pb-14 sm:px-10 lg:px-14"
        data-nav-theme="dark"
        data-theme="dark"
    >
        <SpaceBackdrop className="absolute inset-0 z-0" id="photo-1708559831534-44c30eb3ab0e" opacity={0.5} />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0" style={{ background: SPOTLIGHT }} />

        {/* top — error label + return panel */}
        <div className="relative z-10 flex items-start justify-between gap-8">
            <span className="font-mono text-xs tracking-wider text-white/45">( Error page )</span>

            <div className="flex w-full max-w-xl flex-col gap-5">
                <p className="text-sm leading-relaxed text-white/70">Maybe it moved, maybe it never existed — either way, let&apos;s go somewhere better.</p>
                <Link className="group flex min-h-40 flex-col justify-between gap-10 bg-[#f4f4f2] p-6 text-black transition-colors hover:bg-white" to="/">
                    <span className="text-2xl font-medium tracking-tight">Back to home</span>
                    <span className="flex items-center gap-2 text-sm text-black/60">
                        To homepage
                        <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                    </span>
                </Link>
            </div>
        </div>

        {/* bottom — headline + sign-off */}
        <div className="relative z-10 mt-auto flex items-end justify-between gap-8 pt-20">
            <h1 className="max-w-3xl text-5xl leading-[1.02] font-semibold tracking-tight text-balance text-white sm:text-6xl lg:text-7xl">
                This page doesn&apos;t exist — but great backends do
            </h1>
            <span className="flex shrink-0 items-center gap-2 font-mono text-xs text-white/40">
                Oops, wrong turn
                <Frown className="size-4" />
            </span>
        </div>
    </section>
);
