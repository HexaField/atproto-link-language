/**
 * Local type definitions mirroring the subset of @coasys/ad4m-ldk types
 * needed by the AT Protocol Link Language.
 *
 * Kept local so that pure modules can be imported and tested
 * without pulling in the ad4m:host runtime.
 */

export type DID = string;
export type Address = string;

export interface ExpressionProof {
    signature: string;
    key: string;
    valid?: boolean;
    invalid?: boolean;
}

export interface Expression<T = unknown> {
    author: DID;
    timestamp: string;
    data: T;
    proof: ExpressionProof;
}

export interface Link {
    source: string;
    target: string;
    predicate?: string;
}

export interface LinkExpression extends Expression<Link> {
    status?: string;
}

export interface PerspectiveDiff {
    additions: LinkExpression[];
    removals: LinkExpression[];
}

export interface Perspective {
    links: LinkExpression[];
}

// ---------------------------------------------------------------------------
// AT Protocol types
// ---------------------------------------------------------------------------

/** AT Proto strong reference (URI + CID) */
export interface StrongRef {
    uri: string;
    cid: string;
}

/** AT Proto ad4m.link.triple record */
export interface Ad4mLinkTriple {
    $type: "ad4m.link.triple";
    source: string;
    predicate: string;
    target: string;
    author: string;
    timestamp: string;
    proof?: {
        signature: string;
        key: string;
    };
}

/** AT Proto ad4m.link.tombstone record — a first-class removal */
export interface Ad4mLinkTombstone {
    $type: "ad4m.link.tombstone";
    /** Content hash of the removed link (the OR-Set element key). */
    linkHash: string;
    /** Echoed triple (informational). */
    source?: string;
    predicate?: string;
    target?: string;
    author: string;
    timestamp: string;
}

/** AT Proto ad4m.link.neighbourhood record */
export interface Ad4mLinkNeighbourhood {
    $type: "ad4m.link.neighbourhood";
    name: string;
    description: string;
    neighbourhoodUrl?: string;
    linkLanguageHash?: string;
    sdnaPatterns?: string[];
}

/** Bluesky feed post record */
export interface BskyPost {
    $type: "app.bsky.feed.post";
    text: string;
    createdAt: string;
    reply?: {
        root: StrongRef;
        parent: StrongRef;
    };
    facets?: BskyFacet[];
    embed?: BskyEmbed;
    langs?: string[];
}

/** Bluesky like record */
export interface BskyLike {
    $type: "app.bsky.feed.like";
    subject: StrongRef;
    createdAt: string;
}

/** Bluesky repost record */
export interface BskyRepost {
    $type: "app.bsky.feed.repost";
    subject: StrongRef;
    createdAt: string;
}

/** Bluesky follow record */
export interface BskyFollow {
    $type: "app.bsky.graph.follow";
    subject: string;
    createdAt: string;
}

/** Bluesky facet — byte-indexed rich text span */
export interface BskyFacet {
    index: {
        byteStart: number;
        byteEnd: number;
    };
    features: BskyFacetFeature[];
}

export type BskyFacetFeature =
    | { $type: "app.bsky.richtext.facet#mention"; did: string }
    | { $type: "app.bsky.richtext.facet#link"; uri: string }
    | { $type: "app.bsky.richtext.facet#tag"; tag: string };

export type BskyEmbed =
    | { $type: "app.bsky.embed.images"; images: BskyEmbedImage[] }
    | { $type: "app.bsky.embed.external"; external: BskyEmbedExternal }
    | { $type: "app.bsky.embed.record"; record: StrongRef }
    | { $type: "app.bsky.embed.recordWithMedia"; record: { record: StrongRef }; media: BskyEmbed };

export interface BskyEmbedImage {
    alt: string;
    image: { $type: "blob"; ref: { $link: string }; mimeType: string; size: number };
    aspectRatio?: { width: number; height: number };
}

export interface BskyEmbedExternal {
    uri: string;
    title: string;
    description: string;
    thumb?: { $type: "blob"; ref: { $link: string }; mimeType: string; size: number };
}

/** AT Proto write operation for applyWrites */
export type RepoWrite =
    | { $type: "com.atproto.repo.applyWrites#create"; collection: string; rkey: string; value: Record<string, unknown> }
    | { $type: "com.atproto.repo.applyWrites#update"; collection: string; rkey: string; value: Record<string, unknown> }
    | { $type: "com.atproto.repo.applyWrites#delete"; collection: string; rkey: string };

/** AT Proto session response */
export interface ATSession {
    accessJwt: string;
    refreshJwt: string;
    did: string;
    handle?: string;
}

/** AT Proto list records response */
export interface ListRecordsResponse {
    records: Array<{
        uri: string;
        cid: string;
        value: Record<string, unknown>;
    }>;
    cursor?: string;
}

/** AT Proto record (from listRecords or getRecord) */
export interface ATRecord {
    uri: string;
    cid: string;
    value: Record<string, unknown>;
}

/** TID — Timestamp-based Identifier (base32-sortable, 13 chars) */
export type TID = string;
