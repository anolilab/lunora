import { motion } from "motion/react";

import GitHubSvg from "@/assets/github.svg?url";
import SectionSeparator from "@/components/sections/section-separator";
import { BackgroundBeams } from "@/components/ui/background-beams";
import OssChip from "@/components/ui/svgs/oss-chips";

const GitHub = () => (
    <div className="relative bg-black">
        <SectionSeparator bgColor="bg-black" fillColor="fill-black" position="top" />
        <div className="relative z-10 mx-auto flex flex-col items-center justify-center overflow-hidden py-20 md:px-8">
            <div className="relative flex items-center justify-center">
                <motion.div
                    initial={{ opacity: 0 }}
                    transition={{ duration: 1, ease: "easeInOut" }}
                    viewport={{ amount: 0.5, once: true }}
                    whileInView={{ opacity: 1 }}
                >
                    <img alt="GitHub logo" className="w-[600px] dark:block" src={GitHubSvg} />
                    <div className="absolute top-[150px] left-[-50px] -z-50 lg:top-[400px] lg:left-[150px] lg:h-[400px] lg:w-[1000px]">
                        <OssChip className="flex" />
                    </div>
                </motion.div>
            </div>
        </div>
        <BackgroundBeams />
        <SectionSeparator bgColor="bg-black" fillColor="fill-black" position="bottom" />
    </div>
);

export default GitHub;
