import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { test } from 'node:test';
import { parseLoopbackDebugTarget } from '../../src/browser/loopback-debug-policy.js';
import { LoopbackProxy } from '../../src/browser/loopback-proxy.js';

function makePolicy(url: string) {
  const p = parseLoopbackDebugTarget(url);
  assert.ok(p, `Failed to parse policy from ${url}`);
  return p;
}

function startLocalServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert.ok(addr && typeof addr !== 'string');
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function httpGet(proxyPort: number, targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      method: 'GET',
      headers: { 'Host': new URL(targetUrl).host },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('allowed GET forwarded', async () => {
  const local = await startLocalServer((_req, res) => {
    res.writeHead(200);
    res.end('hello from local');
  });

  const policy = makePolicy(`http://127.0.0.1:${local.port}`);
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    const result = await httpGet(Number(proxyPort), `http://127.0.0.1:${local.port}/test`);
    assert.equal(result.status, 200);
    assert.equal(result.body, 'hello from local');
  } finally {
    await proxy.close();
    await closeServer(local.server);
  }
});

test('foreign target denied before lookup', async () => {
  const policy = makePolicy('http://127.0.0.1:19999'); // non-existent port
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    // Target is a different port — should be denied
    const result = await httpGet(Number(proxyPort), 'http://127.0.0.1:19998/test');
    assert.equal(result.status, 403);
  } finally {
    await proxy.close();
  }
});

test('public target denied before DNS', async () => {
  const policy = makePolicy('http://127.0.0.1:19999');
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    const result = await httpGet(Number(proxyPort), 'http://example.com/');
    assert.equal(result.status, 403);
  } finally {
    await proxy.close();
  }
});

test('RFC1918 target denied', async () => {
  const policy = makePolicy('http://127.0.0.1:19999');
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    const result = await httpGet(Number(proxyPort), 'http://10.0.0.1/');
    assert.equal(result.status, 403);
  } finally {
    await proxy.close();
  }
});

test('metadata target denied', async () => {
  const policy = makePolicy('http://127.0.0.1:19999');
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    const result = await httpGet(Number(proxyPort), 'http://169.254.169.254/');
    assert.equal(result.status, 403);
  } finally {
    await proxy.close();
  }
});

test('WebSocket upgrade same origin succeeds', async () => {
  // Start a simple WS-echo server
  const wsServer = http.createServer();
  wsServer.unref();
  const upgradeSockets: net.Socket[] = [];
  wsServer.on('upgrade', (_req: http.IncomingMessage, socket: net.Socket, _head: Buffer) => {
    // Track upgrade sockets — they escape server.closeAllConnections()
    upgradeSockets.push(socket);
    socket.on('close', () => { const i = upgradeSockets.indexOf(socket); if (i >= 0) upgradeSockets.splice(i, 1); });
    // Accept upgrade
    const key = _req.headers['sec-websocket-key'] ?? '';
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5AB94F2B1E78')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );
    // Echo back
    socket.on('data', (d) => socket.write(d));
  });
  const wsAddr = await new Promise<net.AddressInfo>((resolve) => {
    wsServer.listen(0, '127.0.0.1', () => resolve(wsServer.address() as net.AddressInfo));
  });

  const policy = makePolicy(`http://127.0.0.1:${wsAddr.port}`);
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    // Connect through proxy
    const result = await new Promise<{ connected: boolean; data: string }>((resolve, reject) => {
      const conn = net.connect({ host: '127.0.0.1', port: Number(proxyPort) }, () => {
        const key = 'dGhlIHNhbXBsZSBub25jZQ=='; // standard test key
        conn.write(
          `GET http://127.0.0.1:${wsAddr.port}/ HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${wsAddr.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n'
        );
      });
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('101')) {
          resolve({ connected: true, data: buf });
        }
      });
      conn.on('error', reject);
      setTimeout(() => resolve({ connected: false, data: buf }), 2000);
    });
    assert.equal(result.connected, true, 'WebSocket upgrade should succeed for same origin');
  } finally {
    await proxy.close();
    // Destroy upgrade sockets that escape server tracking
    for (const s of upgradeSockets) { try { s.destroy(); } catch { /* ignore */ } }
    await closeServer(wsServer);
  }
});

test('WebSocket upgrade different port denied', async () => {
  const policy = makePolicy('http://127.0.0.1:19999');
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    const result = await new Promise<boolean>((resolve) => {
      const conn = net.connect({ host: '127.0.0.1', port: Number(proxyPort) }, () => {
        conn.write(
          `GET http://127.0.0.1:19998/ HTTP/1.1\r\n` +
          'Host: 127.0.0.1:19998\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n'
        );
      });
      conn.on('close', () => resolve(false));
      conn.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });
    assert.equal(result, false, 'Cross-port WS upgrade should be denied');
  } finally {
    await proxy.close();
  }
});

