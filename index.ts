/**
 * # AT Protocol Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via Bluesky's AT Protocol.
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Publishes links as AT Proto records (both native ad4m.link.triple
 * and Bluesky-compatible app.bsky.* records), syncs inbound records
 * via polling, and handles authentication.
 *
 * Spec: atproto-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { ATProtoSettings } from "./src/settings.js";
import { translateDiffToWrites, shouldFederate, linkOriginKey } from "./src/translate.js";
import * as store from "./src/store.js";
import * as xrpc from "./src/xrpc.js";
import { authenticate, getAccessToken } from "./src/auth.js";
import { syncAll } from "./src/sync.js";
import { TRIPLE_COLLECTION } from "./src/lexicon.js";

// Adapter imports
import { initTransport, initStorage, getStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §9)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const AT_PDS_URL = "<to-be-filled>";

//!@ad4m-template-variable
const AT_RELAY_URL = "<to-be-filled>";

//!@ad4m-template-variable
const AT_DID = "<to-be-filled>";

//!@ad4m-template-variable
const AT_HANDLE = "<to-be-filled>";

//!@ad4m-template-variable
const AT_COLLECTION_NSID = "<to-be-filled>";

//!@ad4m-template-variable
const AT_APP_PASSWORD = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: ATProtoSettings;

/**
 * Get the neighbourhood URL from the language address.
 */
function neighbourhoodUrl(): string {
    return `neighbourhood://${AT_DID}`;
}

/**
 * Get the collection NSID, defaulting to ad4m.link.triple.
 */
