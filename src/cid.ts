/**
 * Content-addressing for AT Protocol repos — DAG-CBOR + CIDv1.
 *
 * AT Protocol repos are Merkle Search Trees whose nodes and signed
 * commits are serialised as **DAG-CBOR** and addressed by **CIDv1**
 * (`dag-cbor` codec `0x71`, `sha-256` multihash `0x12`, base32 multibase
 * `b…`). Every commit therefore has a *real content hash* — the commit
 * CID — and that is what this language uses as `currentRevision()`.
 *
 * This module implements the exact pieces of that stack that the language
 * needs, with NO external dependency (the executor runtime has no
 * `@atproto/*` / `@ipld/*` libraries, and the AD4M `hash()` host function
 * produces a *different* framing — CIDv0 base58 — so it cannot be used to
 * reproduce an ATProto commit CID). Everything here is pure and
 * deterministic, so it is exhaustively unit-testable against fixtures and
 * identical across runtimes.
 *
 * Implemented:
 *   - `sha256` — pure SHA-256 (FIPS 180-4) over bytes.
 *   - `encodeDagCbor` — deterministic DAG-CBOR encoding (definite lengths,
 *     canonical map-key ordering, integer/​string/​bytes/​array/​map/​bool/​null
 *     and CID tag-42 links) sufficient for MST nodes and commits.
 *   - `cidV1DagCbor` — CIDv1 (dag-cbor + sha-256) as a base32 `b…` string.
 *   - `cidForValue` — encode a value as DAG-CBOR then CID it (the CID of a
 *     record / node / commit).
 */

// ---------------------------------------------------------------------------
// Bytes / hex / base32 helpers
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Encode bytes as base32 lower (RFC 4648, no padding). */
export function base32Encode(bytes: Uint8Array): string {
    let bits = 0;
    let buffer = 0;
    let result = "";
    for (let i = 0; i < bytes.length; i++) {
        buffer = (buffer << 8) | bytes[i];
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            result += BASE32_ALPHABET[(buffer >> bits) & 0x1f];
        }
    }
    if (bits > 0) {
        result += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
    }
    return result;
}

