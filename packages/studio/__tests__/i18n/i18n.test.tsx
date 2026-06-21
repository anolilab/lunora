import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { createStudioI18n, DEFAULT_LOCALE, useT } from "../../src/i18n/i18n-context";
import { StudioI18nProvider } from "../../src/i18n/i18n-provider";

/** Exercises `useT` for both the source string and a named interpolation. */
const Probe = (): ReactElement => {
    const t = useT();

    return (
        <span data-testid="probe">
            {t("Data")} · {t("{title} failed", { title: t("Logs") })}
        </span>
    );
};

describe("studio i18n", () => {
    it("renders English source strings when no provider/translation is present", () => {
        expect.assertions(1);

        // No provider → the shared default instance backs the context.
        render(<Probe />);

        expect(screen.getByTestId("probe").textContent).toBe("Data · Logs failed");
    });

    it("interpolates named placeholders against uncompiled source ids", () => {
        expect.assertions(1);

        const i18n = createStudioI18n();

        expect(i18n._("{title} failed", { title: "Schema" })).toBe("Schema failed");
    });

    it("uses a loaded translation for the active locale", () => {
        expect.assertions(1);

        const i18n = createStudioI18n("de", { de: { Data: "Daten" }, en: {} });

        render(
            <StudioI18nProvider i18n={i18n}>
                <Probe />
            </StudioI18nProvider>,
        );

        expect(screen.getByTestId("probe").textContent).toContain("Daten");
    });

    it("falls back to the default locale for an unknown locale code", () => {
        expect.assertions(1);

        const i18n = createStudioI18n("zz");

        expect(i18n.locale).toBe(DEFAULT_LOCALE);
    });
});
