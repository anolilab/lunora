import { Mesh, Program, Renderer, Triangle } from "ogl";
import type { CSSProperties, FC } from "react";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Animated gradient backdrop: a full-bleed shader that splits a colour ramp
 * into vertical blinds and tracks a soft spotlight to the cursor.
 *
 * Colours accept CSS custom-property names as well as hex (`--site-accent`),
 * and are resolved against the live document at mount. That keeps the backdrop
 * on the theme layer: swapping `theme/tokens.css` restyles it with everything
 * else, where baked-in hex would be the one surface that ignored the swap.
 *
 * Renders nothing on the server — the canvas is created in an effect, so the
 * prerendered HTML carries an empty div and the field's own background shows
 * until the first frame.
 */

const MAX_COLORS = 8;

type RGB = [number, number, number];

const mixRGB = (from: RGB, to: RGB, amount: number): RGB => [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
];

const hexToRGB = (hex: string): [number, number, number] => {
    const c = hex.replace("#", "").padEnd(6, "0");

    return [Number.parseInt(c.slice(0, 2), 16) / 255, Number.parseInt(c.slice(2, 4), 16) / 255, Number.parseInt(c.slice(4, 6), 16) / 255];
};

const HEX = /^#[\da-f]{6}$/i;
const NUMBERS = /[\d.]+/g;

/**
 * Resolve the colour list to RGB triples, expanding it to the shader's fixed
 * slot count.
 *
 * Anything the browser can parse is fair game — `hsl()`, `oklch()`, a named
 * colour — because the throwaway probe element hands parsing back to the engine
 * rather than reimplementing colour spaces here. It lives for the length of
 * this call only, which is once per mount.
 */
const prepStops = (stops: string[]): { colors: [number, number, number][]; count: number } => {
    const probe = document.createElement("span");

    probe.style.cssText = "position:fixed;left:-9999px;width:0;height:0";
    document.body.append(probe);

    const resolve = (value: string): string => {
        const raw = value.startsWith("--") ? getComputedStyle(document.documentElement).getPropertyValue(value).trim() : value;

        if (HEX.test(raw)) {
            return raw;
        }

        probe.style.color = "";
        probe.style.color = raw;

        const parts = getComputedStyle(probe).color.match(NUMBERS);

        if (!parts) {
            return "#000000";
        }

        return `#${[0, 1, 2].map((index) => Math.round(Number(parts[index])).toString(16).padStart(2, "0")).join("")}`;
    };

    const base = (stops.length > 0 ? stops : ["#FF9FFC", "#5227FF"]).slice(0, MAX_COLORS).map((stop) => resolve(stop));

    probe.remove();

    if (base.length === 1) {
        base.push(base[0]);
    }

    while (base.length < MAX_COLORS) {
        base.push(base[base.length - 1]);
    }

    return { colors: base.map((color) => hexToRGB(color)), count: Math.max(2, Math.min(MAX_COLORS, stops.length || 2)) };
};

