/**
 * The jurisdiction presets the app runs under. The privacy config and the erasure
 * dispositions read the same list, so the retention rules are defined once.
 */
import type { PrivacyPreset } from "@lunora/privacy";
import { germany } from "@lunora/privacy/de";
import { eu } from "@lunora/privacy/eu";

export const presets: ReadonlyArray<PrivacyPreset> = [eu(), germany()];
