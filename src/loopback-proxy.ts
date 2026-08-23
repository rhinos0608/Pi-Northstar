// ── Zero-dependency local enforcing HTTP/HTTPS/WebSocket proxy ──

import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { promises as dnsPromises } from 'node:dns';

function isLoopbackAddress(addr: string): boolean {
  return addr === '::1' || (net.isIPv4(addr) && addr.startsWith('127.'));
}
import type { Duplex } from 'node:stream';
import type { LoopbackDebugPolicy } from './loopback-debug-policy.js';
import { isAllowedLoopbackRequest } from './loopback-debug-policy.js';

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Minimal enforcing proxy. Only forwards requests matching the exact
 * allowed origin. Everything else is destroyed before any DNS/socket.
 *
 * Binds to 127.0.0.1 on an ephemeral port.
 */
export class LoopbackProxy {
  private readonly server: http.Server;
  private readonly policy: LoopbackDebugPolicy;
  private readonly sockets = new Set<net.Socket>();
  private _port = 0;
  private _closed = false;
  private readonly _pinnedAddresses = new Set<string>();

  constructor(policy: LoopbackDebugPolicy) {
    this.policy = policy;
    this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head).catch(() => { (socket as net.Socket).destroy(); });
    });
    this.server.on('connect', (req, socket, head) => {
      this.handleConnect(req, socket as net.Socket, head).catch(() => { (socket as net.Socket).destroy(); });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    // Prevent listening socket from keeping the process alive after close
    this.server.on('listening', () => { this.server.unref(); });
  }

  get port(): number { return this._port; }
  get closed(): boolean { return this._closed; }

  /**
   * Start the proxy on an ephemeral port.
   * Resolves to the full proxy URL (e.g. http://127.0.0.1:12345).
   */
  async start(): Promise<string> {
    if (this._closed) throw new Error('Proxy already closed');

    // DNS pinning: resolve policy hostname once at start
    const hostname = this.stripBrackets(this.policy.hostname);
    const addrs = await dnsPromises.lookup(hostname, { all: true, family: 0 });
    for (const a of addrs) {
      if (isLoopbackAddress(a.address)) {
        this._pinnedAddresses.add(a.address);
      }
    }
    if (this._pinnedAddresses.size === 0) {
      throw new Error('Policy hostname does not resolve to loopback');
    }

    return new Promise<string>((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (!addr || typeof addr === 'string') { reject(new Error('Proxy bind failed')); return; }
        this._port = addr.port;
        resolve(`http://127.0.0.1:${this._port}`);
      });
      this.server.once('error', (err) => reject(err));
    });
  }

  /**
   * Close the proxy and destroy all tracked sockets.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    // Destroy all active sockets including in-flight upstream connections
    for (const sock of this.sockets) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    this.sockets.clear();
    // Force-destroy all connections so server.close() resolves immediately
    this.server.closeAllConnections();
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  // ── Private ──

  private isAllowedTarget(targetUrl: string): boolean {
    return isAllowedLoopbackRequest(this.policy, targetUrl);
  }

  /** Verify hostname resolves only to pinned addresses. Returns all pinned IPs, or null. */
  private async verifyAgainstPin(hostname: string): Promise<string[] | null> {
    try {
      const stripped = this.stripBrackets(hostname);
      const addrs = await dnsPromises.lookup(stripped, { all: true, family: 0 });
      if (addrs.length === 0) return null;
      if (!addrs.every(a => this._pinnedAddresses.has(a.address))) return null;
      return addrs.map(a => a.address);
    } catch {
      return null;
    }
  }

  private stripBrackets(hostname: string): string {
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname.slice(1, -1);
    }
    return hostname;
  }

  private deny(res: http.ServerResponse, status: number, msg: string): void {
    res.writeHead(status);
    res.end(msg);
  }

  /**
   * Establish an (optionally TLS) socket to the first reachable pinned IP.
   * Falls through to the next candidate on connection failure; resolves null
   * only after every candidate is exhausted. Arms `CONNECT_TIMEOUT_MS` on the
   * socket so idle upstream connections are destroyed.
   */
  private connectUpstream(
    ips: readonly string[],
    port: number,
    tlsOpts: { tls: true; servername?: string } | { tls: false },
  ): Promise<net.Socket | null> {
    return new Promise((resolve) => {
      let idx = 0;
      let settled = false;
      const tryNext = (): void => {
        if (settled) return;
        if (idx >= ips.length) {
          settled = true;
          resolve(null);
          return;
        }
        const ip = ips[idx++]!;
        const sock = tlsOpts.tls
          ? tls.connect({ host: ip, port, servername: tlsOpts.servername })
          : net.connect({ host: ip, port });
        sock.setTimeout(CONNECT_TIMEOUT_MS);
        sock.once('connect', () => {
          settled = true;
          resolve(sock);
        });
        sock.once('error', () => {
          sock.destroy();
          if (!settled) tryNext();
        });
      };
      tryNext();
    });
  }

  /**
   * Handle plain HTTP proxy requests.
   * The browser sends: GET http://target:port/path HTTP/1.1
   */
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const targetUrl = req.url;
    if (!targetUrl || !this.isAllowedTarget(targetUrl)) {
      this.deny(res, 403, 'Blocked by loopback debug policy');
      req.resume();
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      this.deny(res, 400, 'Invalid target URL');
      return;
    }

    // DNS pinning: verify target resolves to pinned addresses (prevents rebinding)
    const pinnedIps = await this.verifyAgainstPin(parsed.hostname);
    if (!pinnedIps) {
      this.deny(res, 403, 'Target does not resolve to allowed origin');
      req.resume();
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);

    const upstream = await (isHttps
      ? this.connectUpstream(pinnedIps, port, { tls: true, servername: this.stripBrackets(parsed.hostname) })
      : this.connectUpstream(pinnedIps, port, { tls: false }));
    if (!upstream) {
      this.deny(res, 502, 'Upstream connection failed');
      req.resume();
      return;
    }

    // Connect over the pre-established (pinned, TLS-ready) socket. The policy
    // hostname is preserved in the Host header after stripProxyHeaders removes
    // it, and drives TLS servername inside connectUpstream. We speak plain HTTP
    // over the existing socket — any TLS wrapping already happened for https:.
    const proxyReq = http.request({
      createConnection: () => upstream,
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...this.stripProxyHeaders(req.headers), host: parsed.hostname },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, this.stripHopByHopHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    });

    // Track upstream socket so close() can destroy in-flight connections
    proxyReq.on('socket', (sock: net.Socket) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) this.deny(res, 502, 'Upstream error');
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) this.deny(res, 504, 'Upstream timeout');
    });

    // createConnection gives us a socket already connecting; writing starts it.
    proxyReq.flushHeaders();
    req.pipe(proxyReq);
  }

  /**
   * Handle WebSocket upgrade requests.
   * Allow only same-origin ws:// or wss:// upgrades.
   */
  private async handleUpgrade(req: http.IncomingMessage, rawSocket: net.Socket | Duplex, head: Buffer): Promise<void> {
    const socket = rawSocket as net.Socket;
    const targetUrl = req.url;
    if (!targetUrl || !this.isAllowedTarget(targetUrl)) {
      socket.destroy();
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      socket.destroy();
      return;
    }

    // DNS pinning: verify target resolves to pinned addresses
    const pinnedIps = await this.verifyAgainstPin(parsed.hostname);
    if (!pinnedIps) {
      socket.destroy();
      return;
    }

    const isWss = parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : (isWss ? 443 : 80);

    const upstream = await (isWss
      ? this.connectUpstream(pinnedIps, port, { tls: true, servername: this.stripBrackets(parsed.hostname) })
      : this.connectUpstream(pinnedIps, port, { tls: false }));
    if (!upstream) {
      socket.destroy();
      return;
    }

    // Forward every client upgrade header verbatim so Cookie / Origin /
    // Sec-WebSocket-Protocol / Sec-WebSocket-Extensions survive the hop.
    const lines = [`GET ${parsed.pathname}${parsed.search} HTTP/1.1`];
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (name === 'host') {
        lines.push(`Host: ${parsed.hostname}:${port}`);
        continue;
      }
      lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    if (!lines.some(l => l.startsWith('Host:'))) lines.push(`Host: ${parsed.hostname}:${port}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    // Preserve and write the client's head bytes after the upgrade request
    if (head && head.length > 0) upstream.write(head);

    upstream.on('error', () => { socket.destroy(); });
    upstream.on('timeout', () => { upstream.destroy(); socket.destroy(); });

    // Track upstream socket so close() can destroy it
    this.sockets.add(upstream);
    upstream.on('close', () => {
      this.sockets.delete(upstream);
      socket.destroy();
    });

    // Buffer chunks until the complete HTTP status line is available.
    let received = '';
    let settled = false;
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      received += chunk.toString('latin1');
      const terminator = received.indexOf('\r\n');
      if (terminator === -1) return; // wait for the full status line
      const statusLine = received.slice(0, terminator);
      settled = true;
      if (/^HTTP\/\d(?:\.\d+)? 101(?:\s|$)/i.test(statusLine)) {
        // Forward the 101 response and any bytes already buffered, then pipe.
        socket.write(received);
        upstream.removeAllListeners('data');
        upstream.pipe(socket);
        socket.pipe(upstream);
      } else {
        // Upstream rejected upgrade
        socket.destroy();
        upstream.destroy();
      }
    };
    upstream.on('data', onData);

    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  /**
   * Handle HTTPS CONNECT tunnel requests.
   * Only allow CONNECT to exact target origin.
   */
  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, _head: Buffer): Promise<void> {
    const target = req.url; // format: host:port
    if (!target) { clientSocket.destroy(); return; }

    // Handle IPv6 [::1]:port and IPv4 host:port
    let host: string | undefined;
    let port = 443;
    if (target.startsWith('[')) {
      const closeBracket = target.indexOf(']');
      if (closeBracket < 0) { clientSocket.destroy(); return; }
      host = target.slice(1, closeBracket);
      const rest = target.slice(closeBracket + 1);
      if (rest.startsWith(':')) port = Number(rest.slice(1));
    } else {
      const lastColon = target.lastIndexOf(':');
      host = lastColon >= 0 ? target.slice(0, lastColon) : target;
      port = lastColon >= 0 ? Number(target.slice(lastColon + 1)) : 443;
    }
    if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
      clientSocket.destroy();
      return;
    }

    // CONNECT is always a TLS tunnel; verify target hostname+port match the allowed origin
    // Use https: scheme since CONNECT tunnels TLS, even on non-standard ports
    // Re-bracket IPv6 addresses for URL construction
    const urlHost = host.includes(':') ? `[${host}]` : host;
    const probeUrl = `https://${urlHost}:${port}/`;
    if (!this.isAllowedTarget(probeUrl)) {
      clientSocket.write('HTTP/1.1 403 Blocked\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // DNS pinning: verify target resolves to pinned addresses (prevents rebinding)
    const pinnedIps = await this.verifyAgainstPin(host!);
    if (!pinnedIps) {
      clientSocket.write('HTTP/1.1 403 Blocked\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const upstream = await this.connectUpstream(pinnedIps, port, { tls: false });
    if (!upstream) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);

    upstream.on('error', () => { clientSocket.destroy(); });
    upstream.on('timeout', () => { upstream.destroy(); clientSocket.destroy(); });

    this.sockets.add(clientSocket);
    clientSocket.on('close', () => this.sockets.delete(clientSocket));
    this.sockets.add(upstream);
    upstream.on('close', () => this.sockets.delete(upstream));
  }

  private stripProxyHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    const hopByHop = new Set([
      'proxy-authorization', 'proxy-connection', 'keep-alive',
      'transfer-encoding', 'te', 'trailer', 'upgrade',
      'connection', 'host',
    ]);
    for (const [k, v] of Object.entries(headers)) {
      if (!hopByHop.has(k.toLowerCase()) && v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }

  private stripHopByHopHeaders(headers: http.OutgoingHttpHeaders): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    const hopByHop = new Set([
      'transfer-encoding', 'connection', 'keep-alive',
      'proxy-authenticate', 'proxy-authorization', 'te',
      'trailer', 'upgrade',
    ]);
    for (const [k, v] of Object.entries(headers)) {
      if (!hopByHop.has(k.toLowerCase()) && v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }
}
