import { describe, expect, it } from "vitest";

import type { GeoPoint, Infer } from "../src/index";
import { toJsonSchema, v, ValidationError } from "../src/index";

describe("v.geoPoint", () => {
    it("parses a valid lat/lng point", () => {
        expect.assertions(2);

        expect(v.geoPoint().parse({ lat: 40.758, lng: -73.9855 })).toStrictEqual({ lat: 40.758, lng: -73.9855 });
        // Extra keys are dropped; only lat/lng survive.
        expect(v.geoPoint().parse({ lat: 0, lng: 0, extra: "x" })).toStrictEqual({ lat: 0, lng: 0 });
    });

    it("carries the `geoPoint` kind for codegen introspection", () => {
        expect.assertions(1);

        expect(v.geoPoint().kind).toBe("geoPoint");
    });

    it("rejects a non-object value", () => {
        expect.assertions(2);

        expect(() => v.geoPoint().parse(null)).toThrow(ValidationError);
        expect(() => v.geoPoint().parse([40, -73])).toThrow(ValidationError);
    });

    it("rejects out-of-range latitude", () => {
        expect.assertions(2);

        expect(() => v.geoPoint().parse({ lat: 91, lng: 0 })).toThrow(/latitude/u);
        expect(() => v.geoPoint().parse({ lat: -90.1, lng: 0 })).toThrow(ValidationError);
    });

    it("rejects out-of-range longitude", () => {
        expect.assertions(2);

        expect(() => v.geoPoint().parse({ lat: 0, lng: 181 })).toThrow(/longitude/u);
        expect(() => v.geoPoint().parse({ lat: 0, lng: -180.5 })).toThrow(ValidationError);
    });

    it("rejects a non-numeric coordinate", () => {
        expect.assertions(2);

        expect(() => v.geoPoint().parse({ lat: "40", lng: 0 })).toThrow(ValidationError);
        expect(() => v.geoPoint().parse({ lat: 40, lng: Number.NaN })).toThrow(ValidationError);
    });

    it("infers `{ lat: number; lng: number }`", () => {
        expect.assertions(1);

        const point: Infer<ReturnType<typeof v.geoPoint>> = { lat: 1, lng: 2 };
        const typed: GeoPoint = point;

        expect(typed).toStrictEqual({ lat: 1, lng: 2 });
    });

    it("emits a JSON Schema object with bounded lat/lng", () => {
        expect.assertions(1);

        expect(toJsonSchema(v.geoPoint())).toStrictEqual({
            description: "geographic point (WGS84 decimal degrees)",
            properties: {
                lat: { maximum: 90, minimum: -90, type: "number" },
                lng: { maximum: 180, minimum: -180, type: "number" },
            },
            required: ["lat", "lng"],
            type: "object",
        });
    });
});
