import type { ImageProps } from "@unpic/react";
import { Image } from "@unpic/react";
import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { Maximize2, Minimize2 } from "lucide-react";
import { Portal } from "radix-ui";
import type { FC } from "react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const ImageZoom: FC<
    Omit<ImageProps, "className"> & {
        classes?: {
            image?: ClassValue;
            root?: ClassValue;
            zoomImage?: ClassValue;
            zoomWrapper?: ClassValue;
        };
    }
> = ({ classes, ...properties }) => {
    const [isZoomed, setIsZoomed] = useState(false);

    const escFunction = useCallback((event: KeyboardEvent) => {
        if (event.key === "Escape") {
            setIsZoomed(false);
        }
    }, []);

    useEffect(() => {
        document.addEventListener("keydown", escFunction, false);

        return () => {
            document.removeEventListener("keydown", escFunction, false);
        };
    }, []);

    return (
        <>
            <Portal.Root asChild>
                <div
                    className={clsx(
                        "fixed top-0 right-0 bottom-0 left-0 z-50 h-full w-full bg-white/30 opacity-0 backdrop-blur-xs transition-opacity duration-500 ease-in-out",
                        {
                            invisible: !isZoomed,
                            "visible opacity-100": isZoomed,
                        },
                    )}
                    onClick={() => {
                        setIsZoomed(false);
                    }}
                >
                    <div className={cn("flex h-full items-center justify-center p-20", classes?.zoomWrapper)}>
                        <div
                            className="group relative cursor-pointer rounded-xl bg-gray-300 p-3 shadow-xl"
                            onClick={() => {
                                setIsZoomed(false);
                            }}
                        >
                            <div className="absolute top-1 right-0 left-0 mx-auto hidden w-8 rounded-md p-2 group-hover:block group-hover:bg-white">
                                <Minimize2 className="h-4 w-4 text-gray-500" />
                            </div>
                            <Image {...(properties as any)} className={cn("h-full", classes?.zoomImage)} />
                        </div>
                    </div>
                </div>
            </Portal.Root>
            <div
                className={cn("group relative", classes?.root)}
                onClick={() => {
                    setIsZoomed(true);
                }}
            >
                <div className="absolute top-1 right-0 left-0 mx-auto hidden w-8 rounded-md p-2 group-hover:block group-hover:bg-white">
                    <Maximize2 className="h-4 w-4 text-gray-500" />
                </div>
                <div className="rounded-xl bg-gray-500 p-3">
                    <Image {...(properties as any)} className={clsx(classes?.image, "cursor-pointer")} />
                </div>
            </div>
        </>
    );
};

export default ImageZoom;
