/**
 * The address to open AgentDock on your phone.
 *
 * Until now nothing in the app knew it: vite printed a LAN URL to a terminal at
 * startup and that was the only place it existed. That works while you can see
 * the terminal, and stops working the moment you cannot — a different machine, a
 * reboot, or a wrapper with no terminal at all.
 *
 * Two things make this more than reading one variable.
 *
 * The host is ambiguous. A laptop routinely has several non-internal IPv4
 * addresses — Wi-Fi, Ethernet, a VPN, and a handful of Apple interfaces that
 * are not networks at all — and "the first one" is a coin flip. It also moves:
 * DHCP hands out a different address on a different day, so this is computed on
 * every request and never stored.
 *
 * The port is worse, because the wrong one looks right. The desktop client is
 * served over HTTPS with a self-signed certificate, which a phone will not let
 * you past on a bare IP; the phone needs the plain-HTTP client. So a port is
 * only offered once something there has answered a request for `/` with HTML.
 */

import { hostname, networkInterfaces } from "os";

export type AddressKind = "wifi" | "ethernet" | "vpn" | "other" | "mdns";

export interface PhoneAddress {
  /** What goes in the URL: an IPv4 address, or a `.local` hostname. */
  host: string;
  /** The interface it came from, or "mDNS" for the hostname row. */
  iface: string;
  kind: AddressKind;
  /** Why someone would pick this one. */
  note: string;
}

export interface PhonePort {
  port: number;
  scheme: "http" | "https";
}

export interface PhoneLink {
  addresses: PhoneAddress[];
  /** Ports that answered with HTML, best first. Empty means nothing is serving. */
  ports: PhonePort[];
  /** The one to show, already composed, or null when nothing can be opened. */
  url: string | null;
  /** Present when there is no URL: what is wrong, in one line. */
  problem?: string;
}

/** The shape of `os.networkInterfaces()`, narrowed to what matters here. */
export type InterfaceMap = Record<
  string,
  { address: string; family: string | number; internal: boolean }[] | undefined
>;

/**
 * Interfaces that exist but are not a way in.
 *
 * `awdl0` and `llw0` are AirDrop and Apple's low-latency link; `bridge*`,
 * `vboxnet*`, `vmnet*` and `docker*` are hypervisor and container networks whose
 * addresses are reachable only from the host. `anpi*` and `ap1` are internal
 * Apple interfaces. None of them is somewhere a phone can dial.
 */
const NOT_A_WAY_IN = /^(awdl|llw|bridge|vboxnet|vmnet|docker|veth|anpi|ap\d|stf|gif|XHC)/i;

/** VPN and tunnel interfaces, which are a way in — just a conditional one. */
const TUNNEL = /^(utun|tun|tap|ppp|wg|tailscale|ipsec)/i;

/**
 * Ranks and labels the addresses a phone could dial.
 *
 * A tunnel address is kept rather than dropped: a VPN like Tailscale is exactly
 * a way to reach this laptop from a phone, and it is the one that keeps working
 * off the network. It ranks below the LAN address because it only works if the
 * phone is on the same VPN — which is why it is labelled rather than silently
 * offered.
 *
 * On macOS `en0` is the Wi-Fi radio and higher `en*` are Ethernet and
 * Thunderbolt; on Linux `wl*` is Wi-Fi and `eth*`/`en*` are wired. Wi-Fi ranks
 * first because a phone is on Wi-Fi, so that is the network it shares.
 */
export function rankAddresses(interfaces: InterfaceMap): PhoneAddress[] {
  const out: (PhoneAddress & { rank: number })[] = [];

  for (const [iface, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      const four = addr.family === "IPv4" || addr.family === 4;
      if (!four || addr.internal) continue;
      /* Link-local: what an interface gives itself when DHCP never answered.
         Nothing routes to it. */
      if (addr.address.startsWith("169.254.")) continue;
      if (NOT_A_WAY_IN.test(iface)) continue;

      if (TUNNEL.test(iface)) {
        out.push({
          host: addr.address,
          iface,
          kind: "vpn",
          note: "over your VPN — works anywhere, if the phone is on it too",
          rank: 3,
        });
      } else if (/^(en0|wl)/i.test(iface)) {
        out.push({
          host: addr.address,
          iface,
          kind: "wifi",
          note: "same Wi-Fi network",
          rank: 0,
        });
      } else if (/^(en|eth)/i.test(iface)) {
        out.push({
          host: addr.address,
          iface,
          kind: "ethernet",
          note: "wired network",
          rank: 1,
        });
      } else {
        out.push({ host: addr.address, iface, kind: "other", note: iface, rank: 2 });
      }
    }
  }

  out.sort((a, b) => a.rank - b.rank || a.host.localeCompare(b.host));
  return out.map(({ rank: _rank, ...rest }) => rest);
}