/** Decode a base32 lower string (RFC 4648, no padding) to bytes. */
export function base32Decode(str: string): Uint8Array {
    const lower = str.toLowerCase().replace(/=+$/, "");
    let bits = 0;
    let buffer = 0;
    const out: number[] = [];
    for (let i = 0; i < lower.length; i++) {
        const idx = BASE32_ALPHABET.indexOf(lower[i]);
        if (idx < 0) throw new Error(`invalid base32 character: ${lower[i]}`);
        buffer = (buffer << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((buffer >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}

/** UTF-8 encode a string to bytes. */
export function utf8Encode(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4) — pure, dependency-free
// ---------------------------------------------------------------------------

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
    return (x >>> n) | (x << (32 - n));
}

/** Compute the SHA-256 digest (32 bytes) of the given bytes. */
export function sha256(data: Uint8Array): Uint8Array {
    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);

    // Pre-processing (padding)
    const bitLen = data.length * 8;
    const withOne = data.length + 1;
    const totalLen = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
    const msg = new Uint8Array(totalLen);
    msg.set(data);
    msg[data.length] = 0x80;
    // Append 64-bit big-endian length. Bit length fits comfortably in 53-bit
    // safe-integer range for any realistic input, so split hi/lo via math.
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    const dv = new DataView(msg.buffer);
    dv.setUint32(totalLen - 8, hi);
    dv.setUint32(totalLen - 4, lo);

    const w = new Uint32Array(64);
    for (let off = 0; off < totalLen; off += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = dv.getUint32(off + i * 4);
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = h[0], b = h[1], c = h[2], d = h[3];
        let e = h[4], f = h[5], g = h[6], hh = h[7];

        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e;
            e = (d + t1) >>> 0;
            d = c; c = b; b = a;
            a = (t1 + t2) >>> 0;
        }

        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
        h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0;
        h[7] = (h[7] + hh) >>> 0;
    }

    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
    return out;
}

// ---------------------------------------------------------------------------
// DAG-CBOR (deterministic subset) — RFC 8949 + DAG-CBOR restrictions
// ---------------------------------------------------------------------------

/**
 * A CID link inside a DAG-CBOR structure. In DAG-CBOR a CID is encoded as
 * tag 42 wrapping a byte string whose first byte is the multibase prefix
 * `0x00` (identity) followed by the binary CID.
 */
export class CidLink {
    constructor(public readonly cid: string) {}
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

/** Encode a CBOR major type + argument (definite length). */
function encodeHead(major: number, arg: number): Uint8Array {
    const mt = major << 5;
    if (arg < 24) {
        return new Uint8Array([mt | arg]);
    } else if (arg < 0x100) {
        return new Uint8Array([mt | 24, arg]);
    } else if (arg < 0x10000) {
        return new Uint8Array([mt | 25, (arg >> 8) & 0xff, arg & 0xff]);
    } else if (arg < 0x100000000) {
        return new Uint8Array([
            mt | 26,
            (arg >>> 24) & 0xff,
            (arg >>> 16) & 0xff,
            (arg >>> 8) & 0xff,
            arg & 0xff,
        ]);
    }
    // 64-bit argument (rare — large integers). Split hi/lo.
    const hi = Math.floor(arg / 0x100000000);
    const lo = arg >>> 0;
    return new Uint8Array([
        mt | 27,
        (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
        (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    ]);
}

/**
 * The binary form of a CIDv1 string (multibase-stripped), for embedding as
 * a DAG-CBOR tag-42 link. Only the base32 `b…` multibase is produced by
 * this module, so that is what we decode.
 */
function cidToBinary(cid: string): Uint8Array {
    if (cid[0] !== "b") {
        throw new Error(`unsupported CID multibase for DAG-CBOR link: ${cid}`);
    }
    return base32Decode(cid.slice(1));
}

/**
 * Deterministically DAG-CBOR-encode a JS value.
 *
 * Supported types: null, boolean, integer number, string, Uint8Array,
 * Array, plain object (map), and {@link CidLink}. Map keys are sorted by
 * the DAG-CBOR canonical rule (length-first, then bytewise on the UTF-8
 * key bytes). Floats are intentionally unsupported — ATProto records and
 * MST/commit structures are integer/string/bytes/link shaped.
 */
export function encodeDagCbor(value: unknown): Uint8Array {
    if (value === null || value === undefined) {
        return new Uint8Array([0xf6]); // null
    }
    if (typeof value === "boolean") {
        return new Uint8Array([value ? 0xf5 : 0xf4]);
    }
    if (typeof value === "number") {
        if (!Number.isInteger(value)) {
            throw new Error("DAG-CBOR: only integer numbers are supported");
        }
        if (value >= 0) {
            return encodeHead(0, value);
        }
        return encodeHead(1, -value - 1);
    }
    if (typeof value === "string") {
        const bytes = utf8Encode(value);
        return concatBytes([encodeHead(3, bytes.length), bytes]);
    }
    if (value instanceof Uint8Array) {
        return concatBytes([encodeHead(2, value.length), value]);
    }
    if (value instanceof CidLink) {
        const bin = cidToBinary(value.cid);
        // tag 42, then a byte string of 0x00 (multibase identity) + CID bytes
        const tag = encodeHead(6, 42);
        const inner = concatBytes([new Uint8Array([0x00]), bin]);
        const bstr = concatBytes([encodeHead(2, inner.length), inner]);
        return concatBytes([tag, bstr]);
    }
    if (Array.isArray(value)) {
        const chunks: Uint8Array[] = [encodeHead(4, value.length)];
        for (const item of value) chunks.push(encodeDagCbor(item));
        return concatBytes(chunks);
    }
    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        // Drop undefined-valued keys (they are "not present" in DAG-CBOR).
        const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
        keys.sort(canonicalKeyCompare);
        const chunks: Uint8Array[] = [encodeHead(5, keys.length)];
        for (const k of keys) {
            chunks.push(encodeDagCbor(k));
            chunks.push(encodeDagCbor(obj[k]));
        }
        return concatBytes(chunks);
    }
    throw new Error(`DAG-CBOR: unsupported value type: ${typeof value}`);
}

/** DAG-CBOR canonical map-key ordering: shorter key first, then bytewise. */
function canonicalKeyCompare(a: string, b: string): number {
    const ba = utf8Encode(a);
    const bb = utf8Encode(b);
    if (ba.length !== bb.length) return ba.length - bb.length;
    for (let i = 0; i < ba.length; i++) {
        if (ba[i] !== bb[i]) return ba[i] - bb[i];
    }
    return 0;
}

// ---------------------------------------------------------------------------
// CIDv1 (dag-cbor + sha-256), base32
// ---------------------------------------------------------------------------

/** dag-cbor multicodec code. */
export const CODEC_DAG_CBOR = 0x71;
/** sha2-256 multihash code. */
const MH_SHA2_256 = 0x12;

/**
 * Build a CIDv1 base32 string from an already-computed sha-256 digest and a
 * multicodec. Layout: `b` (base32 multibase) + base32( 0x01 | codec |
 * 0x12 | 0x20 | digest ).
 */
export function cidV1FromDigest(codec: number, digest: Uint8Array): string {
    if (digest.length !== 32) {
        throw new Error("cidV1FromDigest expects a 32-byte sha-256 digest");
    }
    const bytes = new Uint8Array(4 + 32);
    bytes[0] = 0x01;            // CID version 1
    bytes[1] = codec;          // content-type multicodec
    bytes[2] = MH_SHA2_256;    // multihash function
    bytes[3] = 0x20;           // multihash length (32)
    bytes.set(digest, 4);
    return "b" + base32Encode(bytes);
}

/** CIDv1 (dag-cbor) of already-encoded DAG-CBOR bytes. */
export function cidV1DagCbor(dagCborBytes: Uint8Array): string {
    return cidV1FromDigest(CODEC_DAG_CBOR, sha256(dagCborBytes));
}

/** Encode a value as DAG-CBOR and return its CIDv1 (dag-cbor) string. */
export function cidForValue(value: unknown): string {
    return cidV1DagCbor(encodeDagCbor(value));
}

/** True if a string is a CIDv1 base32 dag-cbor CID as produced here. */
export function isCommitCid(s: string): boolean {
    if (!s || s[0] !== "b") return false;
    try {
        const bytes = base32Decode(s.slice(1));
        return (
            bytes.length === 36 &&
            bytes[0] === 0x01 &&
            bytes[1] === CODEC_DAG_CBOR &&
            bytes[2] === MH_SHA2_256 &&
            bytes[3] === 0x20
        );
    } catch {
        return false;
    }
}
