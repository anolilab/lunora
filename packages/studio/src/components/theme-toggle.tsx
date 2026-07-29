// react-doctor-disable-next-line react-doctor/use-lazy-motion -- `m` + LazyMotion needs a provider above every consumer; this package exports individual panels that hosts mount without the studio shell, so a missing provider would throw at runtime in someone else's app
import { motion } from "motion/react";
import type { ReactElement } from "react";

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
export const ThemeToggle = (): ReactElement => {
    const { theme, setTheme } = useTheme();
    const t = useT();

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
                            setTheme(value);
                        }}
                        role="radio"
                        title={label[value]}
                        type="button"
                    >
                        {active && (
                            <motion.span
                                className="absolute inset-0 rounded-md border border-muted-foreground/40 bg-background/40"
                                layoutId="studio-theme-active"
                                transition={{ bounce: 0.1, duration: 0.45, type: "spring" }}
                            />
                        )}
                        <span className="relative">
                            <Icon />
                        </span>
                    </button>
                );
            })}
        </div>
    );
};
