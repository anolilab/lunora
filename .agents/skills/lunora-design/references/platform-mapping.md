# Lunora Design System — Platform Mapping

> For web, **don't hand-copy these values** — import the canonical tokens:
> `@import "../../../marketing/design-tokens/tokens.css";` (after `@import "tailwindcss";`)
> or `import { aurora, neutrals } from "marketing/design-tokens/tokens"`. The
> snippet below is the shape of what that file provides.

## 1. HTML / CSS / WEB

Load Geist Sans + Geist Mono (already shipped via `unplugin-fonts` in docs and `@remotion/google-fonts` in the videos). Use CSS custom properties, `rem` for type, `px` for spacing/borders. Dark/light via `prefers-color-scheme` or a `.dark` / `.light` class.

```css
:root {
  /* Night & moonlight */
  --dark-coal: #0e0e11;            /* eclipse — page base */
  --coal: hsl(240 14% 6%);          /* midnight */
  --surface-raised: hsl(240 14% 9%);
  --stone: hsl(228 12% 86%);
  --ivory: hsl(228 32% 97%);
  --foreground: hsl(228 30% 96%);   /* moonlight */

  /* Aurora ramp (cyan → violet → rose); violet = primary glow */
  --sky-sapphire: hsl(186 84% 56%);   /* aurora cyan  — info/active/links */
  --royal-amethyst: hsl(256 72% 68%); /* aurora violet — primary */
  --crimson-energy: hsl(330 80% 64%); /* aurora rose  — emphasis */
  --aurora-ribbon: linear-gradient(to right, var(--sky-sapphire), var(--royal-amethyst), var(--crimson-energy));

  /* Data status (semantics, not decoration) */
  --success: hsl(160 60% 45%);
  --warning: hsl(38 92% 55%);        /* amber: data status ONLY, never decorative */
  --destructive: hsl(0 84% 60%);

  --radius: 0.5rem;                  /* small-radius steps for dense data only */
  --space-xs: 4px;  --space-sm: 8px;  --space-md: 16px; --space-lg: 24px;
  --space-xl: 32px; --space-2xl: 48px; --space-3xl: 64px; --space-4xl: 96px;
}
```

Structural chrome (nav, console, buttons, cards) is **sharp** (`border-radius: 0`); small radii only inside dense data. Depth = value step + one `border-white/10` hairline, not shadows.

---

## 2. SWIFTUI / iOS

Register fonts in Info.plist, bundle `.ttf` files. Use `@Environment(\.colorScheme)` for mode switching.

```swift
extension Color {
    static let lunDarkCoal = Color(hex: "0e0e11")          // eclipse
    static let lunCoal = Color(hue: 240/360, saturation: 0.14, brightness: 0.06) // midnight
    static let lunSurfaceRaised = Color(hue: 240/360, saturation: 0.14, brightness: 0.09)
    static let lunMoonlight = Color(hue: 228/360, saturation: 0.30, brightness: 0.96)
    static let lunStone = Color(hue: 228/360, saturation: 0.12, brightness: 0.86)
    static let lunIvory = Color(hue: 228/360, saturation: 0.32, brightness: 0.97)

    static let auroraCyan = Color(hue: 186/360, saturation: 0.84, brightness: 0.56)
    static let auroraViolet = Color(hue: 256/360, saturation: 0.72, brightness: 0.68) // primary
    static let auroraRose = Color(hue: 330/360, saturation: 0.80, brightness: 0.64)

    static let lunSuccess = Color(hue: 160/360, saturation: 0.60, brightness: 0.45)
    static let lunWarning = Color(hue: 38/360, saturation: 0.92, brightness: 0.55)
    static let lunDestructive = Color(hue: 0, saturation: 0.84, brightness: 0.60)
}
```

The aurora ribbon = a `LinearGradient([.auroraCyan, .auroraViolet, .auroraRose])` on the focal accent only. Fonts: `.custom("Geist-Light"/"Geist-Regular"/"GeistMono-Regular", size:)`.

---

## 3. PAPER (DESIGN TOOL)

Use `get_font_family_info` to verify Geist before writing styles. Direct hex/HSL values (no CSS variables). Dark (Night) as default canvas, light (Ivory) as a separate artboard.
