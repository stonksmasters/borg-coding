import assert from "node:assert/strict";
import test from "node:test";
import { amassPassiveDiscoveryAdapter, arpScanDiscoveryAdapter, binwalkSignatureAdapter, dirbContentDiscoveryAdapter, dmitryDomainIntelAdapter, dnsenumDiscoveryAdapter, dnsmapDiscoveryAdapter, domainReconAdapter, enum4linuxHostAuditAdapter, exiftoolMetadataAdapter, ffufContentDiscoveryAdapter, fierceDiscoveryAdapter, fpingReachabilityAdapter, hashdeepFileHashAdapter, ikeServiceProbeAdapter, maigretFullUsernameSearchAdapter, maigretUsernameSearchAdapter, niktoWebAuditAdapter, phoneEnrichmentAdapter, publicEmailSearchAdapter, publicUsernameSearchAdapter, searchsploitLookupAdapter, smbAnonymousShareListAdapter, smbMapAnonymousAdapter, sslscanConfigurationAdapter, tlsConfigurationAdapter, tsharkCaptureAnalysisAdapter, wafDetectionAdapter, webContentDiscoveryAdapter, webFingerprintAdapter, wfuzzContentDiscoveryAdapter, whoisLookupAdapter, wpScanAuditAdapter } from "../packages/core/src/security-operation-adapters.ts";
import type { ExecutionResult } from "../packages/core/src/execution-provider.ts";

function result(stdout: string): ExecutionResult { const now = new Date().toISOString(); return { requestId: "r", nodeId: "n", startedAt: now, finishedAt: now, exitCode: 0, signal: null, timedOut: false, cancelled: false, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false }; }

test("Maigret accepts its completed-with-warnings exit and suppresses progress output", () => {
  const targets = [{ kind: "username" as const, value: "sample_user" }];
  assert.deepEqual(maigretUsernameSearchAdapter.buildExecution(targets).args, ["--no-color", "--no-progressbar", "--folderoutput", "/tmp/borg-maigret-reports", "--timeout", "10", "sample_user"]);
  assert.deepEqual(maigretFullUsernameSearchAdapter.buildExecution(targets).args, ["--all-sites", "--no-color", "--no-progressbar", "--folderoutput", "/tmp/borg-maigret-reports", "--timeout", "10", "--retries", "1", "sample_user"]);
  assert.equal(maigretUsernameSearchAdapter.acceptsResult?.({ ...result(""), stderr: "Short text report:\nSearch by username sample_user returned 0 accounts.", exitCode: 2 }), true);
  assert.equal(maigretUsernameSearchAdapter.acceptsResult?.({ ...result("usage: maigret"), exitCode: 2 }), false);
});

test("public email search limits collection to the scoped email", () => {
  const targets = [{ kind: "email" as const, value: "owner@example.com" }];
  assert.deepEqual(publicEmailSearchAdapter.buildExecution(targets), { executable: "theHarvester", args: ["-d", "example.com", "-b", "all"], timeoutMs: 120000 });
  assert.deepEqual(publicEmailSearchAdapter.parse(result("owner@example.com\nother@example.com\nOWNER@example.com"), targets).references, ["owner@example.com"]);
});

test("public username search emits fixed Sherlock arguments and normalized profile URLs", () => {
  const targets = [{ kind: "username" as const, value: "sample_user" }];
  assert.deepEqual(publicUsernameSearchAdapter.buildExecution(targets).args, ["--print-found", "--no-color", "--timeout", "10", "sample_user"]);
  assert.deepEqual(publicUsernameSearchAdapter.parse(result("[+] Site: https://social.example/sample_user\nTry OSINTSearch: https://osintsearch.org/go/sherlock\n"), targets).profiles, ["https://social.example/sample_user"]);
  assert.deepEqual(maigretUsernameSearchAdapter.parse(result("[♥] Donate on Patreon: https://www.patreon.com/soxoj\n[+] Site One: https://social.example/sample_user\n[+] Site Two: https://other.example/u/sample_user\n[*] Short text report:\nSearch by username sample_user returned 2 accounts.\n"), targets).profiles, ["https://social.example/sample_user", "https://other.example/u/sample_user"]);
});

test("PhoneInfoga uses supported v2 flags and preserves public pivot URLs", () => {
  const targets = [{ kind: "phone" as const, value: "+12025550123" }];
  assert.deepEqual(phoneEnrichmentAdapter.buildExecution(targets).args, ["scan", "-n", "+12025550123"]);
  const parsed = phoneEnrichmentAdapter.parse(result("Country: US\nURL: https://www.google.com/search?q=example\n"), targets);
  assert.equal(parsed.details.rawSummary, "Country: US\nURL: https://www.google.com/search?q=example");
  assert.deepEqual(parsed.references, ["https://www.google.com/search?q=example"]);
});

test("DNSRecon extracts JSON records after progress log output", () => {
  const targets = [{ kind: "domain" as const, value: "example.com" }];
  assert.deepEqual(domainReconAdapter.buildExecution(targets).args, ["-d", "example.com", "-t", "std", "-j", "/dev/stdout"]);
  const parsed = domainReconAdapter.parse(result('INFO Starting enumeration\n[\n  {"type":"A","name":"example.com","address":"192.0.2.1"}\n]\n'), targets);
  assert.deepEqual(parsed.records, [{ type: "A", name: "example.com", address: "192.0.2.1" }]);
});

