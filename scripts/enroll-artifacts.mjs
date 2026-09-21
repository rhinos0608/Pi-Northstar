#!/usr/bin/env node

/**
 * scripts/enroll-artifacts.mjs
 *
 * Enrolls artifact hashes and signing metadata into an artifact manifest.
 * Used at packaging / signing time (Gate B Slice 12).
 * Pure node:fs + node:crypto only.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function printUsageAndExit(message) {
  if (message) {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.stderr.write(
    'Usage: enroll-artifacts.mjs --manifest <path> --name <driver> --platform <platform> --file <artifact> [--type native_binary|npm_entry] [--version <v>] [--team-id <id> | --subject <cn>] [--expect <hash>]\n'
  );
  process.exit(1);
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        printUsageAndExit(`Missing value for argument --${key}`);
      }
      parsed[key] = args[++i];
    } else {
      printUsageAndExit(`Unexpected positional argument: ${arg}`);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

const manifestPath = args.manifest;
const name = args.name;
const platform = args.platform;
const filePath = args.file;
const type = args.type || 'native_binary';
const version = args.version;
const teamId = args['team-id'];
const subject = args.subject;
const expectHash = args.expect;

if (!manifestPath || manifestPath.trim() === '') {
  printUsageAndExit('Missing required --manifest argument');
}
if (!name || name.trim() === '') {
  printUsageAndExit('Missing required --name argument');
}
if (!platform || platform.trim() === '') {
  printUsageAndExit('Missing required --platform argument');
}
if (!filePath || filePath.trim() === '') {
  printUsageAndExit('Missing required --file argument');
}

if (type !== 'native_binary' && type !== 'npm_entry') {
  printUsageAndExit(`Invalid --type '${type}': must be 'native_binary' or 'npm_entry'`);
}

let manifestRaw;
try {
  manifestRaw = readFileSync(manifestPath, 'utf8');
} catch (err) {
  process.stderr.write(`Failed to read manifest at ${manifestPath}: ${err.message}\n`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (err) {
  process.stderr.write(`Malformed JSON in manifest at ${manifestPath}: ${err.message}\n`);
  process.exit(1);
}

if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
  process.stderr.write(`Malformed manifest at ${manifestPath}: root must be an object\n`);
  process.exit(1);
}

if (typeof manifest.manifestVersion !== 'string' || manifest.manifestVersion.trim() === '') {
  process.stderr.write(`Malformed manifest at ${manifestPath}: manifestVersion must be non-empty string\n`);
  process.exit(1);
}

if (manifest.artifacts !== undefined && (typeof manifest.artifacts !== 'object' || manifest.artifacts === null || Array.isArray(manifest.artifacts))) {
  process.stderr.write(`Malformed manifest at ${manifestPath}: artifacts must be an object\n`);
  process.exit(1);
}

if (!manifest.artifacts) {
  manifest.artifacts = {};
}

let fileBuffer;
try {
  fileBuffer = readFileSync(filePath);
} catch (err) {
  process.stderr.write(`Failed to read artifact file at ${filePath}: ${err.message}\n`);
  process.exit(1);
}

const computedSha256 = createHash('sha256').update(fileBuffer).digest('hex');

if (expectHash) {
  if (computedSha256.toLowerCase() !== expectHash.toLowerCase()) {
    process.stderr.write(
      `SHA-256 mismatch for ${filePath}: computed ${computedSha256}, expected ${expectHash}\n`
    );
    process.exit(1);
  }
}

const existingEntry = manifest.artifacts[name] && typeof manifest.artifacts[name] === 'object' && !Array.isArray(manifest.artifacts[name])
  ? manifest.artifacts[name]
  : {};

if (type === 'npm_entry') {
  const updatedEntry = {
    ...existingEntry,
    type: 'npm_entry',
    sha256: computedSha256,
  };
  if (version !== undefined) {
    updatedEntry.version = version;
  }
  manifest.artifacts[name] = updatedEntry;
} else {
  const existingPlatforms = existingEntry.platforms && typeof existingEntry.platforms === 'object' && !Array.isArray(existingEntry.platforms)
    ? existingEntry.platforms
    : {};

  const existingPlatformEntry = existingPlatforms[platform] && typeof existingPlatforms[platform] === 'object' && !Array.isArray(existingPlatforms[platform])
    ? existingPlatforms[platform]
    : {};

  const platformEntry = {
    ...existingPlatformEntry,
    sha256: computedSha256,
  };

  if (teamId !== undefined) {
    platformEntry.teamId = teamId;
  }
  if (subject !== undefined) {
    platformEntry.subject = subject;
  }

  const updatedEntry = {
    ...existingEntry,
    type: 'native_binary',
    platforms: {
      ...existingPlatforms,
      [platform]: platformEntry,
    },
  };
  if (version !== undefined) {
    updatedEntry.version = version;
  }
  manifest.artifacts[name] = updatedEntry;
}

try {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
} catch (err) {
  process.stderr.write(`Failed to write updated manifest to ${manifestPath}: ${err.message}\n`);
  process.exit(1);
}

process.stdout.write(`${name}@${platform} = sha256:${computedSha256}\n`);
process.exit(0);
