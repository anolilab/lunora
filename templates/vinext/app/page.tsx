"use client";

import { useEffect, useState } from "react";

import "./welcome.css";

type Theme = "dark" | "light";

/** Sun (Night active) / moon (Ivory active) glyph, swapped with the theme. */
function ThemeIcon({ theme }: { theme: Theme }) {
    if (theme === "light") {
        return (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
        );
    }

    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
        </svg>
    );
}

export default function Home() {
    // Default to "dark" for SSR (matches the static markup), then reconcile to the
    // user's OS preference on mount to avoid a hydration mismatch.
    const [theme, setTheme] = useState<Theme>("dark");

    useEffect(() => {
        if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) {
            setTheme("light");
        }
    }, []);

    return (
        <div className="lunora-welcome" data-theme={theme}>
            <div className="lw-bg">
                <div className="arc a1" />
                <div className="arc a2" />
                <div className="glow" />
            </div>

            <button
                className="lw-toggle"
                type="button"
                aria-label="Toggle color theme"
                onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
            >
                <ThemeIcon theme={theme} />
                <span>{theme === "light" ? "Ivory" : "Night"}</span>
            </button>

            <div className="lw-wrap">
                <div className="brand">
                    <svg viewBox="0 0 543 446" role="img" aria-label="Lunora">
                        <path
                            d="M 259.500 10.552 C 220.080 15.859, 182.424 32.566, 152.500 58.025 C 110.179 94.031, 85.380 137.183, 77.518 188.500 C 75.410 202.255, 74.569 225.677, 75.796 236.466 C 76.757 244.917, 76.683 245.692, 74.518 249.966 C 63.118 272.466, 53.141 303.876, 51.382 322.799 L 50.718 329.943 71.960 320.471 C 83.643 315.262, 93.326 311, 93.478 311 C 93.630 311, 96.547 316.063, 99.959 322.250 C 103.371 328.438, 107.249 334.850, 108.577 336.500 L 110.990 339.500 110.981 336 C 110.977 334.075, 111.499 324.991, 112.143 315.813 L 113.312 299.127 121.406 293.336 C 132.495 285.403, 149.593 271.554, 161 261.268 C 171.556 251.748, 189.116 235, 188.540 235 C 188.337 235, 183.069 238.648, 176.835 243.106 C 142.318 267.789, 68.537 314, 63.646 314 C 61.843 314, 72.791 281.179, 80.905 262.259 C 92.233 235.845, 107.473 212.389, 132.106 183.453 L 138.451 176 148.268 176 C 176.192 176, 197.512 187.154, 212.868 209.797 C 216.470 215.108, 217.035 216.595, 216.477 219.297 C 211.386 243.968, 202.359 274.496, 193.797 296 C 183.898 320.861, 167.147 352.101, 152.395 373.215 L 147.004 380.930 152.891 385.830 C 161.400 392.911, 165.563 396, 166.594 395.998 C 167.092 395.998, 168.772 391.641, 170.327 386.317 C 176.279 365.934, 188.422 338.749, 200.942 317.778 C 223.060 280.731, 256.432 244.369, 294.500 215.836 C 309.956 204.252, 313.937 201.603, 314.719 202.385 C 315.116 202.783, 315.449 213.096, 315.460 225.304 C 315.474 241.855, 315.021 250.405, 313.680 258.924 C 307.009 301.272, 291.175 336.677, 263.112 372 C 255.259 381.883, 227.182 410.673, 218.516 417.727 L 213.532 421.783 223.439 424.880 C 281.705 443.093, 349.165 436.018, 398.616 406.508 C 446.728 377.797, 483.322 331.466, 497.366 281.481 C 503.381 260.075, 504.480 250.741, 504.491 221 C 504.501 191.997, 503.598 184.047, 497.987 163.732 C 484.768 115.871, 452.505 72.708, 407.718 42.964 C 381.051 25.254, 352.818 14.828, 319.695 10.460 C 305.932 8.645, 273.298 8.695, 259.500 10.552"
                            fill="currentColor"
                            fillRule="evenodd"
                        />
                    </svg>
                    <span className="word">Lunora</span>
                </div>

                <div className="grid">
                    <a className="card feature" href="https://lunora.sh/docs">
                        <div className="shot" aria-hidden="true">
                            <div className="top">
                                <span className="wm">
                                    <i /> Lunora
                                </span>
                                <span className="search" />
                                <span className="ver">v0.1</span>
                            </div>
                            <div className="body">
                                <div className="nav">
                                    <i style={{ width: "80%" }} />
                                    <i style={{ width: "60%" }} />
                                    <i style={{ width: "72%" }} />
                                    <i style={{ width: "50%" }} />
                                    <i style={{ width: "66%" }} />
                                    <i style={{ width: "44%" }} />
                                    <i style={{ width: "58%" }} />
                                </div>
                                <div className="doc">
                                    <span className="h" />
                                    <i style={{ width: "92%" }} />
                                    <i style={{ width: "88%" }} />
                                    <span className="accent" />
                                    <i style={{ width: "80%" }} />
                                    <i style={{ width: "90%" }} />
                                    <i style={{ width: "72%" }} />
                                    <i style={{ width: "84%" }} />
                                    <i style={{ width: "78%" }} />
                                </div>
                            </div>
                        </div>
                        <div className="info">
                            <span className="ic">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                                    <path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
                                    <path d="M14 3v5h5" />
                                </svg>
                            </span>
                            <h2>Documentation</h2>
                            <div className="row">
                                <p>
                                    Schemas, queries, live subscriptions, sharding, and edge deploy — start to finish. New here or coming from Convex or tRPC,
                                    you'll have a live app fast.
                                </p>
                                <span className="arrow">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                        <path d="M5 12h14M13 6l6 6-6 6" />
                                    </svg>
                                </span>
                            </div>
                        </div>
                    </a>

                    <div className="stack">
                        <a className="card mini" href="https://lunora.sh/blog">
                            <div className="mc">
                                <span className="ic">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                                        <path d="M5 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zM8 8h7M8 12h7M8 16h4" />
                                    </svg>
                                </span>
                                <h3>Blog</h3>
                                <p>Product updates, deep dives, and what's new in Lunora.</p>
                            </div>
                            <span className="arrow">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                    <path d="M5 12h14M13 6l6 6-6 6" />
                                </svg>
                            </span>
                        </a>
                        <a className="card mini" href="/__lunora">
                            <div className="mc">
                                <span className="ic">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                                        <rect x="3" y="3" width="18" height="18" rx="1" />
                                        <path d="M3 9h18M9 21V9" />
                                    </svg>
                                </span>
                                <h3>Lunora Studio</h3>
                                <p>Local admin for schema, data, logs, and advisors.</p>
                            </div>
                            <span className="arrow">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                    <path d="M5 12h14M13 6l6 6-6 6" />
                                </svg>
                            </span>
                        </a>
                        <a className="card mini" href="https://lunora.sh/packages">
                            <div className="mc">
                                <span className="ic">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                                        <path d="M12 2 3 7v10l9 5 9-5V7z" />
                                        <path d="M3 7l9 5 9-5M12 12v10" />
                                    </svg>
                                </span>
                                <h3>Cloudflare ecosystem</h3>
                                <p>Auth, mail, storage, AI, payments — one deploy.</p>
                            </div>
                            <span className="arrow">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                    <path d="M5 12h14M13 6l6 6-6 6" />
                                </svg>
                            </span>
                        </a>
                    </div>
                </div>

                <div className="lw-foot">Running on Lunora · Next.js App Router (vinext)</div>
            </div>
        </div>
    );
}
