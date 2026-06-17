"use client";

import type { NotFoundRouteProps } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, BookOpen, Home, Package } from "lucide-react";
import { motion } from "motion/react";
import type { FC, PropsWithChildren } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import Section from "@/components/sections/section";
import SectionSeparator from "@/components/sections/section-separator";

import SupportSection from "./home/sections/support";

const ScatteredDigit: FC<{ char: string; delay: number; index: number }> = ({ char, delay, index }) => {
    const drift = useMemo(() => {
        return {
            rotate: (index - 1) * 8 + (index === 1 ? -3 : index === 2 ? 5 : -2),
            x: (index - 1) * 4,
            y: index === 1 ? -6 : index === 2 ? 8 : -4,
        };
    }, [index]);

    return (
        <motion.span
            animate={{
                opacity: 1,
                rotate: drift.rotate,
                x: drift.x,
                y: drift.y,
            }}
            className="inline-block font-bold tabular-nums"
            initial={{ opacity: 0, rotate: 0, x: 0, y: 40 }}
            transition={{
                delay,
                duration: 0.7,
                ease: [0.16, 1, 0.3, 1],
            }}
            whileHover={{
                rotate: 0,
                scale: 1.05,
                transition: { duration: 0.3 },
                x: 0,
                y: 0,
            }}
        >
            {char}
        </motion.span>
    );
};

const navItems = [
    {
        accentColor: "sky-sapphire",
        href: "/docs",
        icon: BookOpen,
        label: "Docs",
    },
    {
        accentColor: "royal-amethyst",
        href: "/packages",
        icon: Package,
        label: "Packages",
    },
    {
        accentColor: "crimson-energy",
        href: "/",
        icon: Home,
        label: "Home",
    },
];

// eslint-disable-next-line import/prefer-default-export
export const NotFound: FC<PropsWithChildren<NotFoundRouteProps>> = ({ children }) => {
    const [pathname, setPathname] = useState("/...");

    useEffect(() => {
        setPathname(globalThis.location.pathname);
    }, []);

    const handleGoBack = useCallback(() => {
        globalThis.history.back();
    }, []);

    return (
        <>
            <div className="bg-coal relative">
                <Section
                    classes={{
                        childrenWrapper: "gap-y-0",
                        pattern: "inset-y-10",
                        root: "py-20 lg:py-28",
                    }}
                    gridLength={1}
                    mode="dark"
                    patternColor="crimson-energy"
                    patternPosition="bottom"
                >
                    <div className="col-span-2 lg:col-span-4 flex flex-col items-center">
                        <div className="relative flex items-baseline gap-1 text-[7rem] leading-none tracking-tighter sm:text-[9rem] lg:text-[11rem]">
                            {["4", "0", "4"].map((char, i) => (
                                <ScatteredDigit char={char} delay={0.1 + i * 0.12} index={i} key={i} />
                            ))}

                            <motion.div
                                animate={{ opacity: 0.6 }}
                                className="absolute -bottom-2 left-1/2 h-px w-3/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-crimson-energy to-transparent"
                                initial={{ opacity: 0 }}
                                transition={{ delay: 0.7, duration: 1 }}
                            />
                        </div>

                        <motion.div
                            animate={{ opacity: 1, y: 0 }}
                            className="mt-8 flex flex-col items-center gap-3 text-center"
                            initial={{ opacity: 0, y: 12 }}
                            transition={{ delay: 0.6, duration: 0.5 }}
                        >
                            <h1 className="text-xl font-bold tracking-tight text-white/90 sm:text-2xl">Page not found</h1>
                            <p className="max-w-sm text-sm leading-relaxed text-white/40">
                                {children || "The page you're looking for doesn't exist or has been moved to a different location."}
                            </p>
                            <motion.div
                                animate={{ opacity: 1 }}
                                className="mt-1 inline-flex items-center gap-1.5 font-mono text-xs text-white/20"
                                initial={{ opacity: 0 }}
                                transition={{ delay: 0.9, duration: 0.4 }}
                            >
                                <span className="h-1 w-1 rounded-full bg-crimson-energy/50" />
                                {pathname}
                            </motion.div>
                        </motion.div>
                    </div>

                    <motion.div
                        animate={{ opacity: 1, y: 0 }}
                        className="col-span-2 lg:col-span-4 mx-auto mt-14"
                        initial={{ opacity: 0, y: 16 }}
                        transition={{ delay: 1, duration: 0.5 }}
                    >
                        <div className="flex items-center justify-center gap-3">
                            <button
                                className="group flex cursor-pointer items-center gap-2.5 border border-white/[0.08] bg-white/[0.02] px-5 py-3 text-sm text-white/50 transition-all duration-300 hover:border-white/[0.15] hover:bg-white/[0.05] hover:text-white/80"
                                onClick={handleGoBack}
                                type="button"
                            >
                                <ArrowLeft className="h-3.5 w-3.5 transition-transform duration-300 group-hover:-translate-x-0.5" />
                                Back
                            </button>

                            {navItems.map((item, index) => (
                                <motion.div
                                    animate={{ opacity: 1, scale: 1 }}
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    key={item.href}
                                    transition={{ delay: 1.1 + index * 0.08, duration: 0.35 }}
                                >
                                    <Link
                                        className={`group relative flex items-center gap-2.5 border border-white/[0.08] bg-white/[0.02] px-5 py-3 text-sm text-white/50 transition-all duration-300 hover:border-${item.accentColor}/30 hover:bg-${item.accentColor}/[0.06] hover:text-white/90`}
                                        to={item.href}
                                    >
                                        <item.icon
                                            className={`h-3.5 w-3.5 text-${item.accentColor}/60 transition-colors duration-300 group-hover:text-${item.accentColor}`}
                                        />
                                        {item.label}
                                    </Link>
                                </motion.div>
                            ))}
                        </div>
                    </motion.div>
                </Section>
            </div>
            <div className="relative">
                <SectionSeparator bgColor="bg-coal" fillColor="fill-coal" position="bottom" />
            </div>
            <SupportSection />
        </>
    );
};
