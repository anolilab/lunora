import LunoraLogo from "@/assets/lunora_logo.svg?react";
import Section from "@/components/sections/section";
import SectionTitle from "@/components/sections/section-title";

const Colors = () => (
    <>
        <SectionTitle classes={{ root: "col-span-4" }} title="Brand Colors" />
        <div className="col-span-3 col-start-2 flex flex-row">
            <div className="w-full justify-start">
                <p className="pb-5 pl-12 font-mono uppercase">Primary</p>

                <div className="border-coal/10 flex flex-row border-y">
                    <div className="bg-coal text-ivory relative -m-[1px] mr-[2px] h-96 w-5/12">
                        <span className="absolute top-5 left-full w-full origin-top-left rotate-90 pt-5">Coal</span>
                        <span className="absolute bottom-20 left-0 origin-bottom-left rotate-90 pb-5">#121212</span>
                    </div>
                    <div className="bg-stone relative h-96 w-3/12">
                        <span className="absolute top-5 left-full w-full origin-top-left rotate-90 pt-5">Stone</span>
                        <span className="absolute bottom-20 left-0 origin-bottom-left rotate-90 pb-5">#E3E3E3</span>
                    </div>
                    <div className="bg-ivory relative h-96 w-4/12">
                        <span className="absolute top-5 left-full w-full origin-top-left rotate-90 pt-5">Ivory</span>
                        <span className="absolute bottom-20 left-0 origin-bottom-left rotate-90 pb-5">#F5F5F5</span>
                    </div>
                </div>
            </div>
            <div className="w-full justify-end">
                <p className="pb-5 pl-12 font-mono uppercase">Secondary</p>

                <div className="border-coal/10 flex flex-row border-y">
                    <div className="bg-crimson-energy relative h-96 grow">
                        <span className="absolute top-5 left-full w-full origin-top-left rotate-90 pt-5">Crimson Energy</span>
                        <span className="absolute bottom-20 left-0 origin-bottom-left rotate-90 pb-5">#E53935</span>
                    </div>
                    <div className="bg-royal-amethyst relative h-96 grow">
                        <span className="absolute top-5 left-full w-full origin-top-left rotate-90 pt-5">Royal Amethyst</span>
                        <span className="absolute bottom-20 left-0 origin-bottom-left rotate-90 pb-5">#8E44AD</span>
                    </div>
                    <div className="bg-sky-sapphire relative h-96 grow">
                        <span className="absolute top-5 left-full w-full origin-top-left rotate-90 pt-5">Sky Sapphire</span>
                        <span className="absolute bottom-20 left-0 origin-bottom-left rotate-90 pb-5">#0073E6</span>
                    </div>
                </div>
            </div>
        </div>
    </>
);

const Logo = () => (
    <>
        <SectionTitle classes={{ root: "col-span-4" }} title="Brand Logo" />
        <h3 className="col-span-1 col-start-2 text-center font-mono uppercase">Light Background</h3>
        <h3 className="col-span-1 col-start-4 text-center font-mono uppercase">Dark Background</h3>
        <div className="col-span-1 col-start-2 flex h-96 flex-col items-center justify-center gap-5 bg-white">
            <LunoraLogo className="text-coal h-48 w-48" />
        </div>
        <div className="col-span-1 col-start-4 flex h-96 flex-col items-center justify-center gap-5 bg-black">
            <LunoraLogo className="h-48 w-48 text-white" />
        </div>
    </>
);

const Typeface = () => (
    <>
        <SectionTitle classes={{ root: "col-span-4" }} title="Brand Typeface" />
        <h3 className="col-span-1 col-start-1 text-center font-mono uppercase">Geist Sans</h3>
        <div className="bg-ivory border-coal/10 col-span-3 border-y font-sans text-6xl">
            Aa Bb Cc Dd Ee Ff Gg
            <br />
            Hh Ii Jj Kk Ll Mm Nn Oo <br />
            Pp Qq Rr Ss Tt Uu Vv
            <br />
            Ww Xx Yy Zz
            <br />
            0123456789
        </div>
        <h3 className="col-span-1 col-start-1 text-center font-mono uppercase">Geist Mono</h3>
        <div className="bg-ivory border-coal/10 col-span-3 border-y font-mono text-6xl">
            Aa Bb Cc Dd Ee Ff Gg
            <br />
            Hh Ii Jj Kk Ll Mm Nn Oo <br />
            Pp Qq Rr Ss Tt Uu Vv
            <br />
            Ww Xx Yy Zz
            <br />
            0123456789
        </div>
    </>
);

const Brand = () => (
    <Section
        classes={{
            childrenWrapper: "gap-y-20",
        }}
    >
        <SectionTitle classes={{ root: "col-span-4" }} description="" title="Brand assets" />
        <SectionTitle
            classes={{ root: "col-span-2" }}
            description={
                <div className="flex flex-col gap-5">
                    <p>
                        The Lunora brand is a set of assets that represent the project. These assets include the logo, colors, and typography. The brand assets
                        are used to maintain a consistent look and feel across all Lunora products and marketing materials.
                    </p>
                    <p>Please don't edit, recolor, or wang-jangle the brand elements. There are plenty of variations to work with.</p>
                    <p>
                        Additionally, please do not use our brand names or logos for resale on clothing, stickers, or other merchandise without explicit written
                        consent.
                    </p>
                </div>
            }
            position="center"
            title="Brand Usage"
        />
        <Logo />
        <Typeface />
        <Colors />
    </Section>
);

export default Brand;
