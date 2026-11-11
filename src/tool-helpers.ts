// Shared helpers for tool modules.

// hetzner-sdk-ts throws ApiError with the Hetzner error JSON in `body` and a vague
// message ("Forbidden", "Generic Error: ..."). Surface the API's code/message instead,
// matching HcloudApiError's format: "<code> (<status>): <message> <details>".
export const formatError = (error: unknown) => {
    const e = error as { name?: string; status?: number; body?: unknown; message?: string } | undefined;
    if (e && e.name === "ApiError" && e.body != null) {
        let body: any = e.body;
        if (typeof body === "string") {
            try { body = JSON.parse(body); } catch { /* keep string */ }
        }
        const apiErr = body?.error;
        if (apiErr?.code) {
            const details = apiErr.details && Object.keys(apiErr.details).length ? ` ${JSON.stringify(apiErr.details)}` : "";
            return `${apiErr.code} (${e.status}): ${apiErr.message ?? ""}${details}`;
        }
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
};
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

export type PageParams = { page: number; perPage: number };

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
        const response = await fetchPage({ page, perPage: 50 });
        items.push(...((response?.[key] as T[] | undefined) ?? []));
        const next: number | null = response?.meta?.pagination?.next_page ?? null;
        page = next != null && next > page ? next : null; // guard against non-advancing pagination
    }
    return items;
}


export const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
