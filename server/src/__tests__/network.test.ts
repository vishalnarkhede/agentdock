/**
 * Tests for network.ts — which address to hand a phone, and which port.
 *
 * The interface map and the probe are both injected, so nothing here touches a
 * real network. The fixture is this machine's real output, which is what made
 * the ranking necessary: two non-internal addresses, only one of them a LAN.
 */

import { describe, expect, it } from "bun:test";
import {
  candidatePorts,
  mdnsAddress,
  phoneLink,
  probePort,
  rankAddresses,
  type FetchLike,
  type InterfaceMap,
} from "../services/network";

/** Real `os.networkInterfaces()` output: Wi-Fi, loopback, and Tailscale. */
const REAL: InterfaceMap = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [{ address: "192.168.178.67", family: "IPv4", internal: false }],
  utun5: [{ address: "100.72.251.21", family: "IPv4", internal: false }],
};

const CROWDED: InterfaceMap = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
  en5: [{ address: "10.0.9.4", family: "IPv4", internal: false }],
  awdl0: [{ address: "169.254.11.2", family: "IPv4", internal: false }],
  llw0: [{ address: "169.254.90.7", family: "IPv4", internal: false }],
  bridge100: [{ address: "192.168.64.1", family: "IPv4", internal: false }],
  utun4: [{ address: "100.64.0.9", family: "IPv4", internal: false }],
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
  en9: [{ address: "fe80::1", family: "IPv6", internal: false }],
};

describe("rankAddresses", () => {
  it("puts the LAN address before the VPN one", () => {
    expect(rankAddresses(REAL).map((a) => a.host)).toEqual([
      "192.168.178.67",
      "100.72.251.21",
    ]);
  });

  it("keeps the VPN address rather than dropping it, and says what it is", () => {
    const vpn = rankAddresses(REAL).find((a) => a.iface === "utun5");
    expect(vpn?.kind).toBe("vpn");
    expect(vpn?.note).toContain("VPN");
  });

  it("drops loopback", () => {
    expect(rankAddresses(REAL).some((a) => a.host === "127.0.0.1")).toBe(false);
  });

  it("drops IPv6, link-local, AirDrop, hypervisor bridges and docker", () => {
    const hosts = rankAddresses(CROWDED).map((a) => a.host);
    expect(hosts).toEqual(["192.168.1.20", "10.0.9.4", "100.64.0.9"]);
  });

  it("labels Wi-Fi, wired and VPN distinctly", () => {
    expect(rankAddresses(CROWDED).map((a) => a.kind)).toEqual(["wifi", "ethernet", "vpn"]);
  });

  it("treats Linux naming the same way", () => {
    const linux: InterfaceMap = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [{ address: "10.1.1.5", family: "IPv4", internal: false }],
      wlan0: [{ address: "10.1.1.9", family: "IPv4", internal: false }],
    };
    const out = rankAddresses(linux);
    expect(out[0]).toMatchObject({ host: "10.1.1.9", kind: "wifi" });
    expect(out[1]).toMatchObject({ host: "10.1.1.5", kind: "ethernet" });
  });

  it("has nothing to offer on a machine with only loopback", () => {
    expect(rankAddresses({ lo0: REAL.lo0 })).toEqual([]);
  });
});

describe("mdnsAddress", () => {
  it("appends .local", () => {
    expect(mdnsAddress("vishals-mbp")?.host).toBe("vishals-mbp.local");
  });

  it("does not double it up when the hostname already carries it", () => {
    expect(mdnsAddress("vishals-mbp.local")?.host).toBe("vishals-mbp.local");
    expect(mdnsAddress("vishals-mbp.local.")?.host).toBe("vishals-mbp.local");
  });

  it("refuses a hostname that would not survive being put in a URL", () => {
    expect(mdnsAddress("")).toBeNull();
    expect(mdnsAddress("Vishal's MacBook Pro")).toBeNull();
  });
});

/** A probe that answers for the ports given, with the content type given. */
function fakeFetch(serving: Record<string, { status?: number; type?: string }>): FetchLike {
  return async (url) => {
    const hit = serving[url];
    if (!hit) throw new Error("connection refused");
    return new Response("<!doctype html>", {
      status: hit.status ?? 200,
      headers: { "content-type": hit.type ?? "text/html; charset=utf-8" },
    });
  };
}

