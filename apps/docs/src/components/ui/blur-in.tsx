"use client";

import { motion } from "motion/react";
import type { FC, PropsWithChildren } from "react";

interface BlurInProperties {
    className?: string;
    component: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span" | "div";
    duration?: number;
    variant?: {
        hidden: { filter: string; opacity: number };
        visible: { filter: string; opacity: number };
    };
}

const BlurIn: FC<PropsWithChildren<BlurInProperties>> = ({ children, className, component, duration = 1, variant }) => {
    const defaultVariants = {
        hidden: { filter: "blur(10px)", opacity: 0 },
        visible: { filter: "blur(0px)", opacity: 1 },
    };
    const combinedVariants = variant || defaultVariants;

    const Comp = motion[component];

    return (
        <Comp animate="visible" className={className} initial="hidden" transition={{ duration }} variants={combinedVariants}>
            {children}
        </Comp>
    );
};

export default BlurIn;
