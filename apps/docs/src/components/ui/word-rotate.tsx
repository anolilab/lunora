"use client";

import type { HTMLMotionProps } from "motion/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

interface WordRotateProperties {
    className?: string;
    duration?: number;
    framerProps?: HTMLMotionProps<"h1">;
    words: string[];
}

const WordRotate = ({
    className,
    duration = 2500,
    framerProps: framerProperties = {
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 50 },
        initial: { opacity: 0, y: -50 },
        transition: { duration: 0.25, ease: "easeOut" },
    },
    words,
}: WordRotateProperties) => {
    const [index, setIndex] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setIndex((previousIndex) => (previousIndex + 1) % words.length);
        }, duration);

        // Clean up interval on unmount
        return () => {
            clearInterval(interval);
        };
    }, [words, duration]);

    return (
        <div className="overflow-hidden py-2">
            <AnimatePresence mode="wait">
                <motion.h1 className={cn(className)} key={words[index]} {...framerProperties}>
                    {words[index]}
                </motion.h1>
            </AnimatePresence>
        </div>
    );
};

export default WordRotate;