/**
 * The `<host>.local` row.
 *
 * Worth offering because it is the only one that survives DHCP — the IP above
 * changes when the lease does, this does not, so it is the one to bookmark. It
 * ranks last because mDNS resolution is reliable on iOS and patchy elsewhere.
 */
export function mdnsAddress(host = hostname()): PhoneAddress | null {
  const bare = host.replace(/\.local\.?$/i, "").trim();
  if (!bare || /\s/.test(bare)) return null;
  return {
    host: `${bare}.local`,
    iface: "mDNS",
    kind: "mdns",
    note: "survives a new IP — the one to bookmark",
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Whether something at this port serves the client.
 *
 * A listening port is not the same as a page: in development the API server
 * answers on its own port and serves no HTML at all, so probing for "open"
 * would offer a port that gives a phone nothing but a 404. Asking for `/` and
 * requiring HTML back excludes it in development and correctly includes it in a
 * single-port build where the server does serve the bundle.
 *
 * HTTP is tried first and preferred: the desktop client's certificate is
 * self-signed, and a phone will not accept that on a bare IP address.
 */
export async function probePort(
  port: number,
  fetchImpl: FetchLike = fetch,
): Promise<PhonePort | null> {
  for (const scheme of ["http", "https"] as const) {
    try {
      const res = await fetchImpl(`${scheme}://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1200),
        redirect: "manual",
        /* The dev certificate is self-signed; refusing it here would only mean
           failing to notice a client that is running perfectly well. */
        ...(scheme === "https" ? { tls: { rejectUnauthorized: false } } : {}),
      } as RequestInit);
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.includes("text/html")) return { port, scheme };
    } catch {
      /* Wrong scheme, nothing listening, or a handshake that never completed.
         Either way this is not the port. */
    }
  }
  return null;
}

/**
 * Ports to try, in preference order.
 *
 * `AGENTDOCK_PHONE_PORTS` overrides the list outright, for a setup that serves
 * the client from somewhere this cannot guess.
 */
export function candidatePorts(env: Record<string, string | undefined> = process.env): number[] {
  const override = env.AGENTDOCK_PHONE_PORTS;
  if (override) {
    const parsed = override
      .split(/[,\s]+/)
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    if (parsed.length > 0) return [...new Set(parsed)];
  }

  const server = Number(env.PORT) || 4800;
  /* The plain-HTTP client first — it is the one a phone can open — then the
     desktop client, then the server's own port for a single-port build. */
  return [...new Set([5290, 5173, 5280, server])];
}

/** The whole answer: where to point a phone, and what to say when nowhere. */
export async function phoneLink(
  opts: {
    interfaces?: InterfaceMap;
    host?: string;
    ports?: number[];
    fetchImpl?: FetchLike;
  } = {},
): Promise<PhoneLink> {
  const ifaces = opts.interfaces ?? (networkInterfaces() as InterfaceMap);
  const addresses = rankAddresses(ifaces);
  /* Only alongside a real address: mDNS is advertised over the interfaces, so on
     a machine with nothing but loopback the name resolves for nobody, and
     offering it would be offering a URL that cannot open. */
  const mdns = addresses.length > 0 ? mdnsAddress(opts.host) : null;
  if (mdns) addresses.push(mdns);

  const probed = await Promise.all(
    (opts.ports ?? candidatePorts()).map((p) => probePort(p, opts.fetchImpl)),
  );
  const found = probed.filter((p): p is PhonePort => p !== null);
  /* Plain HTTP first regardless of the order they were tried in: a phone that
     cannot get past the certificate never reaches the page at all. */
  const ports = found.sort((a, b) => (a.scheme === b.scheme ? 0 : a.scheme === "http" ? -1 : 1));

  if (addresses.length === 0) {
    return { addresses, ports, url: null, problem: "This machine has no network address — only loopback." };
  }
  if (ports.length === 0) {
    return {
      addresses,
      ports,
      url: null,
      problem: "Nothing is serving the client. Start it, then reopen this panel.",
    };
  }
  if (ports[0].scheme === "https") {
    return {
      addresses,
      ports,
      url: null,
      problem:
        "The only client running is HTTPS with a self-signed certificate, which a phone will not accept on an IP address. Start the plain-HTTP client: cd client && npx vite --config vite.mobile.config.ts",
    };
  }

  return { addresses, ports, url: `http://${addresses[0].host}:${ports[0].port}` };
}
