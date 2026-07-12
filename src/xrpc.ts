/**
 * XRPC client — all AT Proto API calls.
 *
 * Uses getTransport().fetch() for all HTTP communication.
 * No ad4m:host imports — uses injected Transport.
 *
 * Also includes: Pure XRPC request/response builders (was xrpc.pure.ts).
 */

import { getTransport } from "./adapters.js";
import type { TransportResponse } from "./adapters.js";
import type {
    ATSession,
    ListRecordsResponse,
    ATRecord,
    RepoWrite,
} from "./types.js";

// ---------------------------------------------------------------------------
// Pure XRPC request/response builders (was xrpc.pure.ts)
// ---------------------------------------------------------------------------

/** Base32 sort characters (0-9, a-v) */
const BASE32_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * Generate a TID from a timestamp in microseconds.
 */
export function tidFromTimestamp(timestampUs: bigint, clockId: number = 0): string {
    const combined = (timestampUs << 10n) | BigInt(clockId & 0x3ff);
    let result = "";
    let value = combined;
    for (let i = 0; i < 13; i++) {
        result = BASE32_CHARS[Number(value & 31n)] + result;
        value >>= 5n;
    }
    return result;
}

/**
 * Generate a TID from an ISO timestamp string.
 */
export function tidFromISO(isoTimestamp: string, clockId: number = 0): string {
    const ms = new Date(isoTimestamp).getTime();
    const us = BigInt(ms) * 1000n;
    return tidFromTimestamp(us, clockId);
}

/**
 * Generate a TID for the current time.
 */
export function tidNow(clockId: number = 0): string {
    const us = BigInt(Date.now()) * 1000n;
    return tidFromTimestamp(us, clockId);
}

export interface XrpcRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

export function buildCreateSessionRequest(
    pdsUrl: string,
    identifier: string,
    password: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.server.createSession`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
    };
}

export function buildRefreshSessionRequest(
    pdsUrl: string,
    refreshJwt: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.server.refreshSession`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${refreshJwt}`,
        },
        body: "",
    };
}

export function buildApplyWritesRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    writes: RepoWrite[],
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.repo.applyWrites`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ repo, writes }),
    };
}

export function buildListRecordsRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    cursor?: string,
    limit: number = 100,
): XrpcRequest {
    let url = `${pdsUrl}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(repo)}&collection=${encodeURIComponent(collection)}&limit=${limit}`;
    if (cursor) {
        url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return {
        url,
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
        },
        body: "",
    };
}

export function buildGetRecordRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
): XrpcRequest {
    const url = `${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repo)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
    return {
        url,
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
        },
        body: "",
    };
}

export function buildUploadBlobRequest(
    pdsUrl: string,
    token: string,
    mimeType: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`,
        method: "POST",
        headers: {
            "Content-Type": mimeType,
            Authorization: `Bearer ${token}`,
        },
        body: "",
    };
}

export function buildDeleteRecordRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ repo, collection, rkey }),
    };
}

export function buildResolveHandleRequest(
    pdsUrl: string,
    handle: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
        method: "GET",
        headers: {},
        body: "",
    };
}

/**
 * `com.atproto.sync.getLatestCommit` — returns a repo's current signed commit
 * `{ cid, rev }`. The `cid` is the head commit CID; this is the real content
 * hash the sync layer diffs against (rather than a listRecords cursor).
 */
export function buildGetLatestCommitRequest(
    pdsUrl: string,
    did: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(did)}`,
        method: "GET",
        headers: {},
        body: "",
    };
}

export function parseGetLatestCommitResponse(body: string): { cid: string; rev: string } | null {
    try {
        const data = JSON.parse(body);
        if (typeof data.cid === "string") {
            return { cid: data.cid, rev: typeof data.rev === "string" ? data.rev : "" };
        }
        return null;
    } catch {
        return null;
    }
}

export function buildCreateRecordRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.repo.createRecord`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ repo, collection, rkey, record }),
    };
}

