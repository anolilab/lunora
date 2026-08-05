"use client";

import { LunoraError } from "@lunora/errors";
import * as React from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "../../../lib/utils";

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: "", dark: ".dark" } as const;

type ThemeKey = keyof typeof THEMES;

// All Keys are optional at first
type ThemeColorsBase = {
    [K in ThemeKey]?: string[];
};

// Require at least one theme key
type AtLeastOneThemeColor = {
    [K in ThemeKey]: Partial<Omit<ThemeColorsBase, K>> & Required<Pick<ThemeColorsBase, K>>;
}[ThemeKey];

const VALID_THEME_KEYS = Object.keys(THEMES) as ThemeKey[];

// Validation for chart config colors at runtime
function validateChartConfigColors(config: ChartConfig): void {
    for (const [key, value] of Object.entries(config)) {
        if (value.colors) {
            const hasValidThemeKey = VALID_THEME_KEYS.some((themeKey) => value.colors?.[themeKey] !== undefined);

            if (!hasValidThemeKey) {
                throw new LunoraError(
                    "INTERNAL",
                    `[EvilCharts] Invalid chart config for "${key}": colors object must have at least one theme key (${VALID_THEME_KEYS.join(", ")}). Received empty object or invalid keys.`,
                );
            }
        }
    }
}

export type ChartConfig = Record<
    string,
    {
        colors?: AtLeastOneThemeColor;
        icon?: React.ComponentType;
        label?: React.ReactNode;
    }
>;

interface ChartContextProps {
    config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextProps | null>(null);

export function useChart(): ChartContextProps {
    const context = React.useContext(ChartContext);

    if (!context) {
        throw new LunoraError("INTERNAL", "useChart must be used within a <ChartContainer />");
    }

    return context;
}

interface ChartContainerProps
    extends
        Omit<React.ComponentProps<"div">, "children">,
        Pick<
            React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>,
            "initialDimension" | "aspect" | "debounce" | "minHeight" | "minWidth" | "maxHeight" | "height" | "width" | "onResize" | "children"
        > {
    config: ChartConfig;
}

const ChartContainer = ({
    id,
    config,
    initialDimension = { width: 320, height: 200 },
    className,
    children,
    ...props
}: Readonly<ChartContainerProps>): React.ReactElement => {
    const uniqueId = React.useId();
    const chartId = `chart-${id ?? uniqueId.replaceAll(":", "")}`;

    // Validate chart config at runtime
    validateChartConfigColors(config);

    return (
        <ChartContext.Provider value={{ config }}>
            <div
                className={cn(
                    "min-h-0 w-full flex-1",
                    "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-axis-tick_text]:font-mono [&_.recharts-cartesian-axis-tick_text]:text-[11px] [&_.recharts-cartesian-axis-tick_text]:tracking-wide [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border relative flex flex-col justify-center text-xs [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
                    "aspect-video",
                    className,
                )}
                data-chart={chartId}
                data-slot="chart"
                {...props}
            >
                <ChartStyle config={config} id={chartId} />
                <RechartsPrimitive.ResponsiveContainer className="min-h-0 w-full flex-1" initialDimension={initialDimension}>
                    {children}
                </RechartsPrimitive.ResponsiveContainer>
            </div>
        </ChartContext.Provider>
    );
};

// Distribute colors evenly across slots, extra slots go to last color(s)
// Example: 2 colors for 4 slots → [red, red, pink, pink]
// Example: 3 colors for 4 slots → [red, pink, blue, blue]
function distributeColors(colorsArray: string[], maxCount: number): string[] {
    const availableCount = colorsArray.length;
    if (availableCount >= maxCount) {
        return colorsArray.slice(0, maxCount);
    }

    const result: string[] = [];
    const baseSlots = Math.floor(maxCount / availableCount);
    const extraSlots = maxCount % availableCount;

    // First (availableCount - extraSlots) colors get baseSlots each
    // Last extraSlots colors get (baseSlots + 1) each
    for (let colorIndex = 0; colorIndex < availableCount; colorIndex++) {
        const isExtraColor = colorIndex >= availableCount - extraSlots;
        const slotsForThisColor = baseSlots + (isExtraColor ? 1 : 0);
        for (let j = 0; j < slotsForThisColor; j++) {
            result.push(colorsArray[colorIndex] as string);
        }
    }

    return result;
}

const ChartStyle = ({ id, config }: { config: ChartConfig; id: string }): React.ReactElement | null => {
    const colorConfig = Object.entries(config).filter(([, config]) => config.colors);

    if (colorConfig.length === 0) {
        return null;
    }

    const generateCssVariables = (theme: keyof typeof THEMES) =>
        colorConfig
            .flatMap(([key, itemConfig]) => {
                const colorsArray = itemConfig.colors?.[theme];
                if (!colorsArray || !Array.isArray(colorsArray) || colorsArray.length === 0) {
                    return [];
                }

                // Get max count across all themes for this key
                const maxCount = getColorsCount(itemConfig);

                // Distribute colors evenly across all required slots
                const distributedColors = distributeColors(colorsArray, maxCount);

                return distributedColors.map((color, index) => `  --color-${key}-${index}: ${color};`);
            })
            .filter(Boolean)
            .join("\n");

    const css = Object.entries(THEMES)
        .map(([theme, prefix]) => `${prefix} [data-chart=${id}] {\n${generateCssVariables(theme as keyof typeof THEMES)}\n}`)
        .join("\n");

    return <style dangerouslySetInnerHTML={{ __html: css }} />;
};

// Helper to extract item config from a payload.
export function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string): ChartConfig[string] | undefined {
    if (typeof payload !== "object" || payload === null) {
        return undefined;
    }

    const payloadPayload = "payload" in payload && typeof payload.payload === "object" && payload.payload !== null ? payload.payload : undefined;

    let configLabelKey: string = key;

    if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
        configLabelKey = payload[key as keyof typeof payload];
    } else if (payloadPayload && key in payloadPayload && typeof payloadPayload[key as keyof typeof payloadPayload] === "string") {
        configLabelKey = payloadPayload[key as keyof typeof payloadPayload];
    }

    return configLabelKey in config ? config[configLabelKey] : config[key];
}

// Get max colors count across all themes for a config entry
function getColorsCount(config: ChartConfig[string]): number {
    if (!config.colors) {
        return 1;
    }
    const counts = VALID_THEME_KEYS.map((theme) => config.colors?.[theme]?.length ?? 0);
    return Math.max(...counts, 1);
}

export { ChartContainer, getColorsCount };
