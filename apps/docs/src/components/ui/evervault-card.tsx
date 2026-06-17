"use client";

import type { ClassValue } from "clsx";
import { motion, useMotionTemplate, useMotionValue } from "motion/react";
import type { FC, PropsWithChildren } from "react";
import React, { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const CardPattern = ({ mouseX, mouseY, randomString }: any) => {
    const maskImage = useMotionTemplate`radial-gradient(250px at ${mouseX}px ${mouseY}px, white, transparent)`;
    const style = { maskImage, WebkitMaskImage: maskImage };

    return (
        <div className="pointer-events-none">
            <div className="absolute inset-0 [mask-image:linear-gradient(white,transparent)] group-hover/card:opacity-50" />
            <motion.div
                className="absolute inset-0 bg-linear-to-r from-red-500 to-purple-700 opacity-0 backdrop-blur-xl transition duration-500 group-hover/card:opacity-100"
                style={style}
            />
            <motion.div className="pacity-0 absolute inset-0 mix-blend-overlay group-hover/card:opacity-100" style={style}>
                <p className="absolute inset-x-0 h-full font-mono text-xs font-bold break-words whitespace-pre-wrap text-white transition duration-500">
                    {randomString}
                </p>
            </motion.div>
        </div>
    );
};

const generateRandomString = (length: number) => {
    let result = "";

    for (let index = 0; index < length; index++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }

    return result;
};

const EvervaultCard: FC<PropsWithChildren<{ classes?: { innerCircle?: ClassValue; root?: ClassValue } }>> = ({ children, classes }) => {
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);

    const [randomString, setRandomString] = useState("");

    useEffect(() => {
        const string_ = generateRandomString(1500);

        setRandomString(string_);
    }, []);

    function onMouseMove({ clientX, clientY, currentTarget }: any) {
        const { left, top } = currentTarget.getBoundingClientRect();

        mouseX.set(clientX - left);
        mouseY.set(clientY - top);
    }

    return (
        <div className={cn("relative flex aspect-square h-full w-full items-center justify-center bg-transparent p-0.5", classes?.root)}>
            <div className="group/card relative flex h-full w-full items-center justify-center overflow-hidden bg-transparent" onMouseMove={onMouseMove}>
                <CardPattern mouseX={mouseX} mouseY={mouseY} randomString={randomString} />
                <div className="relative z-10 flex items-center justify-center">
                    <div className={cn("relative flex w-full items-center justify-center text-4xl font-bold", classes?.innerCircle)}>
                        <div className="absolute h-full w-full rounded-full bg-white/[0.8] blur-xs dark:bg-black/[0.8]" />
                        <div className="z-20">{children}</div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default EvervaultCard;
