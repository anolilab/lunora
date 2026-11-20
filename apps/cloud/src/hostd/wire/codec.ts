/**
 * Encoding and decoding of hostd frames. Every frame is one JSON object in
 * UTF-8, within the frame cap.
 */
import { HOSTD_PROTOCOL_LIMITS } from "./constants";
import type { BoxMessage, CloudMessage, DecodeError, DecodeResult, HostdMessage } from "./types";
import { BOX_MESSAGE_READERS, CLOUD_MESSAGE_READERS, InvalidField, utf8ByteLength } from "./validate";

/** A frame as a WebSocket delivers it: text, or binary holding UTF-8 text. */
type HostdFrame = ArrayBuffer | ArrayBufferView | string;

type Reader<T> = (value: unknown, path: string) => T;

const reject = (code: DecodeError["code"], message: string, path?: string): { error: DecodeError; ok: false } => {
    return { error: path === undefined ? { code, message } : { code, message, path }, ok: false };
};

const tooLarge = (): { error: DecodeError; ok: false } => reject("FRAME_TOO_LARGE", `frame exceeds ${String(HOSTD_PROTOCOL_LIMITS.maxFrameBytes)} bytes`);

/** The frame's text, or why it has none. Checks the size before decoding anything. */
const frameText = (frame: HostdFrame): { error: DecodeError; ok: false } | { ok: true; text: string } => {
    if (typeof frame === "string") {
        // UTF-8 never takes fewer bytes than UTF-16 code units, so a long string
        // is rejected without encoding it.
        if (frame.length > HOSTD_PROTOCOL_LIMITS.maxFrameBytes || utf8ByteLength(frame) > HOSTD_PROTOCOL_LIMITS.maxFrameBytes) {
            return tooLarge();
        }

        return { ok: true, text: frame };
    }

    const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);

    if (bytes.byteLength > HOSTD_PROTOCOL_LIMITS.maxFrameBytes) {
        return tooLarge();
    }

    try {
        return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
        return reject("INVALID_JSON", "frame is not valid UTF-8");
    }
};

const decodeWith = <T>(frame: HostdFrame, readers: ReadonlyMap<string, Reader<T>>, direction: string): DecodeResult<T> => {
    const text = frameText(frame);

    if (!text.ok) {
        return text;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text.text);
    } catch {
        return reject("INVALID_JSON", "frame is not valid JSON");
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return reject("INVALID_MESSAGE", "frame must be a JSON object", "$");
    }

    const { type } = parsed as Record<string, unknown>;
    const reader = typeof type === "string" ? readers.get(type) : undefined;

    if (reader === undefined) {
        return reject("UNKNOWN_TYPE", `type must be one of the ${direction} types: ${[...readers.keys()].join(", ")}`, "$.type");
    }

    try {
        return { message: reader(parsed, "$"), ok: true };
    } catch (error: unknown) {
        if (error instanceof InvalidField) {
            return reject("INVALID_MESSAGE", error.message, error.path);
        }

        return reject("INVALID_MESSAGE", error instanceof Error ? error.message : String(error), "$");
    }
};

/**
 * Decode and validate one frame a box sent. Never throws: a frame that is too
 * large, not JSON, of an unknown type, or carrying an unknown, missing or
 * mistyped field comes back as `{ ok: false, error }`.
 */
const decodeBoxMessage = (frame: HostdFrame): DecodeResult<BoxMessage> => decodeWith(frame, BOX_MESSAGE_READERS, "box → cloud");

/**
 * Decode and validate one frame the control plane sent. Never throws; see
 * {@link decodeBoxMessage}.
 */
const decodeCloudMessage = (frame: HostdFrame): DecodeResult<CloudMessage> => decodeWith(frame, CLOUD_MESSAGE_READERS, "cloud → box");

/**
 * Read the protocol version a `hello` frame announces, without validating the
 * rest of it.
 *
 * The control plane calls this on a box's first frame, BEFORE
 * {@link decodeBoxMessage}: a box on a newer protocol may send a `hello` with
 * fields this build does not know, which the strict decoder would reject as
 * `INVALID_MESSAGE` instead of answering with the `PROTOCOL_UNSUPPORTED` error
 * the operator can act on. `hello.type` and `hello.protocol` are frozen across
 * every version for exactly this reason.
 * @returns the announced version, or `undefined` when the frame is not a `hello` carrying an integer `protocol` >= 1
 */
const peekProtocolVersion = (frame: HostdFrame): number | undefined => {
    const text = frameText(frame);

    if (!text.ok) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text.text);
    } catch {
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return undefined;
    }

    const { protocol, type } = parsed as Record<string, unknown>;

    return type === "hello" && typeof protocol === "number" && Number.isSafeInteger(protocol) && protocol >= 1 ? protocol : undefined;
};

/**
 * Validate a message and encode it as one text frame.
 *
 * The output holds only the message's known fields (an optional field set to
 * `undefined` is dropped), so whatever this returns, the peer's decoder accepts.
 * @throws {TypeError} when the message would not pass the peer's decoder.
 * @throws {RangeError} when the encoded frame exceeds the frame cap.
 */
const encodeMessage = (message: HostdMessage): string => {
    const { type } = message as { type: unknown };
    const reader: Reader<HostdMessage> | undefined = typeof type === "string" ? (BOX_MESSAGE_READERS.get(type) ?? CLOUD_MESSAGE_READERS.get(type)) : undefined;

    if (reader === undefined) {
        throw new TypeError(`unknown hostd message type: ${typeof type === "string" ? type : typeof type}`);
    }

    let validated: HostdMessage;

    try {
        validated = reader(message, "$");
    } catch (error: unknown) {
        if (error instanceof InvalidField) {
            throw new TypeError(error.message, { cause: error });
        }

        throw error;
    }

    const encoded = JSON.stringify(validated);

    if (utf8ByteLength(encoded) > HOSTD_PROTOCOL_LIMITS.maxFrameBytes) {
        throw new RangeError(`encoded ${validated.type} frame exceeds ${String(HOSTD_PROTOCOL_LIMITS.maxFrameBytes)} bytes`);
    }

    return encoded;
};

export type { HostdFrame };
export { decodeBoxMessage, decodeCloudMessage, encodeMessage, peekProtocolVersion };
