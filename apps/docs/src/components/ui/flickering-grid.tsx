"use client";

import type { FC } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface FlickeringGridProperties {
    className?: string;
    color?: string;
    flickerChance?: number;
    gridGap?: number;
    height?: number;
    maxOpacity?: number;
    squareSize?: number;
    width?: number;
}

const FlickeringGrid: FC<FlickeringGridProperties> = ({
    className,
    color = "rgb(0, 0, 0)",
    flickerChance = 0.3,
    gridGap = 6,
    height,
    maxOpacity = 0.3,
    squareSize = 4,
    width,
}) => {
    const canvasReference = useRef<HTMLCanvasElement>(null);
    const [isInView, setIsInView] = useState(false);

    const memoizedColor = useMemo(() => {
        const toRGBA = (color: string) => {
            if (globalThis.window === undefined) {
                return `rgba(0, 0, 0,`;
            }

            const canvas = document.createElement("canvas");

            canvas.width = canvas.height = 1;

            const context = canvas.getContext("2d");

            if (!context) {
                return "rgba(255, 0, 0,";
            }

            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);

            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;

            return `rgba(${r}, ${g}, ${b},`;
        };

        return toRGBA(color);
    }, [color]);

    const setupCanvas = useCallback(
        (canvas: HTMLCanvasElement) => {
            const canvasWidth = width || canvas.clientWidth;
            const canvasHeight = height || canvas.clientHeight;
            const dpr = window.devicePixelRatio || 1;

            canvas.width = canvasWidth * dpr;
            canvas.height = canvasHeight * dpr;
            canvas.style.width = `${canvasWidth}px`;
            canvas.style.height = `${canvasHeight}px`;

            const cols = Math.floor(canvasWidth / (squareSize + gridGap));
            const rows = Math.floor(canvasHeight / (squareSize + gridGap));

            const squares = new Float32Array(cols * rows);

            for (let index = 0; index < squares.length; index++) {
                squares[index] = Math.random() * maxOpacity;
            }

            return {
                cols,
                dpr,
                height: canvasHeight,
                rows,
                squares,
                width: canvasWidth,
            };
        },
        [squareSize, gridGap, width, height, maxOpacity],
    );

    const updateSquares = useCallback(
        (squares: Float32Array, deltaTime: number) => {
            for (let index = 0; index < squares.length; index++) {
                if (Math.random() < flickerChance * deltaTime) {
                    squares[index] = Math.random() * maxOpacity;
                }
            }
        },
        [flickerChance, maxOpacity],
    );

    const drawGrid = useCallback(
        (context: CanvasRenderingContext2D, width: number, height: number, cols: number, rows: number, squares: Float32Array, dpr: number) => {
            context.clearRect(0, 0, width, height);
            context.fillStyle = "transparent";
            context.fillRect(0, 0, width, height);

            for (let index = 0; index < cols; index++) {
                for (let index_ = 0; index_ < rows; index_++) {
                    const opacity = squares[index * rows + index_];

                    context.fillStyle = `${memoizedColor}${opacity})`;
                    context.fillRect(index * (squareSize + gridGap) * dpr, index_ * (squareSize + gridGap) * dpr, squareSize * dpr, squareSize * dpr);
                }
            }
        },
        [memoizedColor, squareSize, gridGap],
    );

    useEffect(() => {
        const canvas = canvasReference.current;

        if (!canvas) {
            return;
        }

        const context = canvas.getContext("2d");

        if (!context) {
            return;
        }

        let animationFrameId: number;
        let { cols, dpr, height, rows, squares, width } = setupCanvas(canvas);

        let lastTime = 0;

        const animate = (time: number) => {
            if (!isInView) {
                return;
            }

            const deltaTime = (time - lastTime) / 1000;

            lastTime = time;

            updateSquares(squares, deltaTime);
            drawGrid(context, width * dpr, height * dpr, cols, rows, squares, dpr);
            animationFrameId = requestAnimationFrame(animate);
        };

        const handleResize = () => {
            ({ cols, dpr, height, rows, squares, width } = setupCanvas(canvas));
        };

        const observer = new IntersectionObserver(
            ([entry]) => {
                setIsInView(entry.isIntersecting);
            },
            { threshold: 0 },
        );

        observer.observe(canvas);

        window.addEventListener("resize", handleResize);

        if (isInView) {
            animationFrameId = requestAnimationFrame(animate);
        }

        return () => {
            window.removeEventListener("resize", handleResize);
            cancelAnimationFrame(animationFrameId);
            observer.disconnect();
        };
    }, [setupCanvas, updateSquares, drawGrid, width, height, isInView]);

    return (
        <canvas
            className={`pointer-events-none size-full ${className}`}
            height={height}
            ref={canvasReference}
            style={{
                height: height || "100%",
                width: width || "100%",
            }}
            width={width}
        />
    );
};

export default FlickeringGrid;
