// Shared helpers for tool modules.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// MCP tool annotations (hints for clients). Each tool picks one explicitly at registration.
// Every tool calls the external Hetzner API, so openWorldHint is always true. The spec
// defaults destructiveHint to true, so mutating tools always set it explicitly.
/** Reads only; changes nothing. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
/** Creates or triggers something new on each call; loses nothing. */
export const ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Sets/attaches to a given value; repeating it has no further effect; loses nothing. */
export const ADDITIVE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Can lose data or availability, and repeating it acts again (reboot, reset, rebuild). */
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** Can lose data or availability; repeating it has no further effect (deletes, detaches, replaces). */
export const DESTRUCTIVE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

// Errors from hcloudRequest are HcloudApiError, already formatted as
// "<code> (<status>): <message> <details>".
export const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type ToolResult = {
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    isError?: boolean;
};

export async function withToolError(run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
        return await run();
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
    }
}

export type PageParams = { page: number; per_page: number };

// Hetzner list endpoints are paginated (default 25, max 50 per page). Follow
// meta.pagination.next_page so list tools return every item, not just page 1.
// (Link headers are deprecated by Hetzner; meta.pagination is the supported mechanism.)
export async function listAll<T = unknown>(
    fetchPage: (params: PageParams) => Promise<any>,
    key: string,
): Promise<T[]> {
    const items: T[] = [];
    let page: number | null = 1;
    while (page != null) {
        const response = await fetchPage({ page, per_page: 50 });
        items.push(...((response?.[key] as T[] | undefined) ?? []));
        const next: number | null = response?.meta?.pagination?.next_page ?? null;
        page = next != null && next > page ? next : null; // guard against non-advancing pagination
    }
    return items;
}


export const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
