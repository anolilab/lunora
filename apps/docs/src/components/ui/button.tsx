import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ButtonHTMLAttributes, ElementType, JSX, RefObject } from "react";
import { createElement } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    {
        defaultVariants: {
            size: "default",
            variant: "default",
        },
        variants: {
            size: {
                default: "h-10 px-4 py-2",
                icon: "h-10 w-10",
                lg: "h-11 rounded-md px-8",
                sm: "h-9 rounded-md px-3",
            },
            variant: {
                default: "bg-primary text-primary-foreground hover:bg-primary/90",
                destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                expandIcon: "group relative text-primary-foreground bg-primary hover:bg-primary/90",
                ghost: "hover:bg-accent hover:text-accent-foreground",
                gooeyLeft:
                    "text-primary-foreground relative bg-primary z-0 overflow-hidden transition-all duration-500 after:absolute after:inset-0 after:-z-10 after:translate-x-[-150%] after:translate-y-[150%] after:scale-[2.5] after:rounded-[100%] after:bg-linear-to-l from-zinc-400 after:transition-transform after:duration-1000  hover:after:translate-x-[0%] hover:after:translate-y-[0%] ",
                gooeyRight:
                    "text-primary-foreground relative bg-primary z-0 overflow-hidden transition-all duration-500 before:absolute before:inset-0 before:-z-10 before:translate-x-[150%] before:translate-y-[150%] before:scale-[2.5] before:rounded-[100%] before:bg-linear-to-r from-zinc-400 before:transition-transform before:duration-1000  hover:before:translate-x-[0%] hover:before:translate-y-[0%] ",
                link: "text-primary underline-offset-4 hover:underline",
                linkHover1:
                    "relative after:absolute after:bg-primary after:bottom-2 after:h-[1px] after:w-2/3 after:origin-bottom-left after:scale-x-100 hover:after:origin-bottom-right hover:after:scale-x-0 after:transition-transform after:ease-in-out after:duration-300",
                linkHover2:
                    "relative after:absolute after:bg-primary after:bottom-2 after:h-[1px] after:w-2/3 after:origin-bottom-right after:scale-x-0 hover:after:origin-bottom-left hover:after:scale-x-100 after:transition-transform after:ease-in-out after:duration-300",
                outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
                ringHover:
                    "bg-primary text-primary-foreground transition-all duration-300 hover:bg-primary/90 hover:ring-2 hover:ring-primary/90 hover:ring-offset-2",
                secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
                shine: "text-primary-foreground animate-button-shine bg-linear-to-r from-primary via-primary/75 to-primary bg-[length:400%_100%] ",
            },
        },
    },
);

interface IconProperties {
    Icon: ElementType;
    iconPlacement: "left" | "right";
}
interface IconReferenceProperties {
    Icon?: never;
    iconPlacement?: never;
}

interface ButtonProperties extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

type ButtonIconProps = IconProperties | IconReferenceProperties;

const Button = ({
    asChild = false,
    className,
    Icon,
    iconPlacement,
    ref,
    size,
    variant,
    ...properties
}: ButtonIconProps & ButtonProperties & { ref?: RefObject<HTMLButtonElement | null> }): JSX.Element => {
    const Comp = asChild ? Slot.Slot : "button";

    return (
        // eslint-disable-next-line react/jsx-props-no-spreading -- forwarding native button attributes
        <Comp className={cn(buttonVariants({ className, size, variant }), Icon && "group")} ref={ref} {...properties}>
            {Icon && iconPlacement === "left" && (
                <div className="w-0 translate-x-[0%] pr-0 opacity-0 transition-all duration-200 group-hover:w-5 group-hover:translate-x-full group-hover:pr-2 group-hover:opacity-100">
                    {createElement(Icon)}
                </div>
            )}
            <Slot.Slottable>{properties.children}</Slot.Slottable>
            {Icon && iconPlacement === "right" && (
                <div className="w-0 translate-x-[100%] pl-0 opacity-0 transition-all duration-200 group-hover:w-5 group-hover:translate-x-0 group-hover:pl-2 group-hover:opacity-100">
                    {createElement(Icon)}
                </div>
            )}
        </Comp>
    );
};

Button.displayName = "Button";

export { Button, buttonVariants };
export type { ButtonIconProps, ButtonProperties };
