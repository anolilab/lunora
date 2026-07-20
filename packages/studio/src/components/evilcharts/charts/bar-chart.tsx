"use client";

import { LunoraError } from "@lunora/errors";
import { motion, useReducedMotion } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, use, useId, useRef, useState } from "react";
import {
    Bar as RechartsBar,
    BarChart as RechartsBarChart,
    CartesianGrid,
    Rectangle,
    ReferenceLine,
    XAxis as RechartsXAxis,
    YAxis as RechartsYAxis,
} from "recharts";
import type { RectRadius } from "recharts/types/shape/Rectangle";

import type { BackgroundVariant } from "../ui/background";
import { ChartBackground } from "../ui/background";
import type { ChartConfig } from "../ui/chart";
import { ChartContainer, getColorsCount, getLoadingData, LoadingIndicator } from "../ui/chart";
import type { EvilBrushRange } from "../ui/evil-brush";
import { EvilBrush, useEvilBrush } from "../ui/evil-brush";
import type { ChartLegendVariant } from "../ui/legend";
import { ChartLegend, ChartLegendContent } from "../ui/legend";
import type { TooltipRoundness, TooltipVariant } from "../ui/tooltip";
import { ChartTooltip, ChartTooltipContent } from "../ui/tooltip";

// Constants
const DEFAULT_BAR_RADIUS = 2;
const LOADING_BAR_DATA_KEY = "loading";
const LOADING_ANIMATION_DURATION = 2000; // in milliseconds
const STACK_ID = "evil-stacked";
const BAR_GROW_DURATION = 0.5; // per-bar grow-in length, in seconds
const BAR_STAGGER = 0.05; // delay between consecutive bars, in seconds
const REVEAL_EASE: [number, number, number, number] = [0, 0.7, 0.5, 1]; // grow-in easing

type BarVariant = "default" | "hatched" | "duotone" | "duotone-reverse" | "gradient" | "stripped";
type StackType = "default" | "stacked" | "percent";
type BarLayout = "vertical" | "horizontal";

/**
 * Order in which bars grow into view. Recharts' own bar animation is permanently
 * disabled — every bar instead grows from its baseline (bottom for vertical
 * layout, left for horizontal), and this controls the stagger sequence.
 *
 * NOTE: the grow-in is a per-frame animation, so it is heavier than a static
 * chart. `"none"` opts out entirely; it is also what a device with the OS
 * "reduce motion" preference falls back to automatically.
 */
type BarAnimationType = "none" | "left-to-right" | "right-to-left" | "center-out" | "edges-in";

// ─────────────────────────────────────────────────────────────────────────────
// Shared context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared state for every part of the chart. Lifted into &lt;EvilBarChart /> so that
 * &lt;Bar />, &lt;XAxis />, &lt;Legend />, and friends can read it without prop drilling.
 * Sub-components are composed freely — the provider is the single source of truth.
 */
type BarChartContextValue = {
    animationType: BarAnimationType; // default grow-in order each <Bar /> inherits
    barRadius: number; // default corner radius each <Bar /> inherits
    config: ChartConfig; // colors + labels for every series
    dataLength: number; // number of rows currently rendered
    introStartedAt: number; // timestamp the chart mounted — anchors the one-shot grow-in
    isHorizontal: boolean; // whether bars are laid out horizontally
    isLoading: boolean; // whether the chart shows its loading skeleton
    isMouseInChart: boolean; // whether the pointer is currently over the chart
    isStacked: boolean; // whether bars stack on top of each other
    selectDataKey: (dataKey: string | null) => void; // sets the selected series
    selectedDataKey: string | null; // currently selected series, or null when none
};

const BarChartContext = createContext<BarChartContextValue | null>(null);

// Reads the chart context, throwing a helpful error when used outside <EvilBarChart />
function useBarChart() {
    const context = use(BarChartContext);

    if (!context) {
        throw new LunoraError("INTERNAL", "Bar chart parts (<Bar />, <XAxis />, …) must be used within <EvilBarChart />");
    }

    return context;
}

// ─────────────────────────────────────────────────────────────────────────────
// Root container
// ─────────────────────────────────────────────────────────────────────────────

// Validates that every config key also exists on the data row type
type ValidateConfigKeys<TData, TConfig> = {
    [K in keyof TConfig]: K extends keyof TData ? ChartConfig[string] : never;
};

type EvilBarChartBaseProps<TData extends Record<string, unknown>, TConfig extends Record<string, ChartConfig[string]>> = {
    animationType?: BarAnimationType; // default grow-in order for every <Bar />
    backgroundVariant?: BackgroundVariant; // background pattern drawn behind the chart
    barCategoryGap?: number; // gap between categories of bars
    barGap?: number; // gap between bars within the same category
    barRadius?: number; // default corner radius for every <Bar />
    brushFormatLabel?: (value: unknown, index: number) => string; // formats brush axis labels
    brushHeight?: number; // height of the brush preview in pixels
    chartProps?: ComponentProps<typeof RechartsBarChart>; // escape hatch for the raw Recharts chart
    children: ReactNode; // composed parts — <Bar />, <XAxis />, <Legend />, …
    className?: string; // extra classes for the chart container
    config: TConfig & ValidateConfigKeys<TData, TConfig>; // series colors + labels
    data: TData[]; // rows rendered by the chart
    defaultSelectedDataKey?: string | null; // series selected on first render
    isLoading?: boolean; // shows the animated loading skeleton
    layout?: BarLayout; // orientation of the bars
    loadingBars?: number; // number of bars in the loading skeleton
    onBrushChange?: (range: EvilBrushRange) => void; // fires when the brush range changes
    onSelectionChange?: (selectedDataKey: string | null) => void; // fires when the selected series changes
    showBrush?: boolean; // renders a zoom brush below the chart
    stackType?: StackType; // how multiple bars combine
    xDataKey?: keyof TData & string; // x-axis key — only needed for the brush footer
};

