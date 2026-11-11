// Minimal typed client for Hetzner Cloud API endpoints that hetzner-sdk-ts does not
// cover (e.g. DNS zones / RRSets). Uses the same token as the SDK.
import { OpenAPI } from "hetzner-sdk-ts";

// Cloud API (servers, networks, DNS, ...) and the Hetzner API (Storage Boxes) accept the same project token.
export const CLOUD_API = "https://api.hetzner.cloud/v1";
export const HETZNER_API = "https://api.hetzner.com/v1";

type QueryValue = string | number | boolean | undefined | null;
type Query = Record<string, QueryValue | QueryValue[]>;

export class HcloudApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public details?: unknown,
    ) {
        super(`${code} (${status}): ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
    }
}

function token(): string {
    const t = (typeof OpenAPI.TOKEN === "string" ? OpenAPI.TOKEN : undefined) ?? process.env.HCLOUD_TOKEN;
    if (!t) throw new Error("HCLOUD_TOKEN is not set");
    return t;
}

export async function hcloudRequest<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: Query; body?: unknown; baseUrl?: string } = {},
): Promise<T> {
    const url = new URL((options.baseUrl ?? CLOUD_API) + path);
    for (const [k, raw] of Object.entries(options.query ?? {})) {
        // Arrays become repeated params (?status=ok&status=error), as the API expects.
        for (const v of Array.isArray(raw) ? raw : [raw]) {
            if (v !== undefined && v !== null && v !== "") url.searchParams.append(k, String(v));
        }
    }
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token()}`,
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 204) return {} as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
        const err = data?.error ?? {};
        throw new HcloudApiError(res.status, err.code ?? "http_error", err.message ?? res.statusText, err.details);
    }
    return data as T;
}

/** Encode a path segment (zone names, RRSet names like "@" or "_acme-challenge"). */
export const seg = (value: string | number) => encodeURIComponent(String(value));