test("WhatWeb requests quiet JSON and Gobuster stays behind the typed command wrapper", () => {
  const targets = [{ kind: "url" as const, value: "https://example.com" }];
  assert.deepEqual(webFingerprintAdapter.buildExecution(targets).args, ["--quiet", "--color=never", "--log-json=-", "https://example.com"]);
  assert.deepEqual(webFingerprintAdapter.parse(result('[{"plugins":{"HTML5":{},"HTTPServer":{}}}]'), targets).technologies, ["HTML5", "HTTPServer"]);
  assert.equal(webContentDiscoveryAdapter.buildMcpInvocation(targets).mcpTool, "execute_command");
});

test("Whois, Wafw00f, and SSLyze use typed bounded operations", () => {
  const domainTargets = [{ kind: "domain" as const, value: "Example.COM" }];
  assert.deepEqual(whoisLookupAdapter.buildExecution(domainTargets).args, ["--no-recursion", "--", "example.com"]);
  assert.deepEqual(whoisLookupAdapter.parse(result("Domain Name: EXAMPLE.COM\nName Server: NS1.EXAMPLE.COM\nName Server: NS2.EXAMPLE.COM\n"), domainTargets).fields.name_server, ["NS1.EXAMPLE.COM", "NS2.EXAMPLE.COM"]);

  const urlTargets = [{ kind: "url" as const, value: "https://example.com/path" }];
  const waf = wafDetectionAdapter.parse(result('[{"detected":true,"firewall":"ExampleWAF","manufacturer":"Example","trigger_url":"https://example.com/a"}]'), urlTargets);
  assert.equal(waf.detected, true);
  assert.equal(waf.products[0].firewall, "ExampleWAF");
  assert.deepEqual(tlsConfigurationAdapter.buildExecution(urlTargets).args.slice(-2), ["--http_headers", "example.com:443"]);
  const tls = tlsConfigurationAdapter.parse(result(JSON.stringify({ server_scan_results: [{ connectivity_status: "COMPLETED", scan_status: "COMPLETED", scan_result: { certificate_info: { result: { certificate_deployments: [{ id: 1 }] } } }, mozilla_config_test_results: { compliance: "COMPLIANT" } }] })), urlTargets);
  assert.equal(tls.certificateDeployments, 1);
  assert.equal(tls.compliance, "COMPLIANT");
});

test("domain discovery tools use bounded commands and normalize hosts", () => {
  const targets = [{ kind: "domain" as const, value: "Example.COM" }];
  assert.deepEqual(dnsenumDiscoveryAdapter.buildExecution(targets).args, ["--nocolor", "--noreverse", "--threads", "2", "--timeout", "5", "example.com"]);
  assert.deepEqual(dnsmapDiscoveryAdapter.buildExecution(targets).args, ["example.com", "-w", "/usr/share/wordlists/dnsmap.txt", "-d", "25"]);
  assert.deepEqual(fierceDiscoveryAdapter.buildExecution(targets).args, ["--domain", "example.com", "--delay", "0.2"]);
  assert.deepEqual(amassPassiveDiscoveryAdapter.buildExecution(targets).args, ["enum", "-passive", "-nocolor", "-timeout", "2", "-d", "example.com"]);
  assert.deepEqual(dmitryDomainIntelAdapter.buildExecution(targets).args, ["-wse", "example.com"]);

  const parsed = dnsenumDiscoveryAdapter.parse(result("api.example.com. 300 IN A 192.0.2.10\nmail.example.com 192.0.2.20\nadmin@example.com\napi.example.com 192.0.2.10"), targets);
  assert.deepEqual(parsed.hosts, [
    { name: "api.example.com", address: "192.0.2.10" },
    { name: "mail.example.com", address: "192.0.2.20" },
  ]);
  assert.deepEqual(parsed.emails, ["admin@example.com"]);
});

