import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import { CheckIcon, ChevronDown, XCircle, XIcon } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Variants for the multi-select component to handle different styles.
 * Uses class-variance-authority (cva) to define different styles based on "variant" prop.
 */
const multiSelectVariants = cva("m-1 transition ease-in-out delay-150 hover:-translate-y-1 hover:scale-110 duration-300", {
    defaultVariants: {
        variant: "default",
    },
    variants: {
        variant: {
            default: "border-foreground/10 text-foreground bg-card hover:bg-card/80",
            destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
            inverted: "inverted",
            secondary: "border-foreground/10 bg-secondary text-secondary-foreground hover:bg-secondary/80",
        },
    },
});

/**
 * Props for MultiSelect component
 */
interface MultiSelectProperties extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof multiSelectVariants> {
    /**
     * Additional class names to apply custom styles to the multi-select component.
     * Optional, can be used to add custom styles.
     */
    className?: string;

    /** The default selected values when the component mounts. */
    defaultValue?: string[];

    /**
     * Maximum number of items to display. Extra selected items will be summarized.
     * Optional, defaults to 3.
     */
    maxCount?: number;

    /**
     * The modality of the popover. When set to true, interaction with outside elements
     * will be disabled and only popover content will be visible to screen readers.
     * Optional, defaults to false.
     */
    modalPopover?: boolean;

    /**
     * Callback function triggered when the selected values change.
     * Receives an array of the new selected values.
     */
    onValueChange: (value: string[]) => void;

    /**
     * An array of option objects to be displayed in the multi-select component.
     * Each option object has a label, value, and an optional icon.
     */
    options: {
        /** Optional icon component to display alongside the option. */
        icon?: React.ComponentType<{ className?: string }>;

        /** The text to display for the option. */
        label: string;

        /** The unique value associated with the option. */
        value: string;
    }[];

    /**
     * Placeholder text to be displayed when no values are selected.
     * Optional, defaults to "Select options".
     */
    placeholder?: string;
}