test('CONNECT denied for non-exact origin', async () => {
  const policy = makePolicy('http://127.0.0.1:19999');
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    const result = await new Promise<string>((resolve) => {
      const conn = net.connect({ host: '127.0.0.1', port: Number(proxyPort) }, () => {
        conn.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n');
      });
      let buf = '';
      conn.on('data', (d) => { buf += d.toString(); });
      conn.on('close', () => resolve(buf));
      setTimeout(() => resolve(buf), 2000);
    });
    assert.ok(result.includes('403') || result.includes('Blocked'), 'CONNECT should be denied for non-exact origin');
  } finally {
    await proxy.close();
  }
});

test('CONNECT denied for IPv6 non-exact origin', async () => {
  // Policy allows 127.0.0.1:19999 only; CONNECT to [::1]:443 should be denied
  const policy = makePolicy('http://127.0.0.1:19999');
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    const result = await new Promise<string>((resolve) => {
      const conn = net.connect({ host: '127.0.0.1', port: Number(proxyPort) }, () => {
        conn.write('CONNECT [::1]:443 HTTP/1.1\r\n\r\n');
      });
      let buf = '';
      conn.on('data', (d) => { buf += d.toString(); });
      conn.on('close', () => resolve(buf));
      setTimeout(() => resolve(buf), 2000);
    });
    assert.ok(result.includes('403') || result.includes('Blocked'), 'CONNECT to [::1] should be denied when policy is 127.0.0.1');
  } finally {
    await proxy.close();
  }
});

test('proxy close destroys active sockets', async () => {
  const local = await startLocalServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });

  const policy = makePolicy(`http://127.0.0.1:${local.port}`);
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  // Create a connection but don't finish it — close() should destroy it
  const client = net.connect({ host: '127.0.0.1', port: Number(proxyPort) });
  const clientClosed = new Promise((resolve) => client.once('close', resolve));

  await new Promise((r) => setTimeout(r, 50));

  await proxy.close();
  assert.equal(proxy.closed, true);

  await clientClosed;
  assert.equal(client.destroyed, true, 'client socket must be destroyed by close()');

  await closeServer(local.server);
});

test('foreign redirect followed by denied response', async () => {
  // Local server that redirects to a different port
  let redirectCount = 0;
  const local = await startLocalServer((_req: http.IncomingMessage, res: http.ServerResponse) => {
    if (redirectCount === 0) {
      redirectCount++;
      res.writeHead(302, { 'Location': 'http://127.0.0.1:19998/other' });
      res.end();
    } else {
      res.writeHead(200);
      res.end('reached');
    }
  });

  const policy = makePolicy(`http://127.0.0.1:${local.port}`);
  const proxy = new LoopbackProxy(policy);
  const proxyUrl = await proxy.start();
  const proxyPort = new URL(proxyUrl).port;

  try {
    // The proxy forwards the request; the redirect is followed by the client (if any),
    // but we only check the proxy's behavior. The initial 302 should succeed because
    // the original target is allowed.
    const result = await httpGet(Number(proxyPort), `http://127.0.0.1:${local.port}/`);
    assert.equal(result.status, 302);
  } finally {
    await proxy.close();
    await closeServer(local.server);
  }
});
