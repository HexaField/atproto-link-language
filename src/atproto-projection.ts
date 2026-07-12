/**
 * AT Protocol Channel-B adapter — the ATProto `NativeAdapter`.
 *
 * Maps the generic `Projection` produced by the SHACL transformer to/from a
 * real `app.bsky.feed.post` record that native Bluesky clients render. This is
 * the only ATProto-schema-aware half: the SHACL profile decides which graph
 * property fills the post's `text`; this adapter knows Bluesky's post shape.
 *
 * Crucially, `toNative` emits ONLY native post fields — no `ad4m` envelope, no
 * link hashes, no triple data smuggled into `text`. The DAG rides Channel A
 * (the MST commit-chain of `ad4m.link.triple`/`ad4m.link.tombstone` records,
 * see `mst.ts`/`store.ts`). This projection is derived and never read back to
 * rebuild the DAG; only genuinely native-authored posts (from a repo with no
 * AD4M identity mapping) are ingested through `fromNative` as new authoritative
 * links.
 */

import type { NativeAdapter, Projection } from "./projection/index.js";
import type { BskyPost } from "./types.js";
import { buildAtUri } from "./xrpc.js";

/** The native Bluesky post record type this adapter projects to/from. */
export const BSKY_POST_TYPE = "app.bsky.feed.post";

/**
 * A native `app.bsky.feed.post` together with the location it lives at.
 *
 * `toNative` produces the bare record (`value`); `fromNative` accepts the
 * located form the repo listing yields — the record `value` plus the AT-URI it
 * was found at (which carries both the author repo DID and the record key) so
 * an ingested post can be anchored on a stable base. The `authorDid` field is
 * an optional convenience for callers that already resolved the repo DID.
 */
export interface AtProtoPostRecord {
    /** The `app.bsky.feed.post` record value (native wire payload). */
    value: BskyPost;
    /** The AT-URI the record lives at: `at://<did>/app.bsky.feed.post/<rkey>`. */
    uri?: string;
    /** The repo DID that authored the post (== the AT-URI's authority). */
    authorDid?: string;
}

/**
 * Base URI derived from an AT-URI (or repo DID + rkey), for ingested native
 * posts. Mirrors the `at:<at-uri>` target convention the rest of the repo uses
 * for Bluesky-originated links (see `translate.blueskyPostToLink`).
 */
export function atprotoPostBase(uriOrDid: string, rkey?: string): string {
    // Full AT-URI form: `at://<did>/<collection>/<rkey>`.
    if (uriOrDid.startsWith("at://")) return `at:${uriOrDid}`;
    // Already an `at:`-prefixed reference — pass through.
    if (uriOrDid.startsWith("at:")) return uriOrDid;
    // A bare DID + rkey — build the canonical post AT-URI first.
    if (rkey) return `at:${buildAtUri(uriOrDid, BSKY_POST_TYPE, rkey)}`;
    // Nothing else to anchor on — return the raw value so nothing is lost.
    return `at:${uriOrDid}`;
}

/** Extract the repo DID (authority) from an AT-URI. */
function didFromAtUri(uri: string): string | undefined {
    const stripped = uri.replace(/^at:\/\//, "").replace(/^at:/, "");
    const slash = stripped.indexOf("/");
    const did = slash >= 0 ? stripped.slice(0, slash) : stripped;
    return did || undefined;
}

/**
 * Build the ATProto adapter. `nativeType` defaults to `app.bsky.feed.post`;
 * pass a different type only if a profile projects to a custom post-shaped
 * record type.
 */
export function makeAtProtoAdapter(
    nativeType: string = BSKY_POST_TYPE,
): NativeAdapter<AtProtoPostRecord> {
    return {
        toNative(projection: Projection): AtProtoPostRecord {
            const text = projection.fields.text;
            if (text === undefined) {
                throw new Error(
                    "ATProto projection requires a `text` field — the SHACL profile " +
                        'must annotate the content property with projection://field "text".',
                );
            }
            const value: BskyPost = {
                $type: nativeType as BskyPost["$type"],
                text: String(text),
                createdAt: projection.timestamp ?? new Date().toISOString(),
            };
            return { value };
        },

        fromNative(record: AtProtoPostRecord): Projection | null {
            const value = record?.value;
            if (!value || value.$type !== nativeType) return null;
            if (typeof value.text !== "string") return null;

            const uri = record.uri;
            // No AT-URI ⇒ no native id to anchor a base on.
            const base = uri ? atprotoPostBase(uri) : "";
            const author = record.authorDid ?? (uri ? didFromAtUri(uri) : undefined);

            return {
                nativeType,
                base,
                author,
                timestamp: typeof value.createdAt === "string" ? value.createdAt : undefined,
                fields: { text: value.text },
            };
        },
    };
}