export const MultiSelect = ({
    className,
    defaultValue = [],
    maxCount = 3,
    modalPopover = false,
    onValueChange,
    options,
    placeholder = "Select options",
    ref,
    variant,
    ...properties
}: MultiSelectProperties & { ref?: React.RefObject<HTMLButtonElement | null> }) => {
    const [selectedValues, setSelectedValues] = React.useState(defaultValue);
    const [isPopoverOpen, setIsPopoverOpen] = React.useState(false);

    const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            setIsPopoverOpen(true);
        } else if (event.key === "Backspace" && !event.currentTarget.value) {
            const newSelectedValues = [...selectedValues];

            newSelectedValues.pop();
            setSelectedValues(newSelectedValues);
            onValueChange(newSelectedValues);
        }
    };

    const toggleOption = (option: string) => {
        const newSelectedValues = selectedValues.includes(option) ? selectedValues.filter((value) => value !== option) : [...selectedValues, option];

        setSelectedValues(newSelectedValues);
        onValueChange(newSelectedValues);
    };

    const handleClear = () => {
        setSelectedValues([]);
        onValueChange([]);
    };

    const handleTogglePopover = () => {
        setIsPopoverOpen((previous) => !previous);
    };

    const clearExtraOptions = () => {
        const newSelectedValues = selectedValues.slice(0, maxCount);

        setSelectedValues(newSelectedValues);
        onValueChange(newSelectedValues);
    };

    const toggleAll = () => {
        if (selectedValues.length === options.length) {
            handleClear();
        } else {
            const allValues = options.map((option) => option.value);

            setSelectedValues(allValues);
            onValueChange(allValues);
        }
    };

    const stopWheelEventPropagation: React.WheelEventHandler = (e) => {
        e.stopPropagation();
    };

    const stopTouchMoveEventPropagation: React.TouchEventHandler = (e) => {
        e.stopPropagation();
    };

    return (
        <Popover modal={modalPopover} onOpenChange={setIsPopoverOpen} open={isPopoverOpen}>
            <PopoverTrigger asChild>
                <Button
                    ref={ref}
                    {...properties}
                    className={cn(
                        "flex w-full p-1 border min-h-10 h-auto items-center justify-between bg-inherit hover:bg-inherit [&_svg]:pointer-events-auto",
                        className,
                    )}
                    key={selectedValues.join(",")}
                    onClick={handleTogglePopover}
                    type="button"
                >
                    {selectedValues.length > 0 ? (
                        <div className="flex justify-between items-center w-full">
                            <div className="flex flex-wrap items-center">
                                {selectedValues.slice(0, maxCount).map((value) => {
                                    const option = options.find((o) => o.value === value);
                                    const IconComponent = option?.icon;

                                    return (
                                        <Badge className={cn(multiSelectVariants({ variant }))} key={value}>
                                            {IconComponent && <IconComponent className="size-4 mr-2" />}
                                            {option?.label}
                                            <span
                                                className="ml-2 cursor-pointer hover:bg-white"
                                                onClick={(event) => {
                                                    toggleOption(value);
                                                }}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") {
                                                        toggleOption(value);
                                                    }
                                                }}
                                                onMouseDown={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                }}
                                                role="button"
                                            >
                                                <XCircle className="size-4" />
                                            </span>
                                        </Badge>
                                    );
                                })}
                                {selectedValues.length > maxCount && (
                                    <Badge
                                        className={cn(
                                            "bg-transparent text-foreground border-foreground/1 hover:bg-transparent",
                                            multiSelectVariants({ variant }),
                                        )}
                                    >
                                        {`+ ${selectedValues.length - maxCount} more`}
                                        <XCircle
                                            className="ml-2 size-4 cursor-pointer"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                clearExtraOptions();
                                            }}
                                        />
                                    </Badge>
                                )}
                            </div>
                            <div className="flex items-center justify-between">
                                <XIcon
                                    className="h-4 mx-2 cursor-pointer text-muted-foreground"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        handleClear();
                                    }}
                                />
                                <Separator className="flex min-h-6 h-full" orientation="vertical" />
                                <ChevronDown className="h-4 mx-2 cursor-pointer text-muted-foreground" />
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between w-full mx-auto">
                            <span className="text-sm text-muted-foreground mx-3">{placeholder}</span>
                            <ChevronDown className="h-4 cursor-pointer text-muted-foreground mx-2" />
                        </div>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-[var(--radix-popper-anchor-width)] p-0"
                onEscapeKeyDown={() => {
                    setIsPopoverOpen(false);
                }}
                onTouchMove={stopTouchMoveEventPropagation}
                onWheel={stopWheelEventPropagation}
            >
                <Command>
                    <CommandInput onKeyDown={handleInputKeyDown} placeholder="Search..." />
                    <CommandList>
                        <CommandEmpty>No results found.</CommandEmpty>
                        <CommandGroup>
                            <CommandItem className="cursor-pointer" key="all" onSelect={toggleAll}>
                                <div
                                    className={cn(
                                        "mr-2 flex size-4 items-center justify-center border border-white/20",
                                        selectedValues.length === options.length ? "bg-white/20 text-white" : "opacity-50 [&_svg]:invisible",
                                    )}
                                >
                                    <CheckIcon className="size-4" />
                                </div>
                                <span>(Select All)</span>
                            </CommandItem>
                            {options.map((option) => {
                                const isSelected = selectedValues.includes(option.value);

                                return (
                                    <CommandItem
                                        className="cursor-pointer"
                                        key={option.value}
                                        onSelect={() => {
                                            toggleOption(option.value);
                                        }}
                                    >
                                        <div
                                            className={cn(
                                                "mr-2 flex size-4 items-center justify-center border border-white/20",
                                                isSelected ? "bg-white/20 text-white" : "opacity-50 [&_svg]:invisible",
                                            )}
                                        >
                                            <CheckIcon className="size-4" />
                                        </div>
                                        {option.icon && <option.icon className="mr-2 size-4 text-muted-foreground" />}
                                        <span>{option.label}</span>
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                        <CommandSeparator />
                        <CommandGroup>
                            <div className="flex items-center justify-between">
                                {selectedValues.length > 0 && (
                                    <>
                                        <CommandItem className="flex-1 justify-center cursor-pointer" onSelect={handleClear}>
                                            Clear
                                        </CommandItem>
                                        <Separator className="flex min-h-6 h-full" orientation="vertical" />
                                    </>
                                )}
                                <CommandItem
                                    className="flex-1 justify-center cursor-pointer max-w-full"
                                    onSelect={() => {
                                        setIsPopoverOpen(false);
                                    }}
                                >
                                    Close
                                </CommandItem>
                            </div>
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};

MultiSelect.displayName = "MultiSelect";
