// Minimal fetch client for the Hetzner Robot webservice (dedicated servers).
// Opt-in: only used when HROBOT_USER and HROBOT_PASSWORD are both set. Credentials are
// read from the environment at call time and only ever go into the Authorization header:
// they are never logged, put into URLs, errors or tool output.

// Host as documented at https://robot.hetzner.com/doc/webservice/en.html. Deliberately a
// constant (no env override) so the credentials can only be sent to Hetzner.
export const ROBOT_API = "https://robot-ws.your-server.de";

type QueryValue = string | number | boolean | undefined | null;
type FormValue = QueryValue | QueryValue[];

export class RobotApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(`${code} (${status}): ${message}`);
    }
}

/** True when both Robot credentials are set and non-empty. */
export function robotConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.HROBOT_USER) && Boolean(env.HROBOT_PASSWORD);
}

/** HTTP Basic header value ("Basic base64(user:password)", UTF-8). */
export function buildAuthHeader(user: string, password: string): string {
    return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

function authHeader(): string {
    const { HROBOT_USER: user, HROBOT_PASSWORD: password } = process.env;
    if (!user || !password) throw new Error("HROBOT_USER and HROBOT_PASSWORD must both be set");
    return buildAuthHeader(user, password);
}

/** Remove the credentials (and their base64 form) from any text before it leaves this module. */
function scrub(text: string): string {
    let out = text;
    const { HROBOT_USER: user, HROBOT_PASSWORD: password } = process.env;
    const secrets = [password, user, user && password ? Buffer.from(`${user}:${password}`).toString("base64") : undefined];
    for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join("[redacted]");
    return out;
}

// Friendly hints for the errors an agent is most likely to hit; the Robot code and
// message are always kept. Codes from https://robot.hetzner.com/doc/webservice/en.html.
const HINTS: Record<string, string> = {
    UNAUTHORIZED: "Robot rejected the credentials. Check HROBOT_USER / HROBOT_PASSWORD (a webservice user from Robot > Settings > Web service and app settings, not your account login). Do not retry in a loop: Hetzner blocks the calling IP for 10 minutes after 3 failed logins",
    RATE_LIMIT_EXCEEDED: "Robot request limit reached (it answers 403, not 429); wait before retrying",
    SERVER_NOT_FOUND: "No dedicated server with this number (or IP) in this Robot account. Use robot_list_servers",
    IP_NOT_FOUND: "This IP is not in this Robot account. Use robot_list_ips",
    RDNS_NOT_FOUND: "This IP has no reverse DNS entry yet",
    BOOT_NOT_AVAILABLE: "This server has no boot configuration (rescue is not available for it)",
    RESET_NOT_AVAILABLE: "This server has no reset option",
    RESET_MANUAL_ACTIVE: "A manual reset is already running for this server",
    WOL_NOT_AVAILABLE: "Wake-on-LAN is not available on this server",
    MAINTENANCE: "The Robot webservice is down for maintenance; try again later",
};

function robotError(status: number, data: any, statusText: string): RobotApiError {
    const err = data?.error ?? {};
    const code: string = err.code ?? (status === 401 ? "UNAUTHORIZED" : "http_error");
    let message: string = HINTS[code] ?? err.message ?? statusText ?? "request failed";
    if (code === "INVALID_INPUT") {
        const parts: string[] = [];
        if (Array.isArray(err.missing) && err.missing.length) parts.push(`missing: ${err.missing.join(", ")}`);
        if (Array.isArray(err.invalid) && err.invalid.length) parts.push(`invalid: ${err.invalid.join(", ")}`);
        message = `Robot rejected the input${parts.length ? ` (${parts.join("; ")})` : ""}`;
    }
    if (code === "RATE_LIMIT_EXCEEDED" && err.max_request && err.interval) {
        message += ` (max ${err.max_request} requests per ${err.interval}s)`;
    }
    if (status === 503 && !HINTS[code]) message = HINTS.MAINTENANCE;
    return new RobotApiError(status, code, scrub(message));
}

function formBody(form: Record<string, FormValue>): string {
    const params = new URLSearchParams();
    for (const [k, raw] of Object.entries(form)) {
        // Robot takes arrays as repeated `name[]=` fields (ip[]=..., authorized_key[]=...).
        if (Array.isArray(raw)) {
            for (const v of raw) if (v !== undefined && v !== null && v !== "") params.append(`${k}[]`, String(v));
        } else if (raw !== undefined && raw !== null && raw !== "") {
            params.append(k, String(raw));
        }
    }
    return params.toString();
}

export async function robotRequest<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: Record<string, QueryValue>; form?: Record<string, FormValue> } = {},
): Promise<T> {
    const url = new URL(ROBOT_API + path);
    for (const [k, v] of Object.entries(options.query ?? {})) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.append(k, String(v));
    }
    let res: Response;
    try {
        res = await fetch(url, {
            method,
            headers: {
                Authorization: authHeader(),
                ...(options.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
            },
            body: options.form ? formBody(options.form) : undefined,
        });
    } catch (e) {
        // Keep only a scrubbed message; never attach the original error object.
        throw new Error(scrub(`Robot request failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    const text = await res.text();
    let data: any = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        if (!res.ok) throw robotError(res.status, undefined, res.statusText);
        throw new Error("Robot returned a non-JSON response");
    }
    if (!res.ok) throw robotError(res.status, data, res.statusText);
    return data as T;
}

/** Robot wraps every list item ([{server: {...}}, ...]); unwrap by key. */
export function unwrap<T = any>(list: unknown, key: string): T[] {
    return (Array.isArray(list) ? list : []).map((item: any) => item?.[key] ?? item);
}

/**
 * List endpoints answer 404 (NOT_FOUND) when there is nothing to list; return [] for that.
 * Other 404s (e.g. SERVER_NOT_FOUND) still surface as errors.
 */
export async function robotList<T = any>(path: string, key: string, query?: Record<string, QueryValue>): Promise<T[]> {
    try {
        return unwrap<T>(await robotRequest("GET", path, { query }), key);
    } catch (e) {
        if (e instanceof RobotApiError && e.status === 404 && e.code === "NOT_FOUND") return [];
        throw e;
    }
}
