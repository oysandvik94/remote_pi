// Fork-local egress guard: the extension may only talk to a relay on this
// machine (loopback) or on the user's Tailscale tailnet. Every outbound
// relay connection (WebSocket + mesh HTTP) must pass `assertPrivateRelayUrl`
// first. Hostnames are resolved and *every* resolved address must be in an
// allowed range, so a public DNS answer (e.g. a Funnel-exposed *.ts.net
// name) is rejected too.

import { lookup } from "node:dns/promises";
import net from "node:net";

export class RelayUrlNotAllowedError extends Error {
  constructor(url: string, reason: string) {
    super(`Relay URL not allowed (${reason}): ${url}. Only loopback or Tailscale relays are permitted.`);
    this.name = "RelayUrlNotAllowedError";
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inIpv4Cidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** Loopback, Tailscale CGNAT (100.64.0.0/10), or Tailscale ULA (fd7a:115c:a1e0::/48). */
export function isAllowedRelayAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return inIpv4Cidr(ip, "127.0.0.0", 8) || inIpv4Cidr(ip, "100.64.0.0", 10);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isAllowedRelayAddress(mapped[1]!);
    return lower.startsWith("fd7a:115c:a1e0:");
  }
  return false;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Synchronous pre-check used by URL validation (no DNS). */
export function isAllowedRelayHost(rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return false;
  const host = hostnameOf(url);
  if (net.isIP(host)) return isAllowedRelayAddress(host);
  return host === "localhost" || host.endsWith(".ts.net");
}

/** Throws `RelayUrlNotAllowedError` unless the URL resolves only to allowed addresses. */
export async function assertPrivateRelayUrl(rawUrl: string): Promise<void> {
  if (!isAllowedRelayHost(rawUrl)) {
    throw new RelayUrlNotAllowedError(rawUrl, "host not on allowlist");
  }
  const host = hostnameOf(new URL(rawUrl));
  if (net.isIP(host)) return;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new RelayUrlNotAllowedError(rawUrl, "hostname did not resolve");
  }
  if (addresses.length === 0) {
    throw new RelayUrlNotAllowedError(rawUrl, "hostname did not resolve");
  }
  const bad = addresses.find((a) => !isAllowedRelayAddress(a.address));
  if (bad) {
    throw new RelayUrlNotAllowedError(rawUrl, `resolves to non-private address ${bad.address}`);
  }
}