const VERTEX = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT = `
#ifdef GL_ES
precision mediump float;
#endif

uniform vec3  iResolution;
uniform vec2  iMouse;
uniform float iTime;

uniform float uAngle;
uniform float uNoise;
uniform float uBlindCount;
uniform float uSpotlightRadius;
uniform float uSpotlightSoftness;
uniform float uSpotlightOpacity;
uniform float uMirror;
uniform float uDistort;
uniform float uShineFlip;
uniform vec3  uColor0;
uniform vec3  uColor1;
uniform vec3  uColor2;
uniform vec3  uColor3;
uniform vec3  uColor4;
uniform vec3  uColor5;
uniform vec3  uColor6;
uniform vec3  uColor7;
uniform int   uColorCount;

varying vec2 vUv;

float rand(vec2 co){
  return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453);
}

vec2 rotate2D(vec2 p, float a){
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c) * p;
}

vec3 getGradientColor(float t){
  float tt = clamp(t, 0.0, 1.0);
  int count = uColorCount;
  if (count < 2) count = 2;
  float scaled = tt * float(count - 1);
  float seg = floor(scaled);
  float f = fract(scaled);

  if (seg < 1.0) return mix(uColor0, uColor1, f);
  if (seg < 2.0 && count > 2) return mix(uColor1, uColor2, f);
  if (seg < 3.0 && count > 3) return mix(uColor2, uColor3, f);
  if (seg < 4.0 && count > 4) return mix(uColor3, uColor4, f);
  if (seg < 5.0 && count > 5) return mix(uColor4, uColor5, f);
  if (seg < 6.0 && count > 6) return mix(uColor5, uColor6, f);
  if (seg < 7.0 && count > 7) return mix(uColor6, uColor7, f);
  if (count > 7) return uColor7;
  if (count > 6) return uColor6;
  if (count > 5) return uColor5;
  if (count > 4) return uColor4;
  if (count > 3) return uColor3;
  if (count > 2) return uColor2;
  return uColor1;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv0 = fragCoord.xy / iResolution.xy;

    float aspect = iResolution.x / iResolution.y;
    vec2 p = uv0 * 2.0 - 1.0;
    p.x *= aspect;
    vec2 pr = rotate2D(p, uAngle);
    pr.x /= aspect;
    vec2 uv = pr * 0.5 + 0.5;

    vec2 uvMod = uv;
    if (uDistort > 0.0) {
      float a = uvMod.y * 6.0;
      float b = uvMod.x * 6.0;
      float w = 0.01 * uDistort;
      uvMod.x += sin(a) * w;
      uvMod.y += cos(b) * w;
    }
    float t = uvMod.x;
    if (uMirror > 0.5) {
      t = 1.0 - abs(1.0 - 2.0 * fract(t));
    }
    vec3 base = getGradientColor(t);

    vec2 offset = vec2(iMouse.x/iResolution.x, iMouse.y/iResolution.y);
    float d = length(uv0 - offset);
    float r = max(uSpotlightRadius, 1e-4);
    float dn = d / r;
    float spot = (1.0 - 2.0 * pow(dn, uSpotlightSoftness)) * uSpotlightOpacity;
    vec3 cir = vec3(spot);
    float stripe = fract(uvMod.x * max(uBlindCount, 1.0));
    if (uShineFlip > 0.5) stripe = 1.0 - stripe;
    vec3 ran = vec3(stripe);

    vec3 col = cir + base - ran;
    col += (rand(gl_FragCoord.xy + iTime) - 0.5) * uNoise;

    fragColor = vec4(col, 1.0);
}

void main() {
    vec4 color;
    mainImage(color, vUv * iResolution.xy);
    gl_FragColor = color;
}
`;

/**
 * The reveal, as a keyframe animation rather than a transition.
 *
 * A transition only runs if the browser committed the starting value first, and
 * here it never reliably does: the canvas is created, set to `opacity: 0` and
 * revealed inside one task, so the two values coalesce and the field snaps in.
 * Deferring by a frame — or by two — papers over that on a fast machine and
 * loses the race on a slow one. An animation carries its own `from`, so it runs
 * whenever it is applied, however long the shader took to compile.
 *
 * `both` holds the end state after it finishes; the keyframes are in app.css.
 */
const REVEAL_ANIMATION = "field-in 1200ms cubic-bezier(0.16, 1, 0.3, 1) both";

