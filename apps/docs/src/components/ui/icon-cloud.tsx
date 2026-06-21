"use client";

import { useEffect, useMemo, useState } from "react";
import type { ICloud, SimpleIcon } from "react-icon-cloud";
import { Cloud, fetchSimpleIcons, renderSimpleIcon } from "react-icon-cloud";

export const cloudProps: Omit<ICloud, "children"> = {
    containerProps: {
        style: {
            alignItems: "center",
            display: "flex",
            justifyContent: "center",
            paddingTop: 40,
            width: "100%",
        },
    },
    options: {
        activeCursor: "default",
        clickToFront: 500,
        depth: 1,
        imageScale: 2,
        initial: [0.1, -0.1],
        maxSpeed: 0.04,
        minSpeed: 0.02,
        outlineColour: "#0000",
        reverse: true,
        tooltip: "native",
        tooltipDelay: 0,
        wheelZoom: false,
    },
};

export const renderCustomIcon = (icon: SimpleIcon, theme: string) => {
    const bgHex = theme === "light" ? "#f3f2ef" : "#080510";
    const fallbackHex = theme === "light" ? "#6e6e73" : "#ffffff";
    const minContrastRatio = theme === "dark" ? 2 : 1.2;

    return renderSimpleIcon({
        aProps: {
            href: undefined,
            onClick: (e: any) => e.preventDefault(),
            rel: undefined,
            target: undefined,
        },
        bgHex,
        fallbackHex,
        icon,
        minContrastRatio,
        size: 42,
    });
};

export type DynamicCloudProps = {
    iconSlugs: string[];
    mode?: "light" | "dark";
};

type IconData = Awaited<ReturnType<typeof fetchSimpleIcons>>;

export const IconCloud = ({ iconSlugs, mode = "light" }: DynamicCloudProps) => {
    const [data, setData] = useState<IconData | null>(null);

    useEffect(() => {
        fetchSimpleIcons({ slugs: iconSlugs }).then(setData);
    }, [iconSlugs]);

    const renderedIcons = useMemo(() => {
        if (!data) {
            return null;
        }

        return Object.values(data.simpleIcons).map((icon) => renderCustomIcon(icon, mode));
    }, [data, mode]);

    return (
        // @ts-ignore
        <Cloud {...cloudProps}>
            <>{renderedIcons}</>
        </Cloud>
    );
};
