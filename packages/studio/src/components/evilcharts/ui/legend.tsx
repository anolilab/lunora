import * as React from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "../../../lib/utils";
import { getColorsCount, getPayloadConfigFromPayload, useChart } from "./chart";

type ChartLegendVariant = "square" | "circle" | "circle-outline" | "rounded-square" | "rounded-square-outline" | "vertical-bar" | "horizontal-bar";

const ChartLegendContent = ({
    className,
    hideIcon = false,
    nameKey,
    payload,
    verticalAlign,
    align = "right",
    selected,
    onSelectChange,
    isClickable,
    variant = "rounded-square",
}: React.ComponentProps<"div"> &
    RechartsPrimitive.DefaultLegendContentProps & {
        hideIcon?: boolean;
        isClickable?: boolean;
        nameKey?: string;
        onSelectChange?: (selected: string | null) => void;
        selected?: string | null;
        variant?: ChartLegendVariant;
    }): React.ReactElement | null => {
    const { config } = useChart();

    if (!payload?.length) {
        return null;
    }

    return (
        <div
            className={cn(
                "flex items-center gap-4 select-none",
                align === "left" && "justify-start",
                align === "center" && "justify-center",
                align === "right" && "justify-end",
                verticalAlign === "top" ? "pb-4" : "pt-4",
                className,
            )}
        >
            {/* react-doctor-disable-next-line react-doctor/js-combine-iterations -- two passes over the legend payload — one entry per rendered series */}
            {payload
                .filter((item) => item.type !== "none")
                .map((item) => {
                    // For pie charts, item.value contains the sector name (e.g., "chrome")
                    // For radial charts, the name is in item.payload[nameKey]
                    // For other charts, item.dataKey contains the series name (e.g., "desktop")
                    const payloadName = nameKey && item.payload ? (item.payload as Record<string, unknown>)[nameKey] : undefined;
                    const key = `${payloadName ?? item.value ?? item.dataKey ?? "value"}`;
                    const itemConfig = getPayloadConfigFromPayload(config, item, key);
                    const isSelected = selected === null || selected === key;

                    // Get colors count for this item to determine gradient vs solid
                    const colorsCount = itemConfig ? getColorsCount(itemConfig) : 1;

                    return (
                        <div
                            aria-pressed={isClickable ? selected === key : undefined}
                            className={cn(
                                "[&>svg]:text-muted-foreground flex items-center gap-1.5 transition-opacity [&>svg]:h-3 [&>svg]:w-3",
                                !isSelected && "opacity-30",
                                isClickable && "cursor-pointer",
                            )}
                            key={key}
                            onClick={() => {
                                if (!isClickable) {
                                    return;
                                }

                                onSelectChange?.(selected === key ? null : key);
                            }}
                            // Filtering a series by clicking its legend entry has to be
                            // reachable from the keyboard too: Enter/Space are what a
                            // button would answer to, and `role`/`tabIndex` only apply
                            // when the legend is actually interactive.
                            onKeyDown={(event) => {
                                if (!isClickable || (event.key !== "Enter" && event.key !== " ")) {
                                    return;
                                }

                                event.preventDefault();
                                onSelectChange?.(selected === key ? null : key);
                            }}
                            role={isClickable ? "button" : undefined}
                            tabIndex={isClickable ? 0 : undefined}
                        >
                            {itemConfig?.icon && !hideIcon ? (
                                <itemConfig.icon />
                            ) : (
                                <LegendIndicator colorsCount={colorsCount} dataKey={key} variant={variant} />
                            )}
                            {itemConfig?.label}
                        </div>
                    );
                })}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Legend indicator — each variant gets its own branch so future variants
// can diverge freely in markup & style.
// ---------------------------------------------------------------------------

const LegendIndicator = ({ variant, dataKey, colorsCount }: { colorsCount: number; dataKey: string; variant: ChartLegendVariant }): React.ReactElement => {
    const fillStyle = getLegendFillStyle(dataKey, colorsCount);
    const outlineStyle = getLegendOutlineStyle(dataKey, colorsCount);

    switch (variant) {
        case "circle": {
            return <div className="h-2 w-2 shrink-0 rounded-full" style={fillStyle} />;
        }

        case "circle-outline": {
            return <div className="h-2.5 w-2.5 shrink-0 rounded-full p-[1.5px]" style={outlineStyle} />;
        }

        case "horizontal-bar": {
            return <div className="h-1 w-3 shrink-0 rounded-[2px]" style={fillStyle} />;
        }

        case "rounded-square-outline": {
            return <div className="h-2.5 w-2.5 shrink-0 rounded-[3px] p-[1.5px]" style={outlineStyle} />;
        }

        case "square": {
            return <div className="h-2 w-2 shrink-0" style={fillStyle} />;
        }

        case "vertical-bar": {
            return <div className="h-3 w-1 shrink-0 rounded-[2px]" style={fillStyle} />;
        }

        case "rounded-square":
        default: {
            return <div className="h-2 w-2 shrink-0 rounded-[2px]" style={fillStyle} />;
        }
    }
};

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

/** Solid fill / gradient background for filled variants. */
function getLegendFillStyle(dataKey: string, colorsCount: number): React.CSSProperties {
    if (colorsCount <= 1) {
        return { backgroundColor: `var(--color-${dataKey}-0)` };
    }

    const stops = Array.from({ length: colorsCount }, (_, i) => {
        const offset = (i / (colorsCount - 1)) * 100;
        return `var(--color-${dataKey}-${i}) ${offset}%`;
    }).join(", ");

    return { background: `linear-gradient(to right, ${stops})` };
}

/**
 * Outline style for stroke variants.
 * Uses background + mask-composite to punch out the center, leaving only the
 * "border" visible. Works with both solid colors and gradients, and respects
 * border-radius — unlike plain `border-color`.
 */
function getLegendOutlineStyle(dataKey: string, colorsCount: number): React.CSSProperties {
    const maskStyle: React.CSSProperties = {
        WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        WebkitMaskComposite: "xor",
        mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        maskComposite: "exclude",
    };

    if (colorsCount <= 1) {
        return {
            backgroundColor: `var(--color-${dataKey}-0)`,
            ...maskStyle,
        };
    }

    const stops = Array.from({ length: colorsCount }, (_, i) => {
        const offset = (i / (colorsCount - 1)) * 100;
        return `var(--color-${dataKey}-${i}) ${offset}%`;
    }).join(", ");

    return {
        background: `linear-gradient(to right, ${stops})`,
        ...maskStyle,
    };
}

const ChartLegend: typeof RechartsPrimitive.Legend = RechartsPrimitive.Legend;

export { ChartLegend, ChartLegendContent, type ChartLegendVariant };
