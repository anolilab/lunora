"use client";

import { LunoraError } from "@lunora/errors";
// react-doctor-disable-next-line react-doctor/use-lazy-motion -- `m` + LazyMotion needs a provider above every consumer; this package exports individual panels that hosts mount without the studio shell, so a missing provider would throw at runtime in someone else's app
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { createContext, use, useId, useState } from "react";
import { Bar as RechartsBar, BarChart as RechartsBarChart, Rectangle, ReferenceLine, XAxis as RechartsXAxis } from "recharts";

import type { ChartConfig } from "../ui/chart";
import { ChartContainer, getColorsCount } from "../ui/chart";
import type { TooltipRoundness, TooltipVariant } from "../ui/tooltip";
import { ChartTooltip, ChartTooltipContent } from "../ui/tooltip";

// Constants
const DEFAULT_BAR_RADIUS = 2;
const BAR_GROW_DURATION = 0.5; // per-bar grow-in length, in seconds
const BAR_STAGGER = 0.05; // delay between consecutive bars, in seconds
const REVEAL_EASE: [number, number, number, number] = [0, 0.7, 0.5, 1]; // grow-in easing

/**
 * Whether bars grow into view. Recharts' own bar animation is permanently
 * disabled — every bar instead grows from its bottom baseline, staggered
 * left to right.
 *
 * NOTE: the grow-in is a per-frame animation, so it is heavier than a static
 * chart. `"none"` opts out entirely; it is also what a device with the OS
 * "reduce motion" preference falls back to automatically.
 */
type BarAnimationType = "none" | "left-to-right";

// ─────────────────────────────────────────────────────────────────────────────
// Shared context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared state for every part of the chart. Lifted into <EvilBarChart /> so that
 * <Bar /> and friends can read it without prop drilling. Sub-components are
 * composed freely — the provider is the single source of truth.
 */
