import type { ClassValue } from "clsx";
import type { UseEmblaCarouselType } from "embla-carousel-react";
import useEmblaCarousel from "embla-carousel-react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ComponentProps, HTMLAttributes, KeyboardEvent } from "react";
import { createContext, use, useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CarouselApi = UseEmblaCarouselType[1];
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];

type CarouselProperties = {
    opts?: CarouselOptions;
    orientation?: "horizontal" | "vertical";
    plugins?: CarouselPlugin;
    setApi?: (api: CarouselApi) => void;
};

type CarouselContextProperties = CarouselProperties & {
    api: ReturnType<typeof useEmblaCarousel>[1];
    canScrollNext: boolean;
    canScrollPrev: boolean;
    carouselRef: ReturnType<typeof useEmblaCarousel>[0];
    scrollNext: () => void;
    scrollPrev: () => void;
};

const CarouselContext = createContext<CarouselContextProperties | null>(null);

function useCarousel() {
    const context = use(CarouselContext);

    if (!context) {
        throw new Error("useCarousel must be used within a <Carousel />");
    }

    return context;
}

const Carousel = ({
    children,
    className,
    opts,
    orientation = "horizontal",
    plugins,
    ref,
    setApi,
    ...properties
}: CarouselProperties & HTMLAttributes<HTMLDivElement> & { ref?: React.RefObject<HTMLDivElement | null> }) => {
    const [carouselReference, api] = useEmblaCarousel(
        {
            ...opts,
            axis: orientation === "horizontal" ? "x" : "y",
        },
        plugins,
    );
    const [canScrollPrevious, setCanScrollPrevious] = useState(false);
    const [canScrollNext, setCanScrollNext] = useState(false);

    const onSelect = useCallback((api: CarouselApi) => {
        if (!api) {
            return;
        }

        setCanScrollPrevious(api.canScrollPrev());
        setCanScrollNext(api.canScrollNext());
    }, []);

    const scrollPrevious = useCallback(() => {
        api?.scrollPrev();
    }, [api]);

    const scrollNext = useCallback(() => {
        api?.scrollNext();
    }, [api]);

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                scrollPrevious();
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                scrollNext();
            }
        },
        [scrollPrevious, scrollNext],
    );

    useEffect(() => {
        if (!api || !setApi) {
            return;
        }

        setApi(api);
    }, [api, setApi]);

    useEffect(() => {
        if (!api) {
            return;
        }

        onSelect(api);
        api.on("reInit", onSelect);
        api.on("select", onSelect);

        return () => {
            api?.off("select", onSelect);
        };
    }, [api, onSelect]);

    return (
        <CarouselContext
            value={{
                api,
                canScrollNext,
                canScrollPrev: canScrollPrevious,
                carouselRef: carouselReference,
                opts,
                orientation: orientation || (opts?.axis === "y" ? "vertical" : "horizontal"),
                scrollNext,
                scrollPrev: scrollPrevious,
            }}
        >
            <div aria-roledescription="carousel" className={cn("relative", className)} onKeyDownCapture={handleKeyDown} ref={ref} role="region" {...properties}>
                {children}
            </div>
        </CarouselContext>
    );
};

Carousel.displayName = "Carousel";

const CarouselContent = ({
    classes,
    ref,
    ...properties
}: Omit<HTMLAttributes<HTMLDivElement> & { classes?: { root?: ClassValue; wrapper?: ClassValue } }, "className"> & {
    ref?: React.RefObject<HTMLDivElement | null>;
}) => {
    const { carouselRef, orientation } = useCarousel();

    return (
        <div className={cn("overflow-hidden", classes?.root)} ref={carouselRef}>
            <div className={cn("flex", orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col", classes?.wrapper)} ref={ref} {...properties} />
        </div>
    );
};

CarouselContent.displayName = "CarouselContent";

const CarouselItem = ({ className, ref, ...properties }: HTMLAttributes<HTMLDivElement> & { ref?: React.RefObject<HTMLDivElement | null> }) => {
    const { api, orientation } = useCarousel();

    return (
        <div
            aria-roledescription="slide"
            className={cn("min-w-0 shrink-0 grow-0 basis-full", orientation === "horizontal" ? "pl-4" : "pt-4", className)}
            ref={ref}
            role="group"
            {...properties}
        />
    );
};

CarouselItem.displayName = "CarouselItem";

const CarouselPrevious = ({
    className,
    ref,
    size = "icon",
    variant = "outline",
    ...properties
}: ComponentProps<typeof Button> & { ref?: React.RefObject<HTMLButtonElement | null> }) => {
    const { canScrollPrev, orientation, scrollPrev } = useCarousel();

    return (
        <Button
            className={cn(
                "absolute h-8 w-8 rounded-full",
                orientation === "horizontal" ? "top-1/2 -left-12 -translate-y-1/2" : "-top-12 left-1/2 -translate-x-1/2 rotate-90",
                className,
            )}
            disabled={!canScrollPrev}
            onClick={scrollPrev}
            ref={ref}
            size={size}
            variant={variant}
            {...properties}
        >
            <ArrowLeft className="h-4 w-4" />
            <span className="sr-only">Previous slide</span>
        </Button>
    );
};

CarouselPrevious.displayName = "CarouselPrevious";

const CarouselNext = ({
    className,
    ref,
    size = "icon",
    variant = "outline",
    ...properties
}: ComponentProps<typeof Button> & { ref?: React.RefObject<HTMLButtonElement | null> }) => {
    const { canScrollNext, orientation, scrollNext } = useCarousel();

    return (
        <Button
            className={cn(
                "absolute h-8 w-8 rounded-full",
                orientation === "horizontal" ? "top-1/2 -right-12 -translate-y-1/2" : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
                className,
            )}
            disabled={!canScrollNext}
            onClick={scrollNext}
            ref={ref}
            size={size}
            variant={variant}
            {...properties}
        >
            <ArrowRight className="h-4 w-4" />
            <span className="sr-only">Next slide</span>
        </Button>
    );
};

CarouselNext.displayName = "CarouselNext";

export { Carousel, type CarouselApi, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious, useCarousel };
