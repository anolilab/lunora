import type { ReactElement } from "react";
import { lazy, Suspense, useState } from "react";

import { useT } from "../i18n/i18n-context";
import type { ThemePreference } from "../lib/theme";
import { cn } from "../lib/utils";
import { useTheme } from "./theme-provider";

const MonitorIcon = (): ReactElement => (
    <svg
        aria-hidden="true"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
    >
        <rect height="14" rx="2" width="20" x="2" y="3" />
        <path d="M8 21h8M12 17v4" />
    </svg>
);

const SunIcon = (): ReactElement => (
    <svg
        aria-hidden="true"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
    >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
);

const MoonIcon = (): ReactElement => (
    <svg
        aria-hidden="true"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
    >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
);

// The animated indicator pulls in `motion` (~130 KiB), so it loads on demand
// instead of in the static first-load closure. A failed chunk fetch resolves to
// the plain box rather than throwing into the app-level boundary: the indicator
// only animates between segments, so losing it costs nothing else.
const StaticIndicator = ({ className }: { readonly className: string }): ReactElement => <span className={className} />;

const ThemeIndicator = lazy(() =>
    import("./theme-indicator").catch(() => {
        return { default: StaticIndicator };
    }),
);

const INDICATOR_CLASS = "absolute inset-0 rounded-md border border-muted-foreground/40 bg-background/40";

const OPTIONS: ReadonlyArray<{ readonly Icon: () => ReactElement; readonly value: ThemePreference }> = [
    { Icon: MonitorIcon, value: "system" },
    { Icon: SunIcon, value: "light" },
    { Icon: MoonIcon, value: "dark" },
];

/**
 * Segmented theme control (system · light · dark) for the studio top bar. Reads
 * the preference from {@link useTheme} (our dependency-free, scoped theme
 * provider) and slides an aurora-free hairline indicator under the active
 * segment via a shared-layout `motion` element.
 */
const ThemeToggle = (): ReactElement => {
    const { theme, setTheme } = useTheme();
    const t = useT();
    // The static box stands in until the pointer or keyboard reaches the control, so a page load does not fetch
    // the motion chunk, yet the indicator is already mounted on the old segment when the first change lands.
    const [isPrimed, setIsPrimed] = useState(false);
    const prime = (): void => {
        setIsPrimed(true);
    };

    const label: Record<ThemePreference, string> = {
        dark: t("Dark theme"),
        light: t("Light theme"),
        system: t("System theme"),
    };

    return (
        <div
            aria-label={t("Theme")}
            className="inline-flex items-center gap-0.5 overflow-hidden rounded-md border border-border bg-muted/60 p-0.5"
            data-testid="dash-app-theme"
            onFocus={prime}
            onPointerEnter={prime}
            role="radiogroup"
        >
            {OPTIONS.map(({ Icon, value }) => {
                const active = theme === value;

                return (
                    <button
                        aria-checked={active}
                        aria-label={label[value]}
                        className={cn(
                            "relative flex size-7 cursor-pointer items-center justify-center rounded-md outline-none transition-colors focus-visible:bg-accent",
                            active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                        )}
                        data-testid={`dash-app-theme-${value}`}
                        key={value}
                        onClick={() => {
                            prime();
                            setTheme(value);
                        }}
                        role="radio"
                        title={label[value]}
                        type="button"
                    >
                        {active &&
                            (isPrimed ? (
                                <Suspense fallback={<span className={INDICATOR_CLASS} />}>
                                    <ThemeIndicator className={INDICATOR_CLASS} />
                                </Suspense>
                            ) : (
                                <span className={INDICATOR_CLASS} />
                            ))}
                        <span className="relative">
                            <Icon />
                        </span>
                    </button>
                );
            })}
        </div>
    );
};
export default ThemeToggle;