describe("probePort", () => {
  it("reports http when something there serves HTML", async () => {
    const f = fakeFetch({ "http://127.0.0.1:5290/": {} });
    expect(await probePort(5290, f)).toEqual({ port: 5290, scheme: "http" });
  });

  it("falls through to https when the plain request fails", async () => {
    const f = fakeFetch({ "https://127.0.0.1:5280/": {} });
    expect(await probePort(5280, f)).toEqual({ port: 5280, scheme: "https" });
  });

  it("prefers http when a port somehow answers both", async () => {
    const f = fakeFetch({ "http://127.0.0.1:8080/": {}, "https://127.0.0.1:8080/": {} });
    expect(await probePort(8080, f)).toEqual({ port: 8080, scheme: "http" });
  });

  it("rejects a port that answers without HTML — an API is not a page", async () => {
    const f = fakeFetch({ "http://127.0.0.1:4900/": { type: "application/json" } });
    expect(await probePort(4900, f)).toBeNull();
  });

  it("rejects a port that answers with an error status", async () => {
    const f = fakeFetch({ "http://127.0.0.1:4900/": { status: 404 } });
    expect(await probePort(4900, f)).toBeNull();
  });

  it("reports nothing when nothing is listening", async () => {
    expect(await probePort(9999, fakeFetch({}))).toBeNull();
  });
});

describe("candidatePorts", () => {
  it("tries the plain-HTTP client before the HTTPS one", () => {
    const ports = candidatePorts({});
    expect(ports.indexOf(5290)).toBeLessThan(ports.indexOf(5173));
  });

  it("includes the server's own port, for a build that serves the bundle", () => {
    expect(candidatePorts({ PORT: "4900" })).toContain(4900);
  });

  it("takes the override outright", () => {
    expect(candidatePorts({ AGENTDOCK_PHONE_PORTS: "3000, 3001" })).toEqual([3000, 3001]);
  });

  it("ignores an override that is not ports", () => {
    expect(candidatePorts({ AGENTDOCK_PHONE_PORTS: "yes please" })).toContain(5290);
  });

  it("does not repeat a port", () => {
    const ports = candidatePorts({ PORT: "5290" });
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe("phoneLink", () => {
  const opts = { interfaces: REAL, host: "mbp" };

  it("composes the LAN address with the plain-HTTP port", async () => {
    const link = await phoneLink({
      ...opts,
      ports: [5290, 5280],
      fetchImpl: fakeFetch({ "http://127.0.0.1:5290/": {}, "https://127.0.0.1:5280/": {} }),
    });
    expect(link.url).toBe("http://192.168.178.67:5290");
  });

  it("offers the VPN address and the .local name as alternatives", async () => {
    const link = await phoneLink({
      ...opts,
      ports: [5290],
      fetchImpl: fakeFetch({ "http://127.0.0.1:5290/": {} }),
    });
    expect(link.addresses.map((a) => a.host)).toEqual([
      "192.168.178.67",
      "100.72.251.21",
      "mbp.local",
    ]);
  });

  it("refuses to emit a URL when only the HTTPS client is up, and names the fix", async () => {
    const link = await phoneLink({
      ...opts,
      ports: [5290, 5173],
      fetchImpl: fakeFetch({ "https://127.0.0.1:5173/": {} }),
    });
    expect(link.url).toBeNull();
    expect(link.problem).toContain("vite.mobile.config.ts");
    /* The port is still reported: what was found is not the same question as
       what can be opened. */
    expect(link.ports).toEqual([{ port: 5173, scheme: "https" }]);
  });

  it("says so when no client is running at all", async () => {
    const link = await phoneLink({ ...opts, ports: [5290], fetchImpl: fakeFetch({}) });
    expect(link.url).toBeNull();
    expect(link.problem).toContain("Nothing is serving");
  });

  it("says so when the machine has no network address", async () => {
    const link = await phoneLink({
      interfaces: { lo0: REAL.lo0 },
      host: "mbp",
      ports: [5290],
      fetchImpl: fakeFetch({ "http://127.0.0.1:5290/": {} }),
    });
    expect(link.url).toBeNull();
    expect(link.problem).toContain("no network address");
  });
});
