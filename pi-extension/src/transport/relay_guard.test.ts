import { describe, expect, test } from "vitest";
import { assertPrivateRelayUrl, isAllowedRelayAddress, RelayUrlNotAllowedError } from "./relay_guard.js";

describe("relay_guard", () => {
  test("allows loopback and Tailscale ranges only", () => {
    for (const ip of ["127.0.0.1", "127.5.5.5", "::1", "100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1"]) {
      expect(isAllowedRelayAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "192.168.1.1", "10.0.0.1", "100.63.255.255", "100.128.0.0", "fd00::1", "::ffff:8.8.8.8"]) {
      expect(isAllowedRelayAddress(ip)).toBe(false);
    }
  });

  test("rejects public hosts before any connection", async () => {
    await expect(assertPrivateRelayUrl("https://relay-rp1.jacobmoura.work")).rejects.toBeInstanceOf(RelayUrlNotAllowedError);
    await expect(assertPrivateRelayUrl("wss://1.1.1.1")).rejects.toBeInstanceOf(RelayUrlNotAllowedError);
  });

  test("accepts loopback literals and localhost", async () => {
    await expect(assertPrivateRelayUrl("http://127.0.0.1:3000")).resolves.toBeUndefined();
    await expect(assertPrivateRelayUrl("ws://[::1]:3000")).resolves.toBeUndefined();
    await expect(assertPrivateRelayUrl("http://localhost:3000")).resolves.toBeUndefined();
  });
});