export function parseSessionResponse(body: string): ATSession | null {
    try {
        const data = JSON.parse(body);
        if (data.accessJwt && data.refreshJwt && data.did) {
            return {
                accessJwt: data.accessJwt,
                refreshJwt: data.refreshJwt,
                did: data.did,
                handle: data.handle,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export function parseListRecordsResponse(body: string): ListRecordsResponse | null {
    try {
        const data = JSON.parse(body);
        if (Array.isArray(data.records)) {
            return {
                records: data.records,
                cursor: data.cursor,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export function parseGetRecordResponse(body: string): ATRecord | null {
    try {
        const data = JSON.parse(body);
        if (data.uri && data.value) {
            return {
                uri: data.uri,
                cid: data.cid || "",
                value: data.value,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export function parseResolveHandleResponse(body: string): string | null {
    try {
        const data = JSON.parse(body);
        return data.did || null;
    } catch {
        return null;
    }
}

export function parseUploadBlobResponse(body: string): { ref: { $link: string }; mimeType: string; size: number } | null {
    try {
        const data = JSON.parse(body);
        if (data.blob) {
            return data.blob;
        }
        return null;
    } catch {
        return null;
    }
}

export function rkeyFromUri(uri: string): string {
    const parts = uri.split("/");
    return parts[parts.length - 1];
}

export function collectionFromUri(uri: string): string {
    const parts = uri.replace("at://", "").split("/");
    return parts.length >= 2 ? parts[1] : "";
}

export function buildAtUri(did: string, collection: string, rkey: string): string {
    return `at://${did}/${collection}/${rkey}`;
}

export function didFromUri(uri: string): string {
    const stripped = uri.replace("at://", "");
    const slashIndex = stripped.indexOf("/");
    return slashIndex >= 0 ? stripped.substring(0, slashIndex) : stripped;
}

// ---------------------------------------------------------------------------
// XRPC API calls
// ---------------------------------------------------------------------------

/**
 * Authenticate to PDS and create a session.
 */
export async function createSession(
    pdsUrl: string,
    identifier: string,
    password: string,
): Promise<ATSession | null> {
    const req = buildCreateSessionRequest(pdsUrl, identifier, password);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseSessionResponse(response.body);
    }
    console.error(`[xrpc] createSession failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Refresh an existing session.
 */
export async function refreshSession(
    pdsUrl: string,
    refreshJwt: string,
): Promise<ATSession | null> {
    const req = buildRefreshSessionRequest(pdsUrl, refreshJwt);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseSessionResponse(response.body);
    }
    console.error(`[xrpc] refreshSession failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Batch create/update/delete records atomically.
 */
export async function applyWrites(
    pdsUrl: string,
    token: string,
    repo: string,
    writes: RepoWrite[],
): Promise<{ success: boolean; response: TransportResponse }> {
    const req = buildApplyWritesRequest(pdsUrl, token, repo, writes);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    const success = response.status >= 200 && response.status < 300;
    if (!success) {
        console.error(`[xrpc] applyWrites failed: ${response.status} ${response.body}`);
    }
    return { success, response };
}

/**
 * List records in a collection with optional cursor pagination.
 */
export async function listRecords(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    cursor?: string,
    limit: number = 100,
): Promise<ListRecordsResponse | null> {
    const req = buildListRecordsRequest(pdsUrl, token, repo, collection, cursor, limit);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseListRecordsResponse(response.body);
    }
    console.error(`[xrpc] listRecords failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Get a single record by its rkey.
 */
export async function getRecord(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
): Promise<ATRecord | null> {
    const req = buildGetRecordRequest(pdsUrl, token, repo, collection, rkey);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseGetRecordResponse(response.body);
    }
    console.error(`[xrpc] getRecord failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Upload a binary blob to the PDS.
 */
export async function uploadBlob(
    pdsUrl: string,
    token: string,
    blob: string,
    mimeType: string = "application/octet-stream",
): Promise<{ ref: { $link: string }; mimeType: string; size: number } | null> {
    const req = buildUploadBlobRequest(pdsUrl, token, mimeType);
    const response = await getTransport().fetch(req.url, req.method, req.headers, blob);

    if (response.status >= 200 && response.status < 300) {
        return parseUploadBlobResponse(response.body);
    }
    console.error(`[xrpc] uploadBlob failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Resolve a handle to a DID.
 */
export async function resolveHandle(
    pdsUrl: string,
    handle: string,
): Promise<string | null> {
    const req = buildResolveHandleRequest(pdsUrl, handle);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseResolveHandleResponse(response.body);
    }
    console.error(`[xrpc] resolveHandle failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Fetch a repo's current signed commit head `{ cid, rev }`.
 *
 * The returned `cid` is the head commit CID — the real content hash the sync
 * layer rides. When it is unchanged since the last sync, the repo has no new
 * links and no records need to be re-fetched.
 */
export async function getLatestCommit(
    pdsUrl: string,
    did: string,
): Promise<{ cid: string; rev: string } | null> {
    const req = buildGetLatestCommitRequest(pdsUrl, did);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseGetLatestCommitResponse(response.body);
    }
    console.error(`[xrpc] getLatestCommit failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Create a single record.
 */
export async function createRecord(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
): Promise<{ uri: string; cid: string } | null> {
    const req = buildCreateRecordRequest(pdsUrl, token, repo, collection, rkey, record);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        try {
            const data = JSON.parse(response.body);
            return { uri: data.uri, cid: data.cid };
        } catch {
            return null;
        }
    }
    console.error(`[xrpc] createRecord failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Delete a single record.
 */
export async function deleteRecord(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
): Promise<boolean> {
    const req = buildDeleteRecordRequest(pdsUrl, token, repo, collection, rkey);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return true;
    }
    console.error(`[xrpc] deleteRecord failed: ${response.status} ${response.body}`);
    return false;
}