test("web assessment tools use bounded commands and structured parsers", () => {
  const targets = [{ kind: "url" as const, value: "https://example.com/" }];
  assert.equal(ffufContentDiscoveryAdapter.buildExecution(targets).args.at(-1), "https://example.com/FUZZ");
  assert.ok(ffufContentDiscoveryAdapter.buildExecution(targets).args.includes("120"));
  assert.deepEqual(ffufContentDiscoveryAdapter.parse(result('\r\u001b[2K{"url":"https://example.com/admin","status":200,"length":42}\n'), targets).paths, [{ url: "https://example.com/admin", status: 200, length: 42 }]);

  assert.ok(dirbContentDiscoveryAdapter.buildExecution(targets).args.includes("-r"));
  assert.deepEqual(dirbContentDiscoveryAdapter.parse(result("+ https://example.com/login (CODE:200|SIZE:123)\n"), targets).paths, [{ url: "https://example.com/login", status: 200, length: 123 }]);

  const tls = sslscanConfigurationAdapter.parse(result('<protocol type="tls12" enabled="true"/><cipher status="accepted" cipher="TLS_AES_128_GCM_SHA256"/><subject>CN=example.com</subject>'), targets);
  assert.deepEqual(tls.protocols, ["tls12"]);
  assert.deepEqual(tls.ciphers, ["TLS_AES_128_GCM_SHA256"]);
  assert.deepEqual(tls.certificateSubjects, ["CN=example.com"]);

  const nikto = niktoWebAuditAdapter.parse(result(JSON.stringify({ vulnerabilities: [{ id: "1", msg: "Missing header", url: "https://example.com/" }] })), targets);
  assert.deepEqual(nikto.findings, [{ id: "1", message: "Missing header", url: "https://example.com/" }]);
  assert.equal(niktoWebAuditAdapter.parse(result('{"vulnerabilities":[{"id":"2","msg":"Trailing comma",},]}'), targets).findings[0].message, "Trailing comma");
  assert.ok(wpScanAuditAdapter.buildExecution(targets).args.includes("--no-update"));

  const wfuzz = wfuzzContentDiscoveryAdapter.parse(result(JSON.stringify([{ url: "https://example.com/api", code: 403, chars: 20 }])), targets);
  assert.deepEqual(wfuzz.paths, [{ url: "https://example.com/api", status: 403, length: 20 }]);
});

test("network discovery and SMB tools use bounded read-only operations", () => {
  const cidr = [{ kind: "cidr" as const, value: "10.77.0.0/30" }];
  const host = [{ kind: "host" as const, value: "10.77.0.2" }];
  assert.deepEqual(arpScanDiscoveryAdapter.buildExecution(cidr), { executable: "sudo", args: ["-n", "arp-scan", "--plain", "--ignoredups", "--retry=2", "--timeout=500", "10.77.0.0/30"], timeoutMs: 90000 });
  assert.deepEqual(arpScanDiscoveryAdapter.parse(result("10.77.0.2\taa:bb:cc:dd:ee:ff\tRaspberry Pi\n"), cidr).hosts, [{ address: "10.77.0.2", mac: "aa:bb:cc:dd:ee:ff", vendor: "Raspberry Pi" }]);
  assert.ok(fpingReachabilityAdapter.buildExecution(cidr).args.includes("-g"));
  assert.deepEqual(fpingReachabilityAdapter.parse(result("10.77.0.1\n10.77.0.2\n"), cidr).alive, ["10.77.0.1", "10.77.0.2"]);
  assert.deepEqual(ikeServiceProbeAdapter.buildExecution(host).args, ["--retry=2", "--timeout=500", "--interval=20", "10.77.0.2"]);
  assert.equal(ikeServiceProbeAdapter.parse(result("10.77.0.2 Main Mode Handshake returned HDR=(CKY-R=abc)\n"), host).responders.length, 1);
  assert.deepEqual(enum4linuxHostAuditAdapter.buildExecution(host).args, ["-S", "-P", "-o", "-n", "10.77.0.2"]);
  assert.deepEqual(smbAnonymousShareListAdapter.parse(result("Disk|public|Shared files\n"), host).shares, [{ name: "public", type: "Disk", comment: "Shared files" }]);
  assert.ok(smbMapAnonymousAdapter.buildExecution(host).args.includes("--no-write-check"));
  assert.deepEqual(smbMapAnonymousAdapter.parse(result(" public READ ONLY Shared files\n"), host).shares[0].permissions, "READ ONLY");
});

test("local evidence tools require explicit files and return structured results", () => {
  const file = [{ kind: "file" as const, value: "/home/kali/evidence/sample.bin" }];
  assert.deepEqual(exiftoolMetadataAdapter.buildExecution(file).args, ["-json", "-G1", "-n", "--", "/home/kali/evidence/sample.bin"]);
  assert.equal(exiftoolMetadataAdapter.parse(result('[{"File:FileSize":42}]'), file).metadata["File:FileSize"], 42);
  const sha = "a".repeat(64);
  assert.equal(hashdeepFileHashAdapter.parse(result(`%%%% HASHDEEP-1.0\n${sha},sample.bin\n`), file).sha256, sha);
  assert.deepEqual(binwalkSignatureAdapter.parse(result("0 0x00000000 PNG image, 1 x 1\n"), file).signatures, [{ offset: 0, description: "PNG image, 1 x 1" }]);
  const packet = tsharkCaptureAnalysisAdapter.parse(result("1\t1000.5\t192.0.2.1\t\t443\t\t192.0.2.2\t\t51515\t\tTLS\n"), file).packets[0];
  assert.equal(packet.source, "192.0.2.1");
  assert.equal(packet.destinationPort, 51515);

  const query = [{ kind: "query" as const, value: "Apache 2.4" }];
  const lookup = searchsploitLookupAdapter.parse(result(JSON.stringify({ RESULTS_EXPLOIT: [{ "EDB-ID": "123", Title: "Apache example", Path: "exploits/123.txt", Type: "remote", Platform: "linux" }] })), query);
  assert.deepEqual(lookup.matches[0], { id: "123", title: "Apache example", path: "exploits/123.txt", type: "remote", platform: "linux" });
});
