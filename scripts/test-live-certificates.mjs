/**
 * Live certificate test: drives the built MCP server through the certificate tools with a
 * throwaway self-signed RSA-2048 cert (uploaded), then deletes it. Certificates are free.
 * Never creates a managed certificate (that would need real Hetzner DNS delegation).
 *
 * Usage: HCLOUD_TOKEN=... node scripts/test-live-certificates.mjs   (npm run build first; needs openssl)
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.HCLOUD_TOKEN;
if (!token) { console.error("HCLOUD_TOKEN required"); process.exit(1); }

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const NAME = `hcloud-mcp-test-${runId}`;
const CN = `${NAME}.example.com`;
const LABEL = { "hcloud-mcp-test": runId };
let passed = 0;
const ok = (step, detail = "") => { passed++; console.log(`ok   ${step}${detail ? " — " + detail : ""}`); };
const assert = (cond, msg) => { if (!cond) throw new Error(`assertion failed: ${msg}`); };

// Self-signed RSA-2048 cert valid for 30 days.
const dir = mkdtempSync(join(tmpdir(), "hcloud-mcp-cert-"));
execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-sha256",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    "-subj", `/CN=${CN}`, "-addext", `subjectAltName=DNS:${CN}`,
], { stdio: "ignore" });
const certPem = readFileSync(join(dir, "cert.pem"), "utf8");
const keyPem = readFileSync(join(dir, "key.pem"), "utf8");
rmSync(dir, { recursive: true, force: true });

const client = new Client({ name: "live-certificates-test", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, HCLOUD_TOKEN: token } }));

const noKey = (name, text) => assert(!/PRIVATE KEY/.test(text), `${name} output must not contain a private key`);
async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    noKey(name, text);
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}
async function expectError(name, args, pattern) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    noKey(name, text);
    assert(r.isError, `${name} should have failed`);
    assert(pattern.test(text), `${name} error should match ${pattern}: ${text}`);
    return text;
}

let failed = null;
try {
    const created = await call("create_certificate", { name: NAME, type: "uploaded", certificate: certPem, private_key: keyPem, labels: LABEL });
    const cert = created.certificate;
    assert(cert?.id && cert.name === NAME && cert.type === "uploaded", "create_certificate returns certificate");
    assert(created.action == null, "uploaded cert has no action");
    assert(cert.domain_names?.includes(CN), `domain_names from PEM: ${JSON.stringify(cert.domain_names)}`);
    ok("create_certificate (uploaded RSA-2048)", `id ${cert.id}, fingerprint ${cert.fingerprint}`);

    const got = await call("get_certificate", { id: cert.id });
    assert(got.id === cert.id && got.not_valid_after && got.status == null && Array.isArray(got.used_by), "get_certificate fields");
    ok("get_certificate", `valid until ${got.not_valid_after}, used_by ${got.used_by.length}`);

    const byLabel = await call("list_certificates", { label_selector: `hcloud-mcp-test=${runId}` });
    assert(byLabel.length === 1 && byLabel[0].id === cert.id, "list_certificates label_selector");
    const byType = await call("list_certificates", { name: NAME, type: ["uploaded"] });
    assert(byType.length === 1 && byType[0].id === cert.id, "list_certificates name + type");
    const wrongType = await call("list_certificates", { name: NAME, type: ["managed"] });
    assert(wrongType.length === 0, "list_certificates type=managed excludes it");
    ok("list_certificates (label_selector, name + type filters)");

    const renamed = await call("update_certificate", { id: cert.id, name: `${NAME}-renamed`, labels: { ...LABEL, stage: "updated" } });
    assert(renamed.name === `${NAME}-renamed` && renamed.labels.stage === "updated", "update_certificate");
    await expectError("update_certificate", { id: cert.id }, /name and\/or labels/);
    ok("update_certificate (name + labels; empty update rejected locally)");

    await expectError("create_certificate", { name: `${NAME}-m`, type: "managed" }, /domain_names/);
    await expectError("create_certificate", { name: `${NAME}-u`, certificate: certPem }, /private_key/);
    await expectError("create_certificate", { name: `${NAME}-x`, type: "managed", domain_names: [CN], private_key: keyPem }, /only valid for type=uploaded/);
    ok("create_certificate rejects bad per-type fields locally (managed w/o domain_names, uploaded w/o key, mixed)");

    await expectError("retry_certificate", { id: cert.id }, /\(4\d\d\)/);
    ok("retry_certificate on an uploaded cert returns an API error");

    const del = await call("delete_certificate", { id: cert.id });
    assert(del.deleted === cert.id, "delete_certificate result");
    await expectError("get_certificate", { id: cert.id }, /not_found/);
    ok("delete_certificate; certificate gone");
} catch (e) {
    failed = e;
    console.error(`FAIL ${e.message}`);
} finally {
    await client.close().catch(() => {});
    // Safety net: delete only certificates carrying this run's exact label.
    const headers = { Authorization: `Bearer ${token}` };
    const sel = encodeURIComponent(`hcloud-mcp-test=${runId}`);
    const lookup = await fetch(`https://api.hetzner.cloud/v1/certificates?label_selector=${sel}`, { headers });
    if (lookup.ok) {
        for (const c of (await lookup.json()).certificates ?? []) {
            if (c.labels?.["hcloud-mcp-test"] !== runId) continue;
            const r = await fetch(`https://api.hetzner.cloud/v1/certificates/${c.id}`, { method: "DELETE", headers });
            console.log(`safety-net delete of certificate ${c.id}: HTTP ${r.status}`);
        }
    } else {
        console.log(`safety-net lookup: HTTP ${lookup.status}`);
    }
    console.log(`\n${passed} steps passed${failed ? ", 1 failed" : ""}`);
    process.exit(failed ? 1 : 0);
}