function collectionNsid(): string {
    return AT_COLLECTION_NSID !== "<to-be-filled>" ? AT_COLLECTION_NSID : TRIPLE_COLLECTION;
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/atproto-link-language",
    version: "0.1.0",

    isPublic: true,

    async init() {
        // Initialize adapters before anything else
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());

        // Bind the local repo (and thus its commit CID) to this agent's DID.
        const localRepoDid = AT_DID !== "<to-be-filled>" ? AT_DID : myDid;
        store.setLocalDid(localRepoDid);

        console.log(`[atproto-link-language] init: did=${myDid}, pds=${AT_PDS_URL}`);
        console.log(`[atproto-link-language] AT DID: ${AT_DID}`);
        console.log(`[atproto-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[atproto-link-language] rendering: ${settings.rendering.strategy}`);

        // Authenticate to PDS if we have credentials
        const appPassword = AT_APP_PASSWORD !== "<to-be-filled>" ? AT_APP_PASSWORD : settings.auth.appPassword;
        if (appPassword && AT_PDS_URL !== "<to-be-filled>") {
            const handle = AT_HANDLE !== "<to-be-filled>" ? AT_HANDLE : AT_DID;
            console.log(`[atproto-link-language] attempting auth: handle=${handle}, pds=${AT_PDS_URL}`);
            try {
                const auth = await authenticate(AT_PDS_URL, handle, appPassword);
                if (auth) {
                    console.log(`[atproto-link-language] authenticated as ${auth.did}`);
                    store.setLocalDid(auth.did);
                    // Initial convergence: ride each repo's commit head via MST diff.
                    if (settings.syncMode !== "publish-only") {
                        const diff = await syncAll({
                            pdsUrl: AT_PDS_URL,
                            accessJwt: auth.accessJwt,
                            repo: auth.did,
                        });
                        if (diff.additions.length > 0 || diff.removals.length > 0) {
                            emitPerspectiveDiff(diff);
                        }
                    }
                } else {
                    console.error("[atproto-link-language] authentication failed — no session returned");
                }
            } catch (authErr: unknown) {
                console.error(`[atproto-link-language] auth error: ${authErr instanceof Error ? authErr.message : String(authErr)}`);
            }
        }
    },

    async teardown() {
        myDid = "";
        console.log("[atproto-link-language] teardown");
    },

    // -----------------------------------------------------------------------
    // perspective-commit
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // 1. Apply to the local MST commit chain: additions become
            //    ad4m.link.triple records, removals become ad4m.link.tombstone
            //    records carrying the original link hash. This advances the
            //    local commit CID — the head we return as the new revision.
            const newHead = store.applyLocalDiff(diff);

            // 2. Skip outbound in subscribe-only mode
            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return newHead;
            }

            // 3. Build federation filter
            const federationFilter = (linkHash: string): boolean => {
                return shouldFederate(linkHash, (key) => getStorage().get(key));
            };

            // 4. Track origins for new commits
            for (const link of diff.additions) {
                const h = store.hashLink(link);
                const originKey = linkOriginKey(h);
                const storage = getStorage();
                const existing = storage.get(originKey);
                if (existing === "atproto") {
                    storage.put(originKey, "dual");
                } else if (!existing) {
                    storage.put(originKey, "native");
                }
            }

            // 5. Translate to AT Proto write operations
            const writes = translateDiffToWrites(diff, {
                did: AT_DID,
                collection: collectionNsid(),
                settings,
                neighbourhoodUrl: neighbourhoodUrl(),
                hashFn: hash,
                shouldFederate: federationFilter,
            });

            // 6. Submit to PDS
            if (writes.length > 0) {
                const auth = await getAccessToken();
                if (auth) {
                    const result = await xrpc.applyWrites(
                        AT_PDS_URL,
                        auth.accessJwt,
                        auth.did,
                        writes,
                    );
                    if (!result.success) {
                        console.error("[atproto-link-language] commit failed: applyWrites error");
                    }
                } else {
                    console.error("[atproto-link-language] commit failed: no auth token");
                }
            }

            // 7. Emit perspective diff for local subscribers
            emitPerspectiveDiff(diff);

            // The new revision is the local repo's advanced commit CID.
            return newHead;
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            // Skip sync in publish-only mode
            if (settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }

            const auth = await getAccessToken();
            if (!auth) {
                return { additions: [], removals: [] };
            }

            // Ride each participating repo's commit head (self + peers) via MST
            // diff, converge via the cross-repo OR-Set, and return the delta.
            return await syncAll({
                pdsUrl: AT_PDS_URL,
                accessJwt: auth.accessJwt,
                repo: auth.did,
            });
        },

        async render() {
            // Role B projection: derived from the substrate fold, never read
            // back from a materialised store.
            return store.allLinks();
        },

        async currentRevision() {
            // The version-vector digest of every participating repo's commit
            // CID head (or the single commit CID when solo) — a real content
            // hash, deterministic and stable across restarts for the same state.
            return store.getRevision();
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal handler
// ---------------------------------------------------------------------------

/**
 * Handle signals emitted by the executor.
 *
 * The executor may forward an inbound record from a peer repo (triple add or
 * tombstone removal) as a signal. We ingest it into that peer's repo state
 * (the cross-repo OR-Set substrate), then emit the resulting fold delta — the
 * links that entered or left the materialised set. Convergence is the OR-Set
 * union, not a direct apply of the inbound link.
 */
export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return; // Not JSON — not our signal
    }

    if (typeof signal !== "object" || signal === null) return;
    const s = signal as Record<string, unknown>;
    if (s.type !== "atproto:record") return;

    const record = s.record as { uri: string; cid: string; value: Record<string, unknown> } | undefined;
    if (!record) return;

    const { splitPath } = await import("./src/mst.js");
    const stripped = record.uri.replace("at://", "");
    const slash = stripped.indexOf("/");
    const authorDid = slash >= 0 ? stripped.slice(0, slash) : stripped;
    const pathPart = slash >= 0 ? stripped.slice(slash + 1) : "";
    const { collection, rkey } = splitPath(pathPart);
    if (!authorDid || !collection || !rkey) return;

    // Snapshot before → ingest into the peer repo → snapshot after → emit delta.
    const before = new Map(store.foldLinks().map((l) => [store.hashLink(l), l] as const));
    store.ingestPeerRecords(
        authorDid,
        [{ collection, rkey, value: record.value }],
        [],
        record.cid || null,
    );
    const after = new Map(store.foldLinks().map((l) => [store.hashLink(l), l] as const));

    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];
    for (const [h, l] of after) if (!before.has(h)) additions.push(l);
    for (const [h, l] of before) if (!after.has(h)) removals.push(l);

    if (additions.length === 0 && removals.length === 0) return;
    const diff: PerspectiveDiff = { additions, removals };
    if (linkCallback) linkCallback(diff);
}
