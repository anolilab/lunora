import { Link } from "@tanstack/react-router";
import type { ClassValue } from "clsx";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { FC, PropsWithChildren } from "react";

import LineGrid from "@/components/sections/line-grid";
import { Button } from "@/components/ui/button";
import { Carousel, CarouselContent, useCarousel } from "@/components/ui/carousel";
import { cn } from "@/lib/utils";

const CarouselPrevious = ({
    className,
    ref,
    size = "icon",
    variant = "outline",
    ...properties
}: React.ComponentProps<typeof Button> & { ref?: React.RefObject<HTMLButtonElement | null> }) => {
    const { canScrollPrev, scrollPrev } = useCarousel();

    return (
        <Button className={cn("h-8 w-8", className)} disabled={!canScrollPrev} onClick={scrollPrev} ref={ref} size={size} variant={variant} {...properties}>
            <ArrowLeft className="h-4 w-4" />
            <span className="sr-only">Previous slide</span>
        </Button>
    );
};

CarouselPrevious.displayName = "CarouselSectionPrevious";

const CarouselNext = ({
    className,
    ref,
    size = "icon",
    variant = "outline",
    ...properties
}: React.ComponentProps<typeof Button> & { ref?: React.RefObject<HTMLButtonElement | null> }) => {
    const { canScrollNext, scrollNext } = useCarousel();

    return (
        <Button className={cn("h-8 w-8", className)} disabled={!canScrollNext} onClick={scrollNext} ref={ref} size={size} variant={variant} {...properties}>
            <ArrowRight className="h-4 w-4" />
            <span className="sr-only">Next slide</span>
        </Button>
    );
};

CarouselNext.displayName = "CarouselSectionNext";

const SectionCarousel: FC<PropsWithChildren<{ className?: ClassValue; link?: string; linkText?: string; title: string }>> = ({
    children,
    className,
    link,
    linkText,
    title,
}) => (
    <div className={cn("relative container mx-auto px-5 md:px-0", className)}>
        <LineGrid />
        <Carousel>
            <div className="flex flex-row items-center">
                <h2 className="text-wrap-balance text-3xl font-bold">{title}</h2>
                <div className="grow" />
                <div className="mb-10 flex items-center gap-5">
                    <CarouselPrevious />
                    <CarouselNext />
                    {link && linkText && (
                        <>
                            <div>|</div>
                            <Link className="flex flex-row gap-5 px-5" to={link}>
                                <span>{linkText}</span>
                                <ArrowRight />
                            </Link>
                        </>
                    )}
                </div>
            </div>
            <CarouselContent classes={{ root: "lg:ml-[25%] bg-ivory border-r border-y", wrapper: "lg:ml-0" }}>{children}</CarouselContent>
        </Carousel>
    </div>
);

export default SectionCarousel;