type EvilBarChartProps<TData extends Record<string, unknown>, TConfig extends Record<string, ChartConfig[string]>> = EvilBarChartBaseProps<TData, TConfig>;

/**
 * Root of the composible bar chart. Owns the data, the shared context, the
 * loading skeleton, and the optional zoom brush. Everything visual — axes,
 * grid, tooltip, legend, and the bars themselves — is composed as children,
 * so a consumer renders exactly the parts they need.
 */
export const EvilBarChart = <TData extends Record<string, unknown>, TConfig extends Record<string, ChartConfig[string]>>({
    config,
    data,
    children,
    className,
    chartProps,
    stackType = "default",
    layout = "vertical",
    barRadius = DEFAULT_BAR_RADIUS,
    animationType = "left-to-right",
    barGap,
    barCategoryGap,
    backgroundVariant,
    defaultSelectedDataKey = null,
    onSelectionChange,
    isLoading = false,
    loadingBars,
    showBrush = false,
    xDataKey,
    brushHeight,
    brushFormatLabel,
    onBrushChange,
}: EvilBarChartProps<TData, TConfig>): React.ReactElement => {
    const chartId = useId().replaceAll(":", ""); // colon-free id keeps CSS/SVG selectors valid
    // Anchors the grow-in to a fixed moment so it plays exactly once — re-renders
    // and Recharts' bar remounts read elapsed time from here instead of replaying.
    // Lazy useState stamps the time once, on the initial render only.
    const [introStartedAt] = useState(() => Date.now());
    const [selectedDataKey, setSelectedDataKey] = useState<string | null>(defaultSelectedDataKey);
    const [isMouseInChart, setIsMouseInChart] = useState(false);
    const { loadingData, onShimmerExit } = useLoadingData(isLoading, loadingBars);
    const { visibleData, brushProps } = useEvilBrush({ data });

    const isStacked = stackType === "stacked" || stackType === "percent";
    const isHorizontal = layout === "horizontal";
    const displayData = showBrush && !isLoading ? visibleData : data;

    // Updates selection state and notifies the parent
    const selectDataKey = (newSelectedDataKey: string | null) => {
        setSelectedDataKey(newSelectedDataKey);
        onSelectionChange?.(newSelectedDataKey);
    };

    const contextValue = {
        config,
        isStacked,
        isHorizontal,
        isLoading,
        barRadius,
        animationType,
        introStartedAt,
        dataLength: displayData.length,
        selectedDataKey,
        selectDataKey,
        isMouseInChart,
    };

    return (
        <BarChartContext value={contextValue}>
            <ChartContainer
                className={className}
                config={config}
                footer={
                    showBrush &&
                    !isLoading && (
                        <EvilBrush
                            barRadius={barRadius}
                            chartConfig={config}
                            className="mt-1"
                            data={data}
                            formatLabel={brushFormatLabel}
                            height={brushHeight}
                            skipStyle
                            stacked={isStacked}
                            variant="bar"
                            xDataKey={xDataKey}
                            {...brushProps}
                            onChange={(range) => {
                                brushProps.onChange(range);
                                onBrushChange?.(range);
                            }}
                        />
                    )
                }
            >
                <LoadingIndicator isLoading={isLoading} />
                <RechartsBarChart
                    accessibilityLayer
                    barCategoryGap={barCategoryGap}
                    barGap={barGap}
                    data={isLoading ? loadingData : displayData}
                    id={chartId}
                    layout={isHorizontal ? "vertical" : "horizontal"}
                    onMouseEnter={() => {
                        setIsMouseInChart(true);
                    }}
                    onMouseLeave={() => {
                        setIsMouseInChart(false);
                    }}
                    stackOffset={stackType === "percent" ? "expand" : undefined}
                    {...chartProps}
                >
                    {backgroundVariant && <ChartBackground variant={backgroundVariant} />}
                    <ReferenceLine stroke="var(--border)" />
                    {children}
                    {isLoading && <LoadingBar chartId={chartId} onShimmerExit={onShimmerExit} />}
                </RechartsBarChart>
            </ChartContainer>
        </BarChartContext>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Composible parts
// ─────────────────────────────────────────────────────────────────────────────

type BarProps = {
    animationType?: BarAnimationType; // grow-in order — falls back to the chart default
    barProps?: ComponentProps<typeof RechartsBar>; // escape hatch for raw Recharts Bar props
    bufferBar?: boolean; // renders the last data point as a hatched "buffer" bar
    dataKey: string; // series key — must exist on the data and config
    enableHoverHighlight?: boolean; // dims this bar while another bar is hovered
    glowing?: boolean; // applies a soft outer glow to this bar
    isClickable?: boolean; // lets this bar be selected by clicking it
    radius?: number; // corner radius — falls back to the chart default
    variant?: BarVariant; // fill style for this bar only
};

/**
 * A single bar series. Each &lt;Bar /> is fully self-contained: it generates its
 * own gradient/pattern definitions under a unique id, so any number of bars —
 * each with its own variant, radius, glow, and clickability — can live in one
 * chart without style collisions.
 */
export const Bar = ({
    dataKey,
    variant = "default",
    radius,
    animationType,
    isClickable = false,
    enableHoverHighlight = false,
    glowing = false,
    bufferBar = false,
    barProps,
}: BarProps): React.ReactElement | null => {
    const {
        config,
        isStacked,
        isHorizontal,
        isLoading,
        barRadius: defaultRadius,
        animationType: defaultAnimation,
        introStartedAt,
        dataLength,
        selectedDataKey,
        selectDataKey,
        isMouseInChart,
    } = useBarChart();
    const id = useId().replaceAll(":", ""); // unique id scopes this bar's style defs
    // Devices set to "reduce motion" skip the grow-in animation entirely
    const shouldReduceMotion = useReducedMotion();

    // The root renders the skeleton bar while loading, so real bars step aside
    if (isLoading) {
        return null;
    }

    const resolvedRadius = radius ?? defaultRadius;
    const isSelected = selectedDataKey === dataKey;

    // The grow-in is a per-frame animation — heavier than a static chart — so
    // `"none"` and the OS reduce-motion preference both opt out of it.
    const revealType: BarAnimationType = shouldReduceMotion ? "none" : (animationType ?? defaultAnimation);

    const customBarProps = {
        id,
        dataKey,
        variant,
        barRadius: resolvedRadius,
        glowing,
        bufferBar,
        isClickable,
        enableHoverHighlight,
        isMouseInChart,
        isHorizontal,
        introStartedAt,
        selectedDataKey,
        dataLength,
        onClick: () => {
            if (!isClickable) {
                return;
            }
            // Clicking the selected bar clears the selection, otherwise selects it
            selectDataKey(isSelected ? null : dataKey);
        },
    };

    return (
        <>
            <RechartsBar
                activeBar={(props: unknown) => (
                    // The active (hovered) bar must never re-run the grow-in animation
                    <CustomBar {...(props as BarShapeProps)} {...customBarProps} animationType="none" />
                )}
                dataKey={dataKey}
                fill={`url(#${id}-colors-${dataKey})`}
                // Recharts' built-in bar animation is permanently disabled — every bar
                // instead grows in from its baseline via the staggered motion.dev shape.
                isAnimationActive={false}
                radius={resolvedRadius}
                shape={(props: unknown) => <CustomBar {...(props as BarShapeProps)} {...customBarProps} animationType={revealType} />}
                stackId={isStacked ? STACK_ID : undefined}
                style={isClickable || enableHoverHighlight ? { cursor: "pointer" } : undefined}
                {...barProps}
            />
            <defs>
                <ColorGradient config={config} dataKey={dataKey} id={id} />
                {variant === "hatched" && <HatchedPattern dataKey={dataKey} id={id} />}
                {variant === "duotone" && <DuotonePattern config={config} dataKey={dataKey} id={id} />}
                {variant === "duotone-reverse" && <DuotoneReversePattern config={config} dataKey={dataKey} id={id} />}
                {variant === "gradient" && <GradientPattern dataKey={dataKey} id={id} />}
                {variant === "stripped" && <StrippedPattern dataKey={dataKey} id={id} />}
                {bufferBar && <BufferHatchedPattern dataKey={dataKey} id={id} />}
                {glowing && <GlowFilter dataKey={dataKey} id={id} />}
            </defs>
        </>
    );
};

type XAxisProps = ComponentProps<typeof RechartsXAxis>;

/**
 * The category axis. Ships with the chart's flat default styling and forwards
 * every Recharts XAxis prop, so `dataKey`, `tickFormatter`, etc. are passed
 * straight through. Hidden automatically while the chart is loading. Resolves
 * its axis type from the chart layout — categorical when vertical, numeric
 * when the bars run horizontally.
 */
export const XAxis = ({ tickLine = false, axisLine = false, tickMargin = 8, minTickGap = 8, type, ...props }: XAxisProps): React.ReactElement | null => {
    const { isLoading, isHorizontal } = useBarChart();

    if (isLoading) {
        return null;
    }

    return (
        <RechartsXAxis
            axisLine={axisLine}
            minTickGap={minTickGap}
            tickLine={tickLine}
            tickMargin={tickMargin}
            type={type ?? (isHorizontal ? "number" : "category")}
            {...props}
        />
    );
};

type YAxisProps = ComponentProps<typeof RechartsYAxis>;

/**
 * The value axis. Forwards every Recharts YAxis prop and resolves its axis type
 * from the chart layout — numeric when vertical, categorical when the bars run
 * horizontally. Hidden automatically while the chart is loading.
 */
export const YAxis = ({
    tickLine = false,
    axisLine = false,
    tickMargin = 8,
    minTickGap = 8,
    width = "auto",
    type,
    ...props
}: YAxisProps): React.ReactElement | null => {
    const { isLoading, isHorizontal } = useBarChart();

    if (isLoading) {
        return null;
    }

    return (
        <RechartsYAxis
            axisLine={axisLine}
            minTickGap={minTickGap}
            tickLine={tickLine}
            tickMargin={tickMargin}
            type={type ?? (isHorizontal ? "category" : "number")}
            width={width}
            {...props}
        />
    );
};

type GridProps = ComponentProps<typeof CartesianGrid>;

/**
 * The background grid lines. Defaults to dashed lines aligned to the value
 * axis based on the chart layout, and forwards every Recharts CartesianGrid
 * prop for full control.
 */
export const Grid = ({ strokeDasharray = "3 3", vertical, horizontal, ...props }: GridProps): React.ReactElement => {
    const { isHorizontal } = useBarChart();

    return <CartesianGrid horizontal={horizontal ?? !isHorizontal} strokeDasharray={strokeDasharray} vertical={vertical ?? isHorizontal} {...props} />;
};

type TooltipProps = {
    defaultIndex?: number; // data index shown by default with no hover
    roundness?: TooltipRoundness; // border-radius of the tooltip
    variant?: TooltipVariant; // visual style of the tooltip surface
};

/**
 * The hover tooltip. Reads the chart's selection from context so its content
 * dims unselected series. Hidden automatically while the chart is loading.
 */
export const Tooltip = ({ variant, roundness, defaultIndex }: TooltipProps): React.ReactElement | null => {
    const { isLoading, selectedDataKey } = useBarChart();

    if (isLoading) {
        return null;
    }

    return (
        <ChartTooltip
            content={<ChartTooltipContent roundness={roundness} selected={selectedDataKey} variant={variant} />}
            cursor={false}
            defaultIndex={defaultIndex}
        />
    );
};

type LegendProps = {
    align?: "left" | "center" | "right"; // horizontal placement
    isClickable?: boolean; // lets each entry toggle selection of its series
    variant?: ChartLegendVariant; // visual style of the legend indicators
    verticalAlign?: "top" | "middle" | "bottom"; // vertical placement
};

/**
 * The series legend. When `isClickable` is set, each entry toggles selection of
 * its series, driving the shared selection state read by every &lt;Bar />.
 */
export const Legend = ({ variant, align = "right", verticalAlign = "top", isClickable = false }: LegendProps): React.ReactElement => {
    const { selectedDataKey, selectDataKey } = useBarChart();

    return (
        <ChartLegend
            align={align}
            content={<ChartLegendContent isClickable={isClickable} onSelectChange={selectDataKey} selected={selectedDataKey} variant={variant} />}
            verticalAlign={verticalAlign}
        />
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Custom bar shape
// ─────────────────────────────────────────────────────────────────────────────

// Raw geometry Recharts hands to a custom bar shape
type BarShapeProps = {
    [key: string]: unknown;
    dataKey?: string;
    fill?: string;
    fillOpacity?: number;
    height?: number;
    index?: number;
    width?: number;
    x?: number;
    y?: number;
};

// Per-series config the <Bar /> threads into every CustomBar render
type CustomBarProps = BarShapeProps & {
    animationType?: BarAnimationType;
    barRadius: number;
    bufferBar?: boolean;
    dataKey: string;
    dataLength?: number;
    enableHoverHighlight?: boolean;
    glowing?: boolean;
    id: string;
    introStartedAt?: number;
    isActive?: boolean;
    isClickable?: boolean;
    isHorizontal?: boolean;
    isMouseInChart?: boolean;
    onClick?: () => void;
    selectedDataKey?: string | null;
    variant: BarVariant;
};

/**
 * Custom bar shape. Renders the visible bar painted by the owning &lt;Bar />'s
 * variant pattern, with an invisible full-height rectangle behind it to keep
 * the whole column hoverable and clickable.
 */
const CustomBar = (props: CustomBarProps): React.ReactElement => {
    const {
        x = 0,
        y = 0,
        width = 0,
        height = 0,
        id,
        dataKey,
        variant,
        barRadius,
        glowing,
        bufferBar,
        isClickable,
        enableHoverHighlight,
        isMouseInChart,
        isHorizontal = false,
        animationType = "none",
        introStartedAt = 0,
        selectedDataKey,
        isActive,
        dataLength = 0,
        onClick,
    } = props;

    const index = typeof props.index === "number" ? props.index : -1;
    const isLastBar = bufferBar && dataLength > 0 && index === dataLength - 1;
    const isStripped = variant === "stripped";
    const grow = getBarGrowAnimation(animationType, index, dataLength, isHorizontal, introStartedAt);

    const fill = isLastBar ? `url(#${id}-buffer-hatched-${dataKey})` : getVariantFill(variant, id, dataKey);
    const filter = glowing ? `url(#${id}-bar-glow-${dataKey})` : undefined;

    const fillOpacity = getBarOpacity({
        isClickable,
        selectedDataKey,
        dataKey,
        enableHoverHighlight,
        isMouseInChart,
        isActive,
    });
    const cursorStyle = isClickable || enableHoverHighlight ? { cursor: "pointer" } : undefined;

    // Stripped bars round only their top corners; every other variant rounds all four
    const radius: RectRadius = isStripped ? [barRadius, barRadius, 0, 0] : barRadius;

    // The visible, painted bar — plus the stripped variant's solid top strip
    const visibleBar = (
        <>
            <Rectangle
                fill={fill}
                filter={filter}
                height={Math.max(0, height - 3)}
                opacity={fillOpacity}
                radius={radius}
                stroke={isLastBar ? `url(#${id}-colors-${dataKey})` : undefined}
                strokeWidth={isLastBar ? 1 : undefined}
                width={width}
                x={x}
                y={y}
            />
            {isStripped && <Rectangle fill={`url(#${id}-colors-${dataKey})`} height={2} radius={1} width={width} x={x} y={y - 4} />}
        </>
    );

    return (
        <g onClick={onClick} style={cursorStyle}>
            {/* Full-height invisible rect keeps the whole column hoverable/clickable */}
            <Rectangle {...props} fill="transparent" />
            {/* The painted bar grows in from its baseline; the hit rect above stays put */}
            {grow ? (
                <motion.g animate={grow.animate} initial={grow.initial} style={grow.style} transition={grow.transition}>
                    {visibleBar}
                </motion.g>
            ) : (
                visibleBar
            )}
        </g>
    );
};

/**
 * Builds the motion.dev grow-in animation for a single bar, or returns `null`
 * when the bar should render statically (`"none"`, reduced motion, an unknown
 * index, or — crucially — once the bar has already finished growing).
 *
 * Every bar grows from its baseline — `scaleY` from the bottom for vertical
 * layout, `scaleX` from the left for horizontal — and `animationType` decides
 * the stagger order, so the chart fills in one bar at a time.
 *
 * The intro is anchored to `introStartedAt` (stamped once when the chart
 * mounts) rather than to component mount. Recharts remounts every bar whenever
 * the chart re-renders — e.g. on hover-highlight — so a mount-based animation
 * would replay endlessly. Reading elapsed time instead makes it a true
 * one-shot: a bar past its window renders static, and a bar caught mid-grow
 * resumes from the progress it should already be at.
 */
const getBarGrowAnimation = (animationType: BarAnimationType, index: number, dataLength: number, isHorizontal: boolean, introStartedAt: number) => {
    if (animationType === "none" || index < 0 || dataLength <= 0) {
        return null;
    }

    const lastIndex = dataLength - 1;
    const center = lastIndex / 2;

    // How many bars this one waits behind before it starts growing
    let step: number;
    switch (animationType) {
        case "center-out": {
            step = Math.abs(index - center);
            break;
        }
        case "edges-in": {
            step = center - Math.abs(index - center);
            break;
        }
        case "right-to-left": {
            step = lastIndex - index;
            break;
        }
        default: {
            // left-to-right
            step = index;
        }
    }

    const startMs = step * BAR_STAGGER * 1000;
    const durationMs = BAR_GROW_DURATION * 1000;
    const endMs = startMs + durationMs;
    const elapsed = Date.now() - introStartedAt;

    // Already finished — render static so re-renders/remounts can't replay it
    if (elapsed >= endMs) {
        return null;
    }

    // Resume from wherever this bar should already be: 0 before it starts,
    // partway through if a remount caught it mid-grow.
    const from = elapsed <= startMs ? 0 : (elapsed - startMs) / durationMs;
    const transition = {
        duration: (endMs - Math.max(elapsed, startMs)) / 1000,
        ease: REVEAL_EASE,
        delay: Math.max(0, startMs - elapsed) / 1000,
    };

    // Horizontal bars grow rightward from the left edge, vertical from the bottom
    return isHorizontal
        ? { initial: { scaleX: from }, animate: { scaleX: 1 }, transition, style: { originX: 0 } }
        : { initial: { scaleY: from }, animate: { scaleY: 1 }, transition, style: { originY: 1 } };
};

// ─────────────────────────────────────────────────────────────────────────────
// Selection + fill helpers
// ─────────────────────────────────────────────────────────────────────────────

// Resolves the SVG paint reference for a bar's fill based on its variant
const getVariantFill = (variant: BarVariant, id: string, dataKey: string): string => {
    switch (variant) {
        case "duotone": {
            return `url(#${id}-duotone-${dataKey})`;
        }
        case "duotone-reverse": {
            return `url(#${id}-duotone-reverse-${dataKey})`;
        }
        case "gradient": {
            return `url(#${id}-gradient-${dataKey})`;
        }
        case "hatched": {
            return `url(#${id}-hatched-${dataKey})`;
        }
        case "stripped": {
            return `url(#${id}-stripped-${dataKey})`;
        }
        default: {
            return `url(#${id}-colors-${dataKey})`;
        }
    }
};

// Computes bar opacity from the click selection and hover-highlight state
const getBarOpacity = ({
    isClickable,
    selectedDataKey,
    dataKey,
    enableHoverHighlight,
    isMouseInChart,
    isActive,
}: {
    dataKey: string;
    enableHoverHighlight?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
    isMouseInChart?: boolean;
    selectedDataKey?: string | null;
}) => {
    const isSelectedDataKey = selectedDataKey === null || selectedDataKey === dataKey;
    const clickOpacity = isClickable && selectedDataKey !== null ? (isSelectedDataKey ? 1 : 0.3) : 1;

    // While hovering, the hovered bar keeps its click opacity and the rest dim further
    if (enableHoverHighlight && isMouseInChart) {
        return isActive ? clickOpacity : clickOpacity * 0.3;
    }

    return clickOpacity;
};

// ─────────────────────────────────────────────────────────────────────────────
// Style definitions — one set per <Bar />, scoped to its unique id
// ─────────────────────────────────────────────────────────────────────────────

type StyleProps = {
    dataKey: string; // series key the colors belong to
    id: string; // unique id of the owning <Bar />
};

/**
 * Vertical top-to-bottom color gradient for a series. Always rendered — every
 * fill variant and the buffer-bar stroke paint from this single gradient.
 */
const ColorGradient = ({ id, dataKey, config }: StyleProps & { config: ChartConfig }): React.ReactElement => {
    const colorsCount = getColorsCount(config[dataKey] ?? {});

    return (
        <linearGradient id={`${id}-colors-${dataKey}`} x1="0" x2="0" y1="0" y2="1">
            {colorsCount === 1 ? (
                <>
                    <stop offset="0%" stopColor={`var(--color-${dataKey}-0)`} />
                    <stop offset="100%" stopColor={`var(--color-${dataKey}-0)`} />
                </>
            ) : (
                Array.from({ length: colorsCount }, (_, index) => {
                    const offset = `${(index / (colorsCount - 1)) * 100}%`;
                    return <stop key={offset} offset={offset} stopColor={`var(--color-${dataKey}-${index}, var(--color-${dataKey}-0))`} />;
                })
            )}
        </linearGradient>
    );
};

/** Diagonal hatched-stripe fill, masked from the series color gradient. */
const HatchedPattern = ({ id, dataKey }: StyleProps): React.ReactElement => (
    <>
        <pattern height="5" id={`${id}-hatched-mask-pattern`} patternTransform="rotate(-45)" patternUnits="userSpaceOnUse" width="5" x="0" y="0">
            <rect fill="white" fillOpacity={0.3} height="5" width="5" />
            <rect fill="white" fillOpacity={1} height="5" width="1.5" />
        </pattern>
        <mask id={`${id}-hatched-mask-${dataKey}`}>
            <rect fill={`url(#${id}-hatched-mask-pattern)`} height="100%" width="100%" />
        </mask>
        <pattern height="100%" id={`${id}-hatched-${dataKey}`} patternUnits="userSpaceOnUse" width="100%">
            <rect fill={`url(#${id}-colors-${dataKey})`} height="100%" mask={`url(#${id}-hatched-mask-${dataKey})`} width="100%" />
        </pattern>
    </>
);

/** Hatched diagonal lines with no background fill, used for the buffer bar. */
const BufferHatchedPattern = ({ id, dataKey }: StyleProps): React.ReactElement => (
    <>
        <pattern height="5" id={`${id}-buffer-hatched-mask-pattern`} patternTransform="rotate(-45)" patternUnits="userSpaceOnUse" width="5" x="0" y="0">
            <rect fill="black" fillOpacity={0} height="5" width="5" />
            <rect fill="white" fillOpacity={1} height="5" width="1" />
        </pattern>
        <mask id={`${id}-buffer-hatched-mask-${dataKey}`}>
            <rect fill={`url(#${id}-buffer-hatched-mask-pattern)`} height="100%" width="100%" />
        </mask>
        <pattern height="100%" id={`${id}-buffer-hatched-${dataKey}`} patternUnits="userSpaceOnUse" width="100%">
            <rect fill={`url(#${id}-colors-${dataKey})`} height="100%" mask={`url(#${id}-buffer-hatched-mask-${dataKey})`} width="100%" />
        </pattern>
    </>
);

/** Two-tone fill — a half-faded, half-solid split applied per bar bounding box. */
const DuotonePattern = ({ id, dataKey, config }: StyleProps & { config: ChartConfig }): React.ReactElement => {
    const colorsCount = getColorsCount(config[dataKey] ?? {});

    return (
        <>
            <linearGradient gradientUnits="objectBoundingBox" id={`${id}-duotone-mask-gradient-${dataKey}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="50%" stopColor="white" stopOpacity={0.4} />
                <stop offset="50%" stopColor="white" stopOpacity={1} />
            </linearGradient>
            <linearGradient gradientUnits="objectBoundingBox" id={`${id}-duotone-colors-${dataKey}`} x1="0" x2="0" y1="0" y2="1">
                {colorsCount === 1 ? (
                    <>
                        <stop offset="0%" stopColor={`var(--color-${dataKey}-0)`} />
                        <stop offset="100%" stopColor={`var(--color-${dataKey}-0)`} />
                    </>
                ) : (
                    Array.from({ length: colorsCount }, (_, index) => {
                        const offset = `${(index / (colorsCount - 1)) * 100}%`;
                        return <stop key={offset} offset={offset} stopColor={`var(--color-${dataKey}-${index}, var(--color-${dataKey}-0))`} />;
                    })
                )}
            </linearGradient>
            <mask id={`${id}-duotone-mask-${dataKey}`} maskContentUnits="objectBoundingBox">
                <rect fill={`url(#${id}-duotone-mask-gradient-${dataKey})`} height="1" width="1" x="0" y="0" />
            </mask>
            <pattern height="1" id={`${id}-duotone-${dataKey}`} patternContentUnits="objectBoundingBox" patternUnits="objectBoundingBox" width="1">
                <rect fill={`url(#${id}-duotone-colors-${dataKey})`} height="1" mask={`url(#${id}-duotone-mask-${dataKey})`} width="1" x="0" y="0" />
            </pattern>
        </>
    );
};

/** Two-tone fill with the solid and faded halves reversed from `duotone`. */
const DuotoneReversePattern = ({ id, dataKey, config }: StyleProps & { config: ChartConfig }): React.ReactElement => {
    const colorsCount = getColorsCount(config[dataKey] ?? {});

    return (
        <>
            <linearGradient gradientUnits="objectBoundingBox" id={`${id}-duotone-reverse-mask-gradient-${dataKey}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="50%" stopColor="white" stopOpacity={1} />
                <stop offset="50%" stopColor="white" stopOpacity={0.4} />
            </linearGradient>
            <linearGradient gradientUnits="objectBoundingBox" id={`${id}-duotone-reverse-colors-${dataKey}`} x1="0" x2="0" y1="0" y2="1">
                {colorsCount === 1 ? (
                    <>
                        <stop offset="0%" stopColor={`var(--color-${dataKey}-0)`} />
                        <stop offset="100%" stopColor={`var(--color-${dataKey}-0)`} />
                    </>
                ) : (
                    Array.from({ length: colorsCount }, (_, index) => {
                        const offset = `${(index / (colorsCount - 1)) * 100}%`;
                        return <stop key={offset} offset={offset} stopColor={`var(--color-${dataKey}-${index}, var(--color-${dataKey}-0))`} />;
                    })
                )}
            </linearGradient>
            <mask id={`${id}-duotone-reverse-mask-${dataKey}`} maskContentUnits="objectBoundingBox">
                <rect fill={`url(#${id}-duotone-reverse-mask-gradient-${dataKey})`} height="1" width="1" x="0" y="0" />
            </mask>
            <pattern height="1" id={`${id}-duotone-reverse-${dataKey}`} patternContentUnits="objectBoundingBox" patternUnits="objectBoundingBox" width="1">
                <rect
                    fill={`url(#${id}-duotone-reverse-colors-${dataKey})`}
                    height="1"
                    mask={`url(#${id}-duotone-reverse-mask-${dataKey})`}
                    width="1"
                    x="0"
                    y="0"
                />
            </pattern>
        </>
    );
};

/** Gradient fill that fades the series color from solid at the top to clear. */
const GradientPattern = ({ id, dataKey }: StyleProps): React.ReactElement => (
    <>
        <linearGradient id={`${id}-gradient-mask-gradient`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="20%" stopColor="white" stopOpacity={1} />
            <stop offset="90%" stopColor="white" stopOpacity={0} />
        </linearGradient>
        <mask id={`${id}-gradient-mask-${dataKey}`}>
            <rect fill={`url(#${id}-gradient-mask-gradient)`} height="100%" width="100%" />
        </mask>
        <pattern height="100%" id={`${id}-gradient-${dataKey}`} patternUnits="userSpaceOnUse" width="100%">
            <rect fill={`url(#${id}-colors-${dataKey})`} height="100%" mask={`url(#${id}-gradient-mask-${dataKey})`} width="100%" />
        </pattern>
    </>
);

/** Low-opacity body fill, paired with a solid top strip drawn by CustomBar. */
const StrippedPattern = ({ id, dataKey }: StyleProps): React.ReactElement => (
    <>
        <linearGradient id={`${id}-stripped-mask-gradient`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity={0.2} />
            <stop offset="100%" stopColor="white" stopOpacity={0.2} />
        </linearGradient>
        <mask id={`${id}-stripped-mask-${dataKey}`}>
            <rect fill={`url(#${id}-stripped-mask-gradient)`} height="100%" width="100%" />
        </mask>
        <pattern height="100%" id={`${id}-stripped-${dataKey}`} patternUnits="userSpaceOnUse" width="100%">
            <rect fill={`url(#${id}-colors-${dataKey})`} height="100%" mask={`url(#${id}-stripped-mask-${dataKey})`} width="100%" />
        </pattern>
    </>
);

/** Soft outer-glow filter applied to a glowing bar. */
const GlowFilter = ({ id, dataKey }: StyleProps): React.ReactElement => (
    <filter height="300%" id={`${id}-bar-glow-${dataKey}`} width="300%" x="-100%" y="-100%">
        <feGaussianBlur in="SourceGraphic" result="blur" stdDeviation="8" />
        <feColorMatrix
            in="blur"
            result="glow"
            type="matrix"
            values="1 0 0 0 0
                0 1 0 0 0
                0 0 1 0 0
                0 0 0 0.5 0"
        />
        <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
        </feMerge>
    </filter>
);

// ─────────────────────────────────────────────────────────────────────────────
// Loading skeleton
// ─────────────────────────────────────────────────────────────────────────────

// Builds bell-curve eased gradient stops for the loading shimmer
const generateEasedGradientStops = (steps: number = 17, minOpacity: number = 0.05, maxOpacity: number = 0.9) =>
    Array.from({ length: steps }, (_, i) => {
        const t = i / (steps - 1); // 0 to 1
        // Sine-based bell curve easing: peaks at center (t=0.5), smooth falloff at edges
        const eased = Math.sin(t * Math.PI) ** 2;
        const opacity = minOpacity + eased * (maxOpacity - minOpacity);
        return { offset: `${(t * 100).toFixed(0)}%`, opacity: Number(opacity.toFixed(3)) };
    });

/**
 * Hook to manage loading data with pixel-perfect shimmer synchronization.
 *
 * Uses motion.dev's onUpdate callback to ensure chart data is only regenerated
 * when the shimmer has completely exited the visible area. This eliminates
 * timing drift issues from setTimeout/setInterval.
 */
export function useLoadingData(isLoading: boolean, loadingBars: number = 12): { loadingData: { loading: number }[]; onShimmerExit: () => void } {
    const [, setLoadingDataKey] = useState(false);

    // Callback fired by motion.dev when the shimmer exits the visible area
    const onShimmerExit = () => {
        if (isLoading) {
            setLoadingDataKey((previous) => !previous);
        }
    };

    const loadingData = getLoadingData(loadingBars, 20, 80);

    return { loadingData, onShimmerExit };
}

/**
 * The skeleton bar shown while the chart is loading. Rendered by the root in
 * place of the real bars, paired with its own masked shimmer pattern.
 */
const LoadingBar = ({ chartId, onShimmerExit }: { chartId: string; onShimmerExit: () => void }): React.ReactElement => (
    <>
        <RechartsBar
            dataKey={LOADING_BAR_DATA_KEY}
            fill="currentColor"
            fillOpacity={0.15}
            isAnimationActive={false}
            legendType="none"
            radius={DEFAULT_BAR_RADIUS}
            style={{ mask: `url(#${chartId}-loading-mask)` }}
        />
        <defs>
            <LoadingBarPattern chartId={chartId} onShimmerExit={onShimmerExit} />
        </defs>
    </>
);

/**
 * Animated shimmer pattern for the loading skeleton.
 *
 * The visible chart area is normalized to 0-1, the shimmer gradient has width 1,
 * and the pattern is 3x wide so the shimmer has buffer on both sides. The motion
 * rect travels x from -1 to 2; onShimmerExit fires as it crosses x=1, letting the
 * data swap happen while the shimmer is off-screen for a seamless loop.
 */
const LoadingBarPattern = ({ chartId, onShimmerExit }: { chartId: string; onShimmerExit: () => void }): React.ReactElement => {
    const gradientStops = generateEasedGradientStops();

    // 1 (left buffer) + 1 (visible) + 1 (right buffer)
    const patternWidth = 3;
    const startX = -1;
    const endX = 2;

    // Tracks the last x value to detect the exit threshold crossing
    const lastXRef = useRef(startX);

    return (
        <>
            <linearGradient id={`${chartId}-loading-mask-gradient`} x1="0" x2="1" y1="0" y2="0">
                {gradientStops.map(({ offset, opacity }) => (
                    <stop key={offset} offset={offset} stopColor="white" stopOpacity={opacity} />
                ))}
            </linearGradient>
            <pattern
                height="1"
                id={`${chartId}-loading-mask-pattern`}
                patternContentUnits="objectBoundingBox"
                patternTransform="rotate(25)"
                patternUnits="objectBoundingBox"
                width={patternWidth}
                x="0"
                y="0"
            >
                <motion.rect
                    animate={{ x: endX }}
                    fill={`url(#${chartId}-loading-mask-gradient)`}
                    height="1"
                    initial={{ x: startX }}
                    onUpdate={(latest) => {
                        const xValue = typeof latest.x === "number" ? latest.x : startX;
                        const lastX = lastXRef.current;

                        // Fire once per loop, when the shimmer fully exits the visible area
                        if (xValue >= 1 && lastX < 1) {
                            onShimmerExit();
                        }

                        lastXRef.current = xValue;
                    }}
                    transition={{
                        duration: LOADING_ANIMATION_DURATION / 1000,
                        ease: "linear",
                        repeat: Infinity,
                        repeatType: "loop",
                    }}
                    width="1"
                    y="0"
                />
            </pattern>
            <mask id={`${chartId}-loading-mask`} maskUnits="userSpaceOnUse">
                <rect fill={`url(#${chartId}-loading-mask-pattern)`} height="100%" width="100%" />
            </mask>
        </>
    );
};