const GradientBlinds: FC<{
    /** Gradient rotation in degrees; 0 is left→right. */
    angle?: number;
    /** Target number of vertical blinds — an upper bound once `blindMinWidth` applies. */
    blindCount?: number;
    /** Floor on each blind's pixel width, which lowers the effective count on narrow screens. */
    blindMinWidth?: number;
    className?: string;

    /**
     * Seconds for one full walk through `gradientColors`. 0 holds the first two
     * stops still. The field always shows two adjacent stops and slides the
     * window along, so the palette cycles without ever painting a rainbow.
     */
    cycleSeconds?: number;
    /** Sin/cos warp applied to the UVs. */
    distortAmount?: number;
    /** Hex colours or CSS custom-property names (`--site-accent`), up to 8. */
    gradientColors?: string[];
    mixBlendMode?: CSSProperties["mixBlendMode"];
    /** Seconds of easing on the spotlight's pursuit of the cursor; 0 snaps. */
    mouseDampening?: number;
    /** Per-pixel noise strength; 0 is clean. */
    noise?: number;
    shineDirection?: "left" | "right";
    spotlightOpacity?: number;
    spotlightRadius?: number;
    spotlightSoftness?: number;
}> = ({
    angle = 0,
    blindCount = 16,
    blindMinWidth = 60,
    className,
    cycleSeconds = 0,
    distortAmount = 0,
    gradientColors,
    mixBlendMode = "lighten",
    mouseDampening = 0.15,
    noise = 0.3,
    shineDirection = "left",
    spotlightOpacity = 1,
    spotlightRadius = 0.5,
    spotlightSoftness = 1,
}) => {
    const containerReference = useRef<HTMLDivElement>(null);

    // Keyed on the colour list's contents, not its identity: a caller writing
    // `gradientColors={["--site-accent"]}` inline hands us a new array every
    // render, and depending on the array itself would tear down and rebuild the
    // WebGL context each time.
    const colorKey = (gradientColors ?? []).join(",");

    useEffect(() => {
        const container = containerReference.current;

        if (!container) {
            return undefined;
        }

        const renderer = new Renderer({ alpha: true, antialias: true, dpr: globalThis.devicePixelRatio || 1 });
        const { gl } = renderer;
        const { canvas } = gl;

        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        // Hidden until `reveal()` has something to show. Compiling the program
        // and landing the first frame takes long enough to see, and an opaque
        // canvas spends that time as a black rectangle and then cuts to the field.
        canvas.style.opacity = "0";
        container.append(canvas);

        const { colors: colorArray, count: colorCount } = prepStops(colorKey ? colorKey.split(",") : []);

        const uniforms = {
            iMouse: { value: [0, 0] },
            iResolution: { value: [gl.drawingBufferWidth, gl.drawingBufferHeight, 1] },
            iTime: { value: 0 },
            uAngle: { value: (angle * Math.PI) / 180 },
            uBlindCount: { value: Math.max(1, blindCount) },
            uColor0: { value: colorArray[0] },
            uColor1: { value: colorArray[1] },
            uColor2: { value: colorArray[2] },
            uColor3: { value: colorArray[3] },
            uColor4: { value: colorArray[4] },
            uColor5: { value: colorArray[5] },
            uColor6: { value: colorArray[6] },
            uColor7: { value: colorArray[7] },
            uColorCount: { value: colorCount },
            uDistort: { value: distortAmount },
            uMirror: { value: 0 },
            uNoise: { value: noise },
            uShineFlip: { value: shineDirection === "right" ? 1 : 0 },
            uSpotlightOpacity: { value: spotlightOpacity },
            uSpotlightRadius: { value: spotlightRadius },
            uSpotlightSoftness: { value: spotlightSoftness },
        };

        // The distinct stops the caller gave us, before `prepStops` padded the
        // list out to the shader's fixed slot count with repeats.
        const palette = colorArray.slice(0, colorCount);
        const cycling = cycleSeconds > 0 && palette.length >= 2;

        // Only two slots are ever lit while cycling; the walk happens on the
        // CPU, one lerp per frame, rather than by handing the shader all eight
        // stops and letting it paint the whole palette at once.
        if (cycling) {
            uniforms.uColorCount.value = 2;
        }

        const applyCycle = (seconds: number) => {
            const phase = (seconds / cycleSeconds) * palette.length;
            const index = Math.floor(phase);
            const amount = phase - index;
            const at = (step: number) => palette[(index + step) % palette.length];

            uniforms.uColor0.value = mixRGB(at(0), at(1), amount);
            uniforms.uColor1.value = mixRGB(at(1), at(2), amount);
        };

        if (cycling) {
            applyCycle(0);
        }

        const program = new Program(gl, { fragment: FRAGMENT, uniforms, vertex: VERTEX });
        const geometry = new Triangle(gl);
        const mesh = new Mesh(gl, { geometry, program });

        // An object rather than a pair, so nothing here reads `target[0]`.
        const mouseTarget = { x: 0, y: 0 };
        let firstResize = true;

        const resize = () => {
            const rect = container.getBoundingClientRect();

            renderer.setSize(rect.width, rect.height);
            uniforms.iResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight, 1];

            const maxByMinWidth = blindMinWidth > 0 ? Math.max(1, Math.floor(rect.width / blindMinWidth)) : blindCount;

            uniforms.uBlindCount.value = Math.max(1, Math.min(blindCount, maxByMinWidth));

            if (firstResize) {
                firstResize = false;

                const centreX = gl.drawingBufferWidth / 2;
                const centreY = gl.drawingBufferHeight / 2;

                uniforms.iMouse.value = [centreX, centreY];
                mouseTarget.x = centreX;
                mouseTarget.y = centreY;
            }
        };

        resize();

        const observer = new ResizeObserver(resize);

        observer.observe(container);

        const onPointerMove = (event: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            const scale = renderer.dpr || 1;

            mouseTarget.x = (event.clientX - rect.left) * scale;
            mouseTarget.y = (rect.height - (event.clientY - rect.top)) * scale;

            if (mouseDampening <= 0) {
                uniforms.iMouse.value = [mouseTarget.x, mouseTarget.y];
            }
        };

        canvas.addEventListener("pointermove", onPointerMove);

        let frame = 0;
        let lastTime = 0;
        let visible = true;

        // Two reasons to stop drawing, both live: the reader asked for less
        // motion, or the hero has scrolled away. Neither tears the context
        // down — these are plain locals the loop reads rather than effect deps,
        // so toggling one costs nothing and the last frame stays on screen
        // instead of being blanked.
        const reduceMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
        const running = () => visible && !reduceMotion.matches;

        // Resuming after a pause: drop the stale timestamp so the spotlight
        // eases from where it is rather than teleporting by the whole gap.
        const onReduceChange = () => {
            lastTime = 0;
        };

        reduceMotion.addEventListener("change", onReduceChange);

        const inView = new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
        });

        inView.observe(container);

        const loop = (time: number) => {
            frame = requestAnimationFrame(loop);

            if (!running()) {
                lastTime = time;

                return;
            }

            uniforms.iTime.value = time * 0.001;

            // Runs off the clock, not off the cursor, so the field keeps moving
            // while the pointer is still.
            if (cycling) {
                applyCycle(time * 0.001);
            }

            if (mouseDampening > 0) {
                if (!lastTime) {
                    lastTime = time;
                }

                const delta = (time - lastTime) / 1000;

                lastTime = time;

                const factor = Math.min(1, 1 - Math.exp(-delta / Math.max(1e-4, mouseDampening)));
                const current = uniforms.iMouse.value;

                current[0] += (mouseTarget.x - current[0]) * factor;
                current[1] += (mouseTarget.y - current[1]) * factor;
            } else {
                lastTime = time;
            }

            renderer.render({ scene: mesh });
        };

        // Reveal on the frame *after* the first render, so the fade starts with
        // pixels already in the buffer rather than racing them.
        const reveal = () => {
            if (reduceMotion.matches) {
                // A reader who asked for less motion gets the backdrop, not a
                // fade — and not a blank rectangle either.
                canvas.style.opacity = "1";

                return;
            }

            // An animation on the element wins over its inline `opacity` for the
            // whole run, so the 0 above is the starting state, not a fight.
            canvas.style.animation = REVEAL_ANIMATION;
        };

        frame = requestAnimationFrame(loop);

        // One frame regardless, so a reduced-motion reader gets the backdrop as
        // a still image rather than an empty rectangle.
        renderer.render({ scene: mesh });
        reveal();

        return () => {
            cancelAnimationFrame(frame);
            canvas.removeEventListener("pointermove", onPointerMove);
            reduceMotion.removeEventListener("change", onReduceChange);
            observer.disconnect();
            inView.disconnect();
            canvas.remove();
            gl.getExtension("WEBGL_lose_context")?.loseContext();
        };
    }, [
        angle,
        blindCount,
        blindMinWidth,
        colorKey,
        cycleSeconds,
        distortAmount,
        mouseDampening,
        noise,
        shineDirection,
        spotlightOpacity,
        spotlightRadius,
        spotlightSoftness,
    ]);

    return <div aria-hidden="true" className={cn("relative h-full w-full overflow-hidden", className)} ref={containerReference} style={{ mixBlendMode }} />;
};

export { GradientBlinds };
