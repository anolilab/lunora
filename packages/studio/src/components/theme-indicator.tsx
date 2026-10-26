// react-doctor-disable-next-line react-doctor/use-lazy-motion -- `m` + LazyMotion does not shrink the first load here: esbuild splits per file, so the static `LazyMotion` import drags the motion files `domMax` shares into the entry chunk (~123 KiB). Loading this whole component lazily keeps motion off the static closure entirely.
import { motion } from "motion/react";
import type { ReactElement } from "react";

const TRANSITION = { bounce: 0.1, duration: 0.45, type: "spring" } as const;

/**
 * The theme toggle's sliding "active" hairline: a shared-layout `motion` element
 * that springs between segments as the preference changes. Its own module so
 * `theme-toggle` can load it with `React.lazy` — `motion` is ~130 KiB, and the
 * toggle sits in the header of every page.
 */
const ThemeIndicator = ({ className }: { readonly className: string }): ReactElement => (
    <motion.span className={className} layoutId="studio-theme-active" transition={TRANSITION} />
);

export default ThemeIndicator;
