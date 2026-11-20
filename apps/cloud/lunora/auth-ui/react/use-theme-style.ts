"use client";

import type { CSSProperties } from "react";

import { useAuthUI } from "./provider";

/**
 * The provider's resolved `theme` tokens as an inline style. `undefined` unless
 * the app configured `theme`, which keeps the rendered markup — and the app's
 * own design-token inheritance — untouched by default.
 *
 * Its own file rather than `primitives.tsx` so that module stays
 * components-only (React Fast Refresh bails on mixed component/non-component
 * exports).
 */
const useThemeStyle = (): CSSProperties | undefined => {
    const { themeVariables } = useAuthUI();

    return Object.keys(themeVariables).length === 0 ? undefined : themeVariables;
};

export { useThemeStyle };
