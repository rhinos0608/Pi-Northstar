import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateOrReservedAddress, assertPublicHostname, resolvePublicHostname, type DnsLookup } from '../src/network-policy.js';

// ── isPrivateOrReservedAddress ──

test('blocks IPv4 loopback', () => {
  assert.equal(isPrivateOrReservedAddress('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedAddress('127.0.0.2'), true);
  assert.equal(isPrivateOrReservedAddress('127.255.255.255'), true);
});

test('blocks IPv4 private Class A', () => {
  assert.equal(isPrivateOrReservedAddress('10.0.0.0'), true);
  assert.equal(isPrivateOrReservedAddress('10.0.0.1'), true);
  assert.equal(isPrivateOrReservedAddress('10.255.255.255'), true);
});

test('blocks IPv4 private Class B', () => {
  assert.equal(isPrivateOrReservedAddress('172.16.0.0'), true);
  assert.equal(isPrivateOrReservedAddress('172.16.0.1'), true);
  assert.equal(isPrivateOrReservedAddress('172.31.255.255'), true);
});

test('blocks IPv4 private Class C', () => {
  assert.equal(isPrivateOrReservedAddress('192.168.0.0'), true);
  assert.equal(isPrivateOrReservedAddress('192.168.1.1'), true);
  assert.equal(isPrivateOrReservedAddress('192.168.255.255'), true);
});

test('blocks IPv4 link-local', () => {
  assert.equal(isPrivateOrReservedAddress('169.254.0.0'), true);
  assert.equal(isPrivateOrReservedAddress('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedAddress('169.254.255.255'), true);
});

test('blocks IPv4 CGN shared space', () => {
  assert.equal(isPrivateOrReservedAddress('100.64.0.0'), true);
  assert.equal(isPrivateOrReservedAddress('100.64.0.1'), true);
  assert.equal(isPrivateOrReservedAddress('100.127.255.255'), true);
});

test('blocks IPv4 zero network', () => {
  assert.equal(isPrivateOrReservedAddress('0.0.0.0'), true);
  assert.equal(isPrivateOrReservedAddress('0.0.0.1'), true);
  assert.equal(isPrivateOrReservedAddress('0.255.255.255'), true);
});

test('blocks IPv4 documentation ranges', () => {
  assert.equal(isPrivateOrReservedAddress('192.0.2.1'), true);  // TEST-NET-1
  assert.equal(isPrivateOrReservedAddress('198.51.100.1'), true); // TEST-NET-2
  assert.equal(isPrivateOrReservedAddress('203.0.113.1'), true);  // TEST-NET-3
});

test('blocks IPv4 benchmarking', () => {
  assert.equal(isPrivateOrReservedAddress('198.18.0.1'), true);
  assert.equal(isPrivateOrReservedAddress('198.19.255.255'), true);
});

test('blocks IPv4 multicast and reserved', () => {
  assert.equal(isPrivateOrReservedAddress('224.0.0.1'), true);
  assert.equal(isPrivateOrReservedAddress('240.0.0.1'), true);
  assert.equal(isPrivateOrReservedAddress('255.255.255.255'), true);
});

test('accepts public IPv4', () => {
  assert.equal(isPrivateOrReservedAddress('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedAddress('1.1.1.1'), false);
  assert.equal(isPrivateOrReservedAddress('203.0.114.1'), false);
  assert.equal(isPrivateOrReservedAddress('198.20.0.1'), false);
});

test('blocks IPv6 loopback and IPv4-mapped private addresses', () => {
  assert.equal(isPrivateOrReservedAddress('::1'), true);
  assert.equal(isPrivateOrReservedAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateOrReservedAddress('::ffff:10.0.0.1'), true);
});

test('blocks IPv6 ULA', () => {
  assert.equal(isPrivateOrReservedAddress('fc00::1'), true);
  assert.equal(isPrivateOrReservedAddress('fd00::1'), true);
});

test('blocks IPv6 link-local', () => {
  assert.equal(isPrivateOrReservedAddress('fe80::1'), true);
});

test('blocks IPv6 site-local deprecated', () => {
  assert.equal(isPrivateOrReservedAddress('fec0::1'), true);
});

test('blocks IPv6 multicast', () => {
  assert.equal(isPrivateOrReservedAddress('ff02::1'), true);
});

test('blocks IPv6 documentation', () => {
  assert.equal(isPrivateOrReservedAddress('2001:db8::1'), true);
});

test('blocks IPv6 6to4', () => {
  assert.equal(isPrivateOrReservedAddress('2002::1'), true);
});

test('blocks IPv6 unspecified', () => {
  assert.equal(isPrivateOrReservedAddress('::'), true);
});

test('blocks IPv6 benchmarking', () => {
  assert.equal(isPrivateOrReservedAddress('2001:2::1'), true);
});

test('blocks IPv6 discard-only', () => {
  assert.equal(isPrivateOrReservedAddress('100::1'), true);
});

test('accepts public IPv6', () => {
  assert.equal(isPrivateOrReservedAddress('2606:4700::1'), false);
  assert.equal(isPrivateOrReservedAddress('2001:4860:4860::8888'), false);
});

// ── assertPublicHostname ──

test('rejects localhost', () => {
  assert.throws(() => assertPublicHostname('localhost'), /Blocked hostname/);
});

test('rejects *.localhost subdomains', () => {
  assert.throws(() => assertPublicHostname('foo.localhost'), /Blocked hostname/);
});

test('rejects metadata hostnames', () => {
  assert.throws(() => assertPublicHostname('metadata'), /Blocked hostname/);
  assert.throws(() => assertPublicHostname('metadata.google.internal'), /Blocked hostname/);
  assert.throws(() => assertPublicHostname('metadata.azure.com'), /Blocked hostname/);
});

test('rejects instance-data', () => {
  assert.throws(() => assertPublicHostname('instance-data'), /Blocked hostname/);
});

test('rejects docker hostnames', () => {
  assert.throws(() => assertPublicHostname('host.docker.internal'), /Blocked hostname/);
  assert.throws(() => assertPublicHostname('gateway.docker.internal'), /Blocked hostname/);
});

test('rejects private IPv4 literals', () => {
  assert.throws(() => assertPublicHostname('127.0.0.1'), /Private\/reserved/);
  assert.throws(() => assertPublicHostname('10.0.0.1'), /Private\/reserved/);
  assert.throws(() => assertPublicHostname('192.168.1.1'), /Private\/reserved/);
  assert.throws(() => assertPublicHostname('169.254.169.254'), /Private\/reserved/);
  assert.throws(() => assertPublicHostname('100.64.0.1'), /Private\/reserved/);
});

test('rejects private IPv6 literals', () => {
  assert.throws(() => assertPublicHostname('::1'), /Private\/reserved/);
  assert.throws(() => assertPublicHostname('fd00::1'), /Private\/reserved/);
  assert.throws(() => assertPublicHostname('fe80::1'), /Private\/reserved/);
});

test('accepts public hostnames', () => {
  assert.doesNotThrow(() => assertPublicHostname('example.com'));
  assert.doesNotThrow(() => assertPublicHostname('api.github.com'));
  assert.doesNotThrow(() => assertPublicHostname('en.wikipedia.org'));
});

test('accepts public IP literals', () => {
  assert.doesNotThrow(() => assertPublicHostname('8.8.8.8'));
  assert.doesNotThrow(() => assertPublicHostname('1.1.1.1'));
});

test('handles case normalization', () => {
  assert.throws(() => assertPublicHostname('LOCALHOST'), /Blocked hostname/);
  assert.throws(() => assertPublicHostname('Metadata.Google.Internal'), /Blocked hostname/);
});

test('handles trailing dot normalization', () => {
  assert.throws(() => assertPublicHostname('localhost.'), /Blocked hostname/);
});

// ── resolvePublicHostname ──

test('DNS: accepts when all addresses are public', async () => {
  const fakeLookup: DnsLookup = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '8.8.4.4', family: 4 },
  ];
  const addrs = await resolvePublicHostname('example.com', undefined, fakeLookup);
  assert.equal(addrs.length, 2);
  assert.deepEqual(addrs, ['8.8.8.8', '8.8.4.4']);
});

test('DNS: rejects when any address is private', async () => {
  const fakeLookup: DnsLookup = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ];
  await assert.rejects(
    () => resolvePublicHostname('evil.example.com', undefined, fakeLookup),
    /private\/reserved address: 10.0.0.1/,
  );
});

test('DNS: rejects when all addresses are private', async () => {
  const fakeLookup: DnsLookup = async () => [
    { address: '192.168.1.1', family: 4 },
  ];
  await assert.rejects(
    () => resolvePublicHostname('internal.example.com', undefined, fakeLookup),
    /private\/reserved/,
  );
});

test('DNS: rejects empty answer', async () => {
  const fakeLookup: DnsLookup = async () => [];
  await assert.rejects(
    () => resolvePublicHostname('no-answer.example.com', undefined, fakeLookup),
    /no addresses/,
  );
});

test('DNS: rejects on lookup error', async () => {
  const fakeLookup: DnsLookup = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(
    () => resolvePublicHostname('nonexistent.example.com', undefined, fakeLookup),
    /ENOTFOUND/,
  );
});

test('DNS: rejects blocked hostname before lookup', async () => {
  await assert.rejects(
    () => resolvePublicHostname('localhost', undefined, async () => []),
    /Blocked hostname/,
  );
});

test('DNS: rejects private hostname literal before lookup', async () => {
  await assert.rejects(
    () => resolvePublicHostname('10.0.0.1', undefined, async () => []),
    /Private\/reserved/,
  );
});

test('DNS: rejects IPv6 loopback address in answer', async () => {
  const fakeLookup: DnsLookup = async () => [
    { address: '::1', family: 6 },
  ];
  await assert.rejects(
    () => resolvePublicHostname('loopback.example.com', undefined, fakeLookup),
    /private\/reserved address: ::1/,
  );
});

test('DNS: rejects IPv6 ULA in answer', async () => {
  const fakeLookup: DnsLookup = async () => [
    { address: 'fd00::1', family: 6 },
  ];
  await assert.rejects(
    () => resolvePublicHostname('ula.example.com', undefined, fakeLookup),
    /private\/reserved address: fd00::1/,
  );
});