type BarChartContextValue = {
    animationType: BarAnimationType; // default grow-in order each <Bar /> inherits
    config: ChartConfig; // colors + labels for every series
    dataLength: number; // number of rows currently rendered
    introStartedAt: number; // timestamp the chart mounted — anchors the one-shot grow-in
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

type EvilBarChartProps<TData extends Record<string, unknown>> = {
    animationType?: BarAnimationType; // default grow-in order for every <Bar />
    barCategoryGap?: number; // gap between categories of bars
    children: ReactNode; // composed parts — <Bar />, <XAxis />, <Tooltip />
    className?: string; // extra classes for the chart container
    config: ChartConfig; // series colors + labels
    data: TData[]; // rows rendered by the chart
};

/**
 * Root of the composible bar chart. Owns the data and the shared context.
 * Everything visual — axes, tooltip, and the bars themselves — is composed as
 * children, so a consumer renders exactly the parts they need.
 */
export const EvilBarChart = <TData extends Record<string, unknown>>({
    config,
    data,
    children,
    className,
    animationType = "left-to-right",
    barCategoryGap,
}: EvilBarChartProps<TData>): React.ReactElement => {
    const chartId = useId().replaceAll(":", ""); // colon-free id keeps CSS/SVG selectors valid
    // Anchors the grow-in to a fixed moment so it plays exactly once — re-renders
    // and Recharts' bar remounts read elapsed time from here instead of replaying.
    // Lazy useState stamps the time once, on the initial render only.
    const [introStartedAt] = useState(() => Date.now());

    const contextValue = {
        animationType,
        config,
        dataLength: data.length,
        introStartedAt,
    };

    return (
        <BarChartContext value={contextValue}>
            <ChartContainer className={className} config={config}>
                <RechartsBarChart accessibilityLayer barCategoryGap={barCategoryGap} data={data} id={chartId} layout="horizontal">
                    <ReferenceLine stroke="var(--border)" />
                    {children}
                </RechartsBarChart>
            </ChartContainer>
        </BarChartContext>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Composible parts
// ─────────────────────────────────────────────────────────────────────────────

type BarProps = {
    dataKey: string; // series key — must exist on the data and config
};

/**
 * A single bar series. Each <Bar /> is fully self-contained: it generates its
 * own gradient definition under a unique id, so any number of bars can live in
 * one chart without style collisions.
 */
export const Bar = ({ dataKey }: BarProps): React.ReactElement | null => {
    const { animationType, config, dataLength, introStartedAt } = useBarChart();
    const id = useId().replaceAll(":", ""); // unique id scopes this bar's style defs
    // Devices set to "reduce motion" skip the grow-in animation entirely
    const shouldReduceMotion = useReducedMotion();

    // The grow-in is a per-frame animation — heavier than a static chart — so
    // `"none"` and the OS reduce-motion preference both opt out of it.
    const revealType: BarAnimationType = shouldReduceMotion ? "none" : animationType;

    const customBarProps = {
        dataKey,
        dataLength,
        id,
        introStartedAt,
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
                radius={DEFAULT_BAR_RADIUS}
                shape={(props: unknown) => <CustomBar {...(props as BarShapeProps)} {...customBarProps} animationType={revealType} />}
            />
            <defs>
                <ColorGradient config={config} dataKey={dataKey} id={id} />
            </defs>
        </>
    );
};

type XAxisProps = React.ComponentProps<typeof RechartsXAxis>;

/**
 * The category axis. Ships with the chart's flat default styling and forwards
 * every Recharts XAxis prop, so `dataKey`, `tickFormatter`, etc. are passed
 * straight through.
 */
export const XAxis = ({ tickLine = false, axisLine = false, tickMargin = 8, minTickGap = 8, ...props }: XAxisProps): React.ReactElement | null => (
    <RechartsXAxis axisLine={axisLine} minTickGap={minTickGap} tickLine={tickLine} tickMargin={tickMargin} type="category" {...props} />
);

type TooltipProps = {
    defaultIndex?: number; // data index shown by default with no hover
    roundness?: TooltipRoundness; // border-radius of the tooltip
    variant?: TooltipVariant; // visual style of the tooltip surface
};

/** The hover tooltip. */
export const Tooltip = ({ variant, roundness, defaultIndex }: TooltipProps): React.ReactElement | null => (
    <ChartTooltip content={<ChartTooltipContent roundness={roundness} variant={variant} />} cursor={false} defaultIndex={defaultIndex} />
);

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
    dataKey: string;
    dataLength?: number;
    id: string;
    introStartedAt?: number;
};

/**
 * Custom bar shape. Renders the visible bar painted by the owning <Bar />'s
 * color gradient, with an invisible full-height rectangle behind it to keep
 * the whole column hoverable.
 */
const CustomBar = (props: CustomBarProps): React.ReactElement => {
    const { x = 0, y = 0, width = 0, height = 0, id, dataKey, animationType = "none", introStartedAt = 0, dataLength = 0 } = props;

    const index = typeof props.index === "number" ? props.index : -1;
    const grow = getBarGrowAnimation(animationType, index, dataLength, introStartedAt);

    // The visible, painted bar
    const visibleBar = (
        <Rectangle fill={`url(#${id}-colors-${dataKey})`} height={Math.max(0, height - 3)} radius={DEFAULT_BAR_RADIUS} width={width} x={x} y={y} />
    );

    return (
        <g>
            {/* Full-height invisible rect keeps the whole column hoverable */}
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
 * Every bar grows from its bottom baseline (`scaleY`), staggered left to
 * right, so the chart fills in one bar at a time.
 *
 * The intro is anchored to `introStartedAt` (stamped once when the chart
 * mounts) rather than to component mount. Recharts remounts every bar whenever
 * the chart re-renders — e.g. on hover — so a mount-based animation would
 * replay endlessly. Reading elapsed time instead makes it a true one-shot: a
 * bar past its window renders static, and a bar caught mid-grow resumes from
 * the progress it should already be at.
 */
const getBarGrowAnimation = (animationType: BarAnimationType, index: number, dataLength: number, introStartedAt: number) => {
    if (animationType === "none" || index < 0 || dataLength <= 0) {
        return null;
    }

    const startMs = index * BAR_STAGGER * 1000;
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
        delay: Math.max(0, startMs - elapsed) / 1000,
        duration: (endMs - Math.max(elapsed, startMs)) / 1000,
        ease: REVEAL_EASE,
    };

    return { animate: { scaleY: 1 }, initial: { scaleY: from }, style: { originY: 1 }, transition };
};

// ─────────────────────────────────────────────────────────────────────────────
// Style definitions — one set per <Bar />, scoped to its unique id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vertical top-to-bottom color gradient for a series — the single paint every
 * bar fills from.
 */
const ColorGradient = ({ id, dataKey, config }: { config: ChartConfig; dataKey: string; id: string }): React.ReactElement => {
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
