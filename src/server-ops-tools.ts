// Server rescue / console / root password actions (#17) and server + load balancer
// metrics (#19), implemented with the direct client in hcloud-api.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hcloudRequest } from "./hcloud-api.js";
import { ADDITIVE, ADDITIVE_IDEMPOTENT, DESTRUCTIVE, READ_ONLY, json, withToolError } from "./tool-helpers.js";

// Hetzner keeps metrics for 30 days.
const MAX_LAST_MINUTES = 30 * 24 * 60;

type TimeArgs = { start?: string; end?: string; last_minutes?: number };

/** Resolve start/end: explicit ISO-8601 pair, or now − last_minutes → now (default 60). */
export function resolveRange({ start, end, last_minutes }: TimeArgs, now = new Date()): { start: string; end: string } {
    if ((start === undefined) !== (end === undefined)) {
        throw new Error("Pass both start and end, or neither (then last_minutes applies)");
    }
    if (start !== undefined && end !== undefined) {
        if (last_minutes !== undefined) throw new Error("Pass either start/end or last_minutes, not both");
        const s = new Date(start);
        const e = new Date(end);
        if (Number.isNaN(s.getTime())) throw new Error(`Invalid start timestamp: ${start}`);
        if (Number.isNaN(e.getTime())) throw new Error(`Invalid end timestamp: ${end}`);
        if (s >= e) throw new Error("start must be before end");
        return { start: s.toISOString(), end: e.toISOString() };
    }
    const minutes = last_minutes ?? 60;
    return { start: new Date(now.getTime() - minutes * 60_000).toISOString(), end: now.toISOString() };
}

type Metrics = { start: string; end: string; step: number; time_series: Record<string, { values: [number, string][] }> };

/** Per-series count/min/avg/max/last so the agent doesn't have to scan every sample. */
export function summarize(metrics: Metrics) {
    const out: Record<string, { points: number; min: number | null; avg: number | null; max: number | null; last: number | null }> = {};
    for (const [name, series] of Object.entries(metrics?.time_series ?? {})) {
        const nums = (series?.values ?? []).map(([, v]) => Number(v)).filter((n) => Number.isFinite(n));
        const round = (n: number) => Math.round(n * 1000) / 1000;
        out[name] = nums.length
            ? {
                points: nums.length,
                min: round(Math.min(...nums)),
                avg: round(nums.reduce((a, b) => a + b, 0) / nums.length),
                max: round(Math.max(...nums)),
                last: round(nums[nums.length - 1]),
            }
            : { points: 0, min: null, avg: null, max: null, last: null };
    }
    return out;
}

const timeParams = {
    start: z.string().optional().describe("Period start, ISO-8601/RFC3339 (e.g. 2026-11-11T10:00:00Z). Give with end, or omit both and use last_minutes"),
    end: z.string().optional().describe("Period end, ISO-8601/RFC3339. Give with start"),
    last_minutes: z.number().int().min(1).max(MAX_LAST_MINUTES).optional()
        .describe("Convenience: period = now minus N minutes until now. Used only when start/end are omitted; default 60. Max 43200 (30-day retention)"),
    step: z.number().positive().optional()
        .describe("Resolution in seconds. Omit to let the API pick (~200 samples); the API caps at 500 samples and adjusts step to fit"),
    include_values: z.boolean().optional()
        .describe("Include the raw time series ([unix_ts, \"value\"] pairs) after the summary. Default true; set false for just the min/avg/max/last summary (much smaller output)"),
};

async function getMetrics(path: string, type: string[], args: TimeArgs & { step?: number; include_values?: boolean }) {
    const range = resolveRange(args);
    const res = await hcloudRequest<{ metrics: Metrics }>("GET", path, {
        // The spec says multiple types are comma-separated (type=cpu,disk).
        query: { type: type.join(","), start: range.start, end: range.end, step: args.step !== undefined ? String(args.step) : undefined },
    });
    const m = res.metrics;
    const summary = summarize(m);
    return json({
        summary,
        start: m?.start,
        end: m?.end,
        step: m?.step,
        ...(args.include_values === false ? {} : { time_series: m?.time_series }),
    });
}

