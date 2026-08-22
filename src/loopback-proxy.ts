// ── Zero-dependency local enforcing HTTP/HTTPS/WebSocket proxy ──

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
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

  /** Verify hostname resolves to pinned addresses. Returns first pinned IP or null. */
  private async verifyAgainstPin(hostname: string): Promise<string | null> {
    try {
      const stripped = this.stripBrackets(hostname);
      const addrs = await dnsPromises.lookup(stripped, { all: true, family: 0 });
      if (addrs.length === 0) return null;
      if (!addrs.every(a => this._pinnedAddresses.has(a.address))) return null;
      return addrs[0]!.address;
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
   * Handle plain HTTP proxy requests.
   * The browser sends: GET http://target:port/path HTTP/1.1
   */
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const targetUrl = req.url;
    if (!targetUrl || !this.isAllowedTarget(targetUrl)) {
      this.deny(res, 403, 'Blocked by loopback debug policy');
      req.destroy();
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
    const pinnedIp = await this.verifyAgainstPin(parsed.hostname);
    if (!pinnedIp) {
      this.deny(res, 403, 'Target does not resolve to allowed origin');
      req.destroy();
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);

    const requestModule = isHttps ? https : http;
    const proxyReq = requestModule.request({
      hostname: pinnedIp,
      port,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: this.stripProxyHeaders(req.headers),
      timeout: CONNECT_TIMEOUT_MS,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, this.stripHopByHopHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) this.deny(res, 502, 'Upstream error');
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) this.deny(res, 504, 'Upstream timeout');
    });

    // Track upstream socket so close() can destroy in-flight connections
    const upstreamSocket = (proxyReq as unknown as { connection?: net.Socket }).connection;
    if (upstreamSocket) {
      this.sockets.add(upstreamSocket);
      upstreamSocket.on('close', () => this.sockets.delete(upstreamSocket));
    }

    req.pipe(proxyReq);
  }

  /**
   * Handle WebSocket upgrade requests.
   * Allow only same-origin ws:// or wss:// upgrades.
   */
  private async handleUpgrade(req: http.IncomingMessage, rawSocket: net.Socket | Duplex, _head: Buffer): Promise<void> {
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
    const pinnedIp = await this.verifyAgainstPin(parsed.hostname);
    if (!pinnedIp) {
      socket.destroy();
      return;
    }

    const isWss = parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : (isWss ? 443 : 80);

    const upstream = net.connect({ host: pinnedIp, port }, () => {
      // Send upgrade request to upstream
      const reqLine = `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`;
      const headers = `Host: ${parsed.hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`;
      const key = req.headers['sec-websocket-key'] ?? '';
      const keyHeader = key ? `Sec-WebSocket-Key: ${key}\r\n` : '';
      const versionHeader = req.headers['sec-websocket-version'] ? `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}\r\n` : '';
      upstream.write(reqLine + headers + keyHeader + versionHeader + '\r\n');
    });

    upstream.on('error', () => { socket.destroy(); });
    upstream.on('timeout', () => { upstream.destroy(); socket.destroy(); });

    // Track upstream socket so close() can destroy it
    this.sockets.add(upstream);
    upstream.on('close', () => {
      this.sockets.delete(upstream);
      socket.destroy();
    });

    upstream.once('data', (data: Buffer) => {
      // Check for 101 Switching Protocols
      const statusLine = data.toString('latin1').split('\r\n')[0] ?? '';
      if (statusLine.includes('101')) {
        // Forward the 101 response to client
        socket.write(data);
        // Bidirectional pipe
        upstream.pipe(socket);
        socket.pipe(upstream);
      } else {
        // Upstream rejected upgrade
        socket.destroy();
        upstream.destroy();
      }
    });

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
    const pinnedIp = await this.verifyAgainstPin(host!);
    if (!pinnedIp) {
      clientSocket.write('HTTP/1.1 403 Blocked\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect({ host: pinnedIp, port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

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
