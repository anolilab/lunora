import type { FC } from "react";

import GitHub from "@/pages/home/components/github";
import Downloads from "@/pages/home/sections/downloads";
import FAQ from "@/pages/home/sections/faq";
import MainHero from "@/pages/home/sections/hero";
import OpenSource from "@/pages/home/sections/open-source";
import Packages from "@/pages/home/sections/packages";
import Support from "@/pages/home/sections/support";
import WhyLunora from "@/pages/home/sections/why-lunora";
import WorksWhereYouWork from "@/pages/home/sections/works-where-you-work";

const Home: FC = () => (
    <>
        <MainHero />
        <WhyLunora />
        <Downloads />
        <div className="content-auto">
            <WorksWhereYouWork />
        </div>
        <div className="content-auto">
            <Packages />
        </div>
        <div className="content-auto">
            <OpenSource />
        </div>
        <GitHub />
        <div className="content-auto">
            <FAQ />
        </div>
        <div className="content-auto">
            <Support />
        </div>
    </>
);

export default Home;
