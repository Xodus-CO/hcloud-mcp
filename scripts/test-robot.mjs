/**
 * Offline tests for the Robot tool group (#21): no network, no real credentials.
 * Mocks globalThis.fetch and drives the tools through an in-memory MCP client.
 *
 * Usage: npm run build && npm run test:robot
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildAuthHeader, robotConfigured, robotRequest, ROBOT_API } from "../dist/robot-api.js";
import { registerRobotTools } from "../dist/robot-tools.js";

const USER = "#ws+user";
const PASS = "pässword:with/odd chars";
const realFetch = globalThis.fetch;
let calls;
let responder;

function reply(status, body) {
    return new Response(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), { status });
}

test.beforeEach(() => {
    process.env.HROBOT_USER = USER;
    process.env.HROBOT_PASSWORD = PASS;
    calls = [];
    responder = () => reply(200, {});
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
        return responder(calls[calls.length - 1]);
    };
});
test.afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.HROBOT_USER;
    delete process.env.HROBOT_PASSWORD;
});

async function connect() {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    registerRobotTools(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
}
const text = (r) => r.content[0].text;
async function call(name, args = {}) {
    return (await connect()).callTool({ name, arguments: args });
}

test("auth header: Basic base64(user:password), UTF-8", () => {
    assert.equal(buildAuthHeader("u", "p"), "Basic dTpw");
    const h = buildAuthHeader(USER, PASS);
    assert.equal(Buffer.from(h.slice(6), "base64").toString("utf8"), `${USER}:${PASS}`);
});

test("opt-in gating: robotConfigured needs both, non-empty", () => {
    assert.equal(robotConfigured({}), false);
    assert.equal(robotConfigured({ HROBOT_USER: "u" }), false);
    assert.equal(robotConfigured({ HROBOT_PASSWORD: "p" }), false);
    assert.equal(robotConfigured({ HROBOT_USER: "", HROBOT_PASSWORD: "p" }), false);
    assert.equal(robotConfigured({ HROBOT_USER: "u", HROBOT_PASSWORD: "p" }), true);
});

test("request without credentials fails before any network call", async () => {
    delete process.env.HROBOT_PASSWORD;
    await assert.rejects(robotRequest("GET", "/server"), /must both be set/);
    assert.equal(calls.length, 0);
});

test("requests go to the Robot host with the auth header, credentials not in URL", async () => {
    responder = () => reply(200, []);
    await call("robot_list_servers");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ROBOT_API}/server`);
    assert.equal(calls[0].headers.Authorization, buildAuthHeader(USER, PASS));
    assert.ok(!calls[0].url.includes(USER) && !calls[0].url.includes("p%C3%A4ss"));
});

test("robot_list_servers unwraps items; empty 404 NOT_FOUND gives []", async () => {
    responder = () => reply(200, [{ server: { server_number: 321, server_name: "s1" } }, { server: { server_number: 322 } }]);
    assert.deepEqual(JSON.parse(text(await call("robot_list_servers"))).map((s) => s.server_number), [321, 322]);
    responder = () => reply(404, { error: { status: 404, code: "NOT_FOUND", message: "none" } });
    assert.deepEqual(JSON.parse(text(await call("robot_list_servers"))), []);
});

test("robot_get_server / ip / subnet / rdns paths and unwrapping", async () => {
    responder = () => reply(200, { server: { server_number: 321 } });
    assert.equal(JSON.parse(text(await call("robot_get_server", { server_number: 321 }))).server_number, 321);
    assert.equal(calls[0].url, `${ROBOT_API}/server/321`);

    responder = () => reply(200, { ip: { ip: "1.2.3.4" } });
    await call("robot_get_ip", { ip: "1.2.3.4" });
    assert.equal(calls[1].url, `${ROBOT_API}/ip/1.2.3.4`);

    responder = () => reply(200, { subnet: { ip: "2a01:4f8:111:4221::", mask: 64 } });
    const sub = JSON.parse(text(await call("robot_get_subnet", { net_ip: "2a01:4f8:111:4221::" })));
    assert.equal(sub.mask, 64);
    assert.equal(calls[2].url, `${ROBOT_API}/subnet/2a01%3A4f8%3A111%3A4221%3A%3A`);

    responder = () => reply(200, { rdns: { ip: "1.2.3.4", ptr: "a.example.com" } });
    assert.equal(JSON.parse(text(await call("robot_get_rdns", { ip: "1.2.3.4" }))).ptr, "a.example.com");
});

test("list ips/subnets/rdns pass the server_ip filter", async () => {
    responder = () => reply(200, [{ ip: { ip: "1.2.3.4" } }]);
    await call("robot_list_ips", { server_ip: "5.6.7.8" });
    responder = () => reply(200, [{ subnet: { ip: "x" } }]);
    await call("robot_list_subnets", {});
    responder = () => reply(200, [{ rdns: { ip: "1.2.3.4", ptr: "p" } }]);
    await call("robot_list_rdns", { server_ip: "5.6.7.8" });
    assert.equal(calls[0].url, `${ROBOT_API}/ip?server_ip=5.6.7.8`);
    assert.equal(calls[1].url, `${ROBOT_API}/subnet`);
    assert.equal(calls[2].url, `${ROBOT_API}/rdns?server_ip=5.6.7.8`);
});

test("invalid IP arguments are rejected before any request", async () => {
    const r = await call("robot_get_ip", { ip: "1.2.3.4/../server" });
    assert.equal(r.isError, true);
    assert.equal(calls.length, 0);
});

test("robot_get_traffic: POST form with ip[] / subnet[] and single_values", async () => {
    responder = () => reply(200, { traffic: { type: "month", data: { "1.2.3.4": { in: 1, out: 2, sum: 3 } } } });
    const r = await call("robot_get_traffic", {
        type: "month", from: "2026-10-01", to: "2026-10-31", ips: ["1.2.3.4", "5.6.7.8"], subnets: ["2a01:4f8::"], single_values: true,
    });
    assert.equal(JSON.parse(text(r)).data["1.2.3.4"].sum, 3);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `${ROBOT_API}/traffic`);
    assert.equal(calls[0].headers["Content-Type"], "application/x-www-form-urlencoded");
    const body = new URLSearchParams(calls[0].body);
    assert.deepEqual(body.getAll("ip[]"), ["1.2.3.4", "5.6.7.8"]);
    assert.deepEqual(body.getAll("subnet[]"), ["2a01:4f8::"]);
    assert.equal(body.get("type"), "month");
    assert.equal(body.get("from"), "2026-10-01");
    assert.equal(body.get("single_values"), "true");
});

test("robot_get_traffic needs an ip or subnet", async () => {
    const r = await call("robot_get_traffic", { type: "year", from: "2026-01", to: "2026-10" });
    assert.equal(r.isError, true);
    assert.match(text(r), /at least one/);
    assert.equal(calls.length, 0);
});

test("robot_get_boot_config and reset options", async () => {
    responder = () => reply(200, { boot: { rescue: { active: false } } });
    assert.equal(JSON.parse(text(await call("robot_get_boot_config", { server_number: 321 }))).rescue.active, false);
    assert.equal(calls[0].url, `${ROBOT_API}/boot/321`);

    responder = () => reply(200, { reset: { server_number: 321, type: ["sw", "hw"], operating_status: "running" } });
    assert.deepEqual(JSON.parse(text(await call("robot_get_reset_options", { server_number: 321 }))).type, ["sw", "hw"]);
    assert.equal(calls[1].url, `${ROBOT_API}/reset/321`);

    responder = () => reply(200, [{ reset: { server_number: 1 } }, { reset: { server_number: 2 } }]);
    assert.equal(JSON.parse(text(await call("robot_get_reset_options"))).length, 2);
    assert.equal(calls[2].url, `${ROBOT_API}/reset`);
});

test("robot_enable_rescue: POST os + authorized_key[] fingerprints", async () => {
    responder = () => reply(200, { rescue: { active: true, password: "rescuepw", os: "linux" } });
    const r = await call("robot_enable_rescue", { server_number: 321, authorized_keys: ["aa:bb", "cc:dd"] });
    assert.equal(JSON.parse(text(r)).active, true);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `${ROBOT_API}/boot/321/rescue`);
    const body = new URLSearchParams(calls[0].body);
    assert.equal(body.get("os"), "linux");
    assert.deepEqual(body.getAll("authorized_key[]"), ["aa:bb", "cc:dd"]);
    assert.equal(body.has("keyboard"), false);
});

test("robot_disable_rescue: DELETE", async () => {
    responder = () => reply(200, { rescue: { active: false } });
    assert.equal(JSON.parse(text(await call("robot_disable_rescue", { server_number: 321 }))).active, false);
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url, `${ROBOT_API}/boot/321/rescue`);
});

test("robot_reset_server: POST type, rejects unknown types", async () => {
    responder = () => reply(200, { reset: { server_number: 321, type: "hw" } });
    for (const type of ["sw", "hw", "power", "man"]) {
        await call("robot_reset_server", { server_number: 321, type });
        assert.equal(new URLSearchParams(calls[calls.length - 1].body).get("type"), type);
    }
    assert.equal(calls[0].url, `${ROBOT_API}/reset/321`);
    const n = calls.length;
    assert.equal((await call("robot_reset_server", { server_number: 321, type: "format" })).isError, true);
    assert.equal(calls.length, n);
});

test("robot_set_rdns uses POST (create or update); robot_delete_rdns uses DELETE", async () => {
    responder = () => reply(201, { rdns: { ip: "1.2.3.4", ptr: "a.example.com" } });
    assert.equal(JSON.parse(text(await call("robot_set_rdns", { ip: "1.2.3.4", ptr: "a.example.com" }))).ptr, "a.example.com");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `${ROBOT_API}/rdns/1.2.3.4`);
    assert.equal(new URLSearchParams(calls[0].body).get("ptr"), "a.example.com");

    responder = () => reply(200, "");
    assert.deepEqual(JSON.parse(text(await call("robot_delete_rdns", { ip: "1.2.3.4" }))), { deleted: true, ip: "1.2.3.4" });
    assert.equal(calls[1].method, "DELETE");
});

test("robot_wake_on_lan: POST /wol/{n}", async () => {
    responder = () => reply(200, { wol: { server_number: 321 } });
    assert.equal(JSON.parse(text(await call("robot_wake_on_lan", { server_number: 321 }))).server_number, 321);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `${ROBOT_API}/wol/321`);
});

test("error mapping", async () => {
    const cases = [
        [401, { error: { status: 401, code: "UNAUTHORIZED", message: "x" } }, /UNAUTHORIZED \(401\).*HROBOT_USER.*10 minutes/],
        [403, { error: { status: 403, code: "RATE_LIMIT_EXCEEDED", max_request: 50, interval: 3600, message: "rate limit exceeded" } }, /RATE_LIMIT_EXCEEDED \(403\).*max 50 requests per 3600s/],
        [404, { error: { status: 404, code: "SERVER_NOT_FOUND", message: "Server with id 9 not found" } }, /SERVER_NOT_FOUND \(404\).*robot_list_servers/],
        [409, { error: { status: 409, code: "RESET_MANUAL_ACTIVE", message: "m" } }, /RESET_MANUAL_ACTIVE \(409\).*already running/],
        [400, { error: { status: 400, code: "INVALID_INPUT", message: "invalid input", missing: null, invalid: ["ptr"] } }, /INVALID_INPUT \(400\).*invalid: ptr/],
        [500, { error: { status: 500, code: "RESET_FAILED", message: "Resetting failed due to an internal error" } }, /RESET_FAILED \(500\).*internal error/],
        [503, "<html>maintenance</html>", /http_error \(503\).*maintenance/],
    ];
    for (const [status, body, re] of cases) {
        responder = () => reply(status, body);
        const r = await call("robot_reset_server", { server_number: 1, type: "sw" });
        assert.equal(r.isError, true, String(status));
        assert.match(text(r), re, String(status));
    }
    // only the list endpoints turn NOT_FOUND into []; a single get stays an error
    responder = () => reply(404, { error: { status: 404, code: "NOT_FOUND", message: "none" } });
    assert.equal((await call("robot_get_server", { server_number: 1 })).isError, true);
});

test("credentials never appear in errors or tool output, even if the server echoes them", async () => {
    const b64 = Buffer.from(`${USER}:${PASS}`).toString("base64");
    responder = () => reply(400, { error: { status: 400, code: "WEIRD", message: `bad ${USER} ${PASS} ${b64}` } });
    const r1 = await call("robot_list_servers");
    globalThis.fetch = async () => { throw new TypeError(`connect failed for ${USER}:${PASS}`); };
    const r2 = await call("robot_list_servers");
    for (const r of [r1, r2]) {
        assert.equal(r.isError, true);
        const t = text(r);
        for (const secret of [USER, PASS, b64]) assert.ok(!t.includes(secret), "secret leaked");
    }
});

test("annotations: reads readOnly; reset/rescue destructive; every tool sets openWorld", async () => {
    const { tools } = await (await connect()).listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    assert.equal(tools.length, 17);
    for (const t of tools) {
        assert.ok(t.name.startsWith("robot_"));
        assert.equal(t.annotations.openWorldHint, true, t.name);
        if (/^robot_(list|get)_/.test(t.name)) assert.equal(t.annotations.readOnlyHint, true, t.name);
    }
    for (const n of ["robot_reset_server", "robot_enable_rescue", "robot_disable_rescue", "robot_delete_rdns"]) {
        assert.equal(by[n].readOnlyHint, false, n);
        assert.equal(by[n].destructiveHint, true, n);
    }
    for (const n of ["robot_set_rdns", "robot_wake_on_lan"]) assert.equal(by[n].destructiveHint, false, n);
});