export function registerServerOpsTools(server: McpServer) {
    server.registerTool(
        "enable_rescue",
        {
            description: "Enable the Hetzner Rescue System (minimal Linux for repair/reinstall) on a server. Does NOT reboot: rescue only takes effect at the next boot, so follow with reset_server (or reboot) once the Action succeeds. Rescue is disabled automatically when the server first boots into it, or if it is not used within 60 minutes. Returns an Action and root_password for the rescue system (valid once the Action succeeds; treat as a secret). Pass ssh_keys to log in by key instead",
            inputSchema: {
                id: z.number().describe("Server ID"),
                type: z.enum(["linux64"]).optional().describe("Rescue system type; only linux64 exists (default)"),
                ssh_keys: z.array(z.number()).optional().describe("SSH key IDs to inject into the rescue system"),
            },
            annotations: ADDITIVE,
        },
        async ({ id, type, ssh_keys }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/servers/${id}/actions/enable_rescue`, { body: { type, ssh_keys } }))),
    );

    server.registerTool(
        "disable_rescue",
        {
            description: "Disable the Hetzner Rescue System so the server boots from its own disk next time. Does NOT reboot the server. Usually not needed: rescue disables itself after the first boot into it or after 60 minutes unused. Returns an Action",
            inputSchema: { id: z.number().describe("Server ID") },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/servers/${id}/actions/disable_rescue`))),
    );

    server.registerTool(
        "reset_root_password",
        {
            description: "Generate and set a new root password on a server. Only works on Linux servers that are running (status 'running') AND have the qemu guest agent running; stock images may not ship it, in which case the API accepts the request but the Action ends in error. Returns an Action plus root_password, which is only in effect once the Action succeeds (poll get_action; treat it as a secret). Fallback if it fails: enable_rescue + reset_server, then change the password from the rescue system",
            inputSchema: { id: z.number().describe("Server ID") },
            annotations: DESTRUCTIVE,
        },
        async ({ id }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/servers/${id}/actions/reset_password`))),
    );

    server.registerTool(
        "request_console",
        {
            description: "Request VNC-over-websocket console credentials (keyboard, monitor, mouse) for a server. Returns wss_url (contains a token) and a VNC password, plus an Action. The URL must be used to connect within 1 minute; request a new one after that. An already-open connection is not cut off by that timeout. Treat both values as secrets",
            inputSchema: { id: z.number().describe("Server ID") },
            annotations: ADDITIVE,
        },
        async ({ id }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/servers/${id}/actions/request_console`))),
    );

    server.registerTool(
        "get_server_metrics",
        {
            description: "Get server metrics (last 30 days only). Output starts with a per-series summary {points,min,avg,max,last}, then the raw time_series unless include_values=false. Series: cpu → cpu (percent, per vCPU: 100 = one full vCPU, so divide by vCPU count for overall usage); disk → disk.0.iops.read/write (iop/s), disk.0.bandwidth.read/write (bytes/s); network → network.0.pps.in/out (packets/s), network.0.bandwidth.in/out (bytes/s) on the public interface. Time range: pass start+end (ISO-8601), or omit both and use last_minutes (default 60)",
            inputSchema: {
                id: z.number().describe("Server ID"),
                type: z.array(z.enum(["cpu", "disk", "network"])).min(1).describe("Metric types, e.g. [\"cpu\"] or [\"cpu\",\"network\"]"),
                ...timeParams,
            },
            annotations: READ_ONLY,
        },
        async ({ id, type, ...rest }) => withToolError(() => getMetrics(`/servers/${id}/metrics`, type, rest)),
    );

    server.registerTool(
        "get_load_balancer_metrics",
        {
            description: "Get load balancer metrics (last 30 days only). Output starts with a per-series summary {points,min,avg,max,last}, then the raw time_series unless include_values=false. Series: open_connections (number), connections_per_second, requests_per_second, bandwidth → bandwidth.in/bandwidth.out (bytes/s). Time range: pass start+end (ISO-8601), or omit both and use last_minutes (default 60)",
            inputSchema: {
                id: z.number().describe("Load balancer ID"),
                type: z.array(z.enum(["open_connections", "connections_per_second", "requests_per_second", "bandwidth"])).min(1)
                    .describe("Metric types, e.g. [\"requests_per_second\",\"bandwidth\"]"),
                ...timeParams,
            },
            annotations: READ_ONLY,
        },
        async ({ id, type, ...rest }) => withToolError(() => getMetrics(`/load_balancers/${id}/metrics`, type, rest)),
    );
}
