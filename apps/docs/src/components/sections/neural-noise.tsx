"use client";

import type { CSSProperties, ReactElement } from "react";
import { useEffect, useRef } from "react";

const DEFAULT_COLOR: readonly [number, number, number] = [0.57, 0.45, 0.91];

/**
 * A WebGL "neural noise" field — animated, pointer-reactive aurora ribbons.
 * Fills its positioned parent (not the viewport), tints to a brand colour,
 * cleans up its RAF loop + listeners on unmount, and renders a single static
 * frame under prefers-reduced-motion. Used as the hero backdrop. See DESIGN.md.
 */

interface NeuralNoiseProperties {
    className?: string;
    color?: readonly [number, number, number];
    opacity?: number;
    speed?: number;
    style?: CSSProperties;
}

const VERTEX_SHADER = `
    precision mediump float;
    varying vec2 vUv;
    attribute vec2 a_position;
    void main() {
        vUv = 0.5 * (a_position + 1.0);
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

const FRAGMENT_SHADER = `
    precision mediump float;
    varying vec2 vUv;
    uniform float u_time;
    uniform float u_ratio;
    uniform vec2 u_pointer_position;
    uniform vec3 u_color;
    uniform float u_speed;
    vec2 rotate(vec2 uv, float th) {
        return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
    }
    float neuro_shape(vec2 uv, float t, float p) {
        vec2 sine_acc = vec2(0.0);
        vec2 res = vec2(0.0);
        float scale = 8.0;
        for (int j = 0; j < 15; j++) {
            uv = rotate(uv, 1.0);
            sine_acc = rotate(sine_acc, 1.0);
            vec2 layer = uv * scale + float(j) + sine_acc - t;
            sine_acc += sin(layer) + 2.4 * p;
            res += (0.5 + 0.5 * cos(layer)) / scale;
            scale *= 1.2;
        }
        return res.x + res.y;
    }
    void main() {
        vec2 uv = 0.5 * vUv;
        uv.x *= u_ratio;
        vec2 pointer = vUv - u_pointer_position;
        pointer.x *= u_ratio;
        float p = clamp(length(pointer), 0.0, 1.0);
        p = 0.5 * pow(1.0 - p, 2.0);
        float t = u_speed * u_time;
        float noise = neuro_shape(uv, t, p);
        noise = 1.2 * pow(noise, 3.0);
        noise += pow(noise, 10.0);
        noise = max(0.0, noise - 0.5);
        noise *= (1.0 - length(vUv - 0.5));
        gl_FragColor = vec4(u_color * noise, noise);
    }
`;

const compileShader = (gl: WebGLRenderingContext, source: string, type: number): WebGLShader | null => {
    const shader = gl.createShader(type);

    if (!shader) {
        return null;
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);

        return null;
    }

    return shader;
};

const NeuralNoise = ({ className, color = DEFAULT_COLOR, opacity = 0.9, speed = 0.001, style }: NeuralNoiseProperties): ReactElement => {
    const canvasReference = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasReference.current;

        if (!canvas) {
            return undefined;
        }

        const gl = canvas.getContext("webgl") ?? (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);

        if (!gl) {
            return undefined;
        }

        const vertexShader = compileShader(gl, VERTEX_SHADER, gl.VERTEX_SHADER);
        const fragmentShader = compileShader(gl, FRAGMENT_SHADER, gl.FRAGMENT_SHADER);
        const program = gl.createProgram();

        if (!vertexShader || !fragmentShader) {
            return undefined;
        }

        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            return undefined;
        }

        gl.useProgram(program);

        const uniforms = {
            color: gl.getUniformLocation(program, "u_color"),
            pointer: gl.getUniformLocation(program, "u_pointer_position"),
            ratio: gl.getUniformLocation(program, "u_ratio"),
            speed: gl.getUniformLocation(program, "u_speed"),
            time: gl.getUniformLocation(program, "u_time"),
        };

        const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
        const buffer = gl.createBuffer();

        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

        const positionLocation = gl.getAttribLocation(program, "a_position");

        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        gl.uniform3f(uniforms.color, color[0], color[1], color[2]);
        gl.uniform1f(uniforms.speed, speed);

        const pointer = { tX: 0, tY: 0, x: 0, y: 0 };

        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio, 2);

            canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
            canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.uniform1f(uniforms.ratio, canvas.width / canvas.height);
        };

        const setPointer = (clientX: number, clientY: number) => {
            const rect = canvas.getBoundingClientRect();

            pointer.tX = clientX - rect.left;
            pointer.tY = clientY - rect.top;
        };

        const onPointerMove = (event: PointerEvent) => {
            setPointer(event.clientX, event.clientY);
        };
        const onTouchMove = (event: TouchEvent) => {
            const touch = event.targetTouches.item(0);

            if (touch) {
                setPointer(touch.clientX, touch.clientY);
            }
        };

        const draw = (time: number) => {
            pointer.x += (pointer.tX - pointer.x) * 0.2;
            pointer.y += (pointer.tY - pointer.y) * 0.2;
            gl.uniform1f(uniforms.time, time);
            gl.uniform2f(uniforms.pointer, pointer.x / Math.max(1, canvas.clientWidth), 1 - pointer.y / Math.max(1, canvas.clientHeight));
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        };

        resize();

        const resizeObserver = new ResizeObserver(resize);

        resizeObserver.observe(canvas);

        const prefersReduced = typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

        let raf = 0;

        if (prefersReduced) {
            draw(6000);
        } else {
            const loop = (time: number) => {
                draw(time);
                raf = globalThis.requestAnimationFrame(loop);
            };

            globalThis.addEventListener("pointermove", onPointerMove);
            globalThis.addEventListener("touchmove", onTouchMove, { passive: true });
            raf = globalThis.requestAnimationFrame(loop);
        }

        return () => {
            if (raf) {
                globalThis.cancelAnimationFrame(raf);
            }

            resizeObserver.disconnect();
            globalThis.removeEventListener("pointermove", onPointerMove);
            globalThis.removeEventListener("touchmove", onTouchMove);
            gl.deleteProgram(program);
            gl.deleteShader(vertexShader);
            gl.deleteShader(fragmentShader);
            gl.deleteBuffer(buffer);
        };
    }, [color, speed]);

    return <canvas aria-hidden="true" className={className} ref={canvasReference} style={{ opacity, ...style }} />;
};

export default NeuralNoise;
