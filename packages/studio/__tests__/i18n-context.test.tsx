import type { Messages } from "@lingui/core";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStudioI18n, DEFAULT_LOCALE, useT } from "../src/i18n-context";
import { StudioI18nProvider } from "../src/i18n-provider";

/** Renders one translated string so we can assert what `useT` resolves. */
const Probe = (): ReactElement => {
    const t = useT();

    return <span data-testid="probe">{t("Clear")}</span>;
};

describe("i18n-context", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    describe("createStudioI18n", () => {
        it("renders source strings verbatim for the empty English catalog", () => {
            expect.assertions(1);

            const i18n = createStudioI18n();

            expect(i18n._("Clear")).toBe("Clear");
        });

        it("interpolates uncompiled source strings", () => {
            expect.assertions(1);

            const i18n = createStudioI18n();

            expect(i18n._("{title} failed", { title: "Metrics" })).toBe("Metrics failed");
        });

        // Regression guard: `@lingui/core` only auto-installs its message compiler
        // when NODE_ENV !== "production". The studio ships as a library, so we
        // install the compiler explicitly — without it, a consumer's production build
        // would render `{title}` literally and `console.warn` on every `t(...)`.
        it("still interpolates (and stays quiet) when NODE_ENV is production", () => {
            expect.assertions(2);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            // stubEnv (auto-restored by unstubAllEnvs in afterEach) keeps the
            // NODE_ENV override leak-proof, even under future concurrent runs.
            vi.stubEnv("NODE_ENV", "production");

            const i18n = createStudioI18n();

            expect(i18n._("{title} failed", { title: "Metrics" })).toBe("Metrics failed");
            expect(warn).not.toHaveBeenCalled();
        });

        it("resolves a registered translation for the active locale", () => {
            expect.assertions(1);

            const catalogs: Record<string, Messages> = { de: { Clear: "Löschen" }, en: {} };
            const i18n = createStudioI18n("de", catalogs);

            expect(i18n._("Clear")).toBe("Löschen");
        });

        it("falls back to the default locale for an unknown code", () => {
            expect.assertions(1);

            const i18n = createStudioI18n("zz");

            expect(i18n.locale).toBe(DEFAULT_LOCALE);
        });
    });

    describe("useT", () => {
        it("renders source strings when used without a provider", () => {
            expect.assertions(1);

            render(<Probe />);

            expect(screen.getByTestId("probe").textContent).toBe("Clear");
        });

        it("uses the instance supplied by StudioI18nProvider", () => {
            expect.assertions(1);

            const i18n = createStudioI18n("de", { de: { Clear: "Löschen" }, en: {} });

            render(
                <StudioI18nProvider i18n={i18n}>
                    <Probe />
                </StudioI18nProvider>,
            );

            expect(screen.getByTestId("probe").textContent).toBe("Löschen");
        });
    });
});
