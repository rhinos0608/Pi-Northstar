import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export class DriverManifestError extends Error {
  readonly code?: string;
  constructor(message: string, options?: { code?: string }) {
    super(message);
    this.name = 'DriverManifestError';
    if (options?.code !== undefined) this.code = options.code;
  }
}

export interface PlatformArtifactEntry {
  sha256: string;
  [key: string]: unknown;
}

export interface ArtifactEntry {
  sha256?: string;
  platforms?: Record<string, PlatformArtifactEntry>;
  [key: string]: unknown;
}

export interface ArtifactManifest {
  manifestVersion: string;
  generatedAt: string;
  _note?: string;
  artifacts: Record<string, ArtifactEntry>;
  [key: string]: unknown;
}

/**
 * Resolve absolute path to the bundled artifact manifest.
 * Works across both src/desktop/ and dist/desktop/ layout.
 */
export function bundledManifestPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'artifacts', 'artifacts.manifest.json');
}

/**
 * Load manifest from path if present.
 * Returns undefined when missing (ENOENT -> unenrolled skip).
 * Throws DriverManifestError when present but malformed (corrupt trust root fails closed).
 */
export function loadManifestIfPresent(manifestPath: string): ArtifactManifest | undefined {
  try {
    return loadArtifactManifest(manifestPath);
  } catch (error) {
    if (error instanceof DriverManifestError && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Load bundled manifest. Returns undefined if file missing (unenrolled skip); throws if corrupt.
 */
export function loadBundledManifest(): ArtifactManifest | undefined {
  return loadManifestIfPresent(bundledManifestPath());
}

export function loadArtifactManifest(manifestPath: string): ArtifactManifest {
  let rawText: string;
  try {
    rawText = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    const errnoCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    throw new DriverManifestError(
      `Failed to read artifact manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ...(typeof errnoCode === 'string' ? [{ code: errnoCode } as const] : []),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new DriverManifestError(
      `Invalid JSON in artifact manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DriverManifestError(`Malformed artifact manifest at ${manifestPath}: root must be an object`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.manifestVersion !== 'string' || obj.manifestVersion.trim() === '') {
    throw new DriverManifestError(
      `Malformed artifact manifest at ${manifestPath}: manifestVersion must be non-empty string`
    );
  }

  if (typeof obj.generatedAt !== 'string' || obj.generatedAt.trim() === '') {
    throw new DriverManifestError(
      `Malformed artifact manifest at ${manifestPath}: generatedAt must be non-empty string`
    );
  }

  if (typeof obj.artifacts !== 'object' || obj.artifacts === null || Array.isArray(obj.artifacts)) {
    throw new DriverManifestError(`Malformed artifact manifest at ${manifestPath}: artifacts must be an object`);
  }

  return parsed as ArtifactManifest;
}

export function verifyFileAgainstManifest(
  manifest: ArtifactManifest,
  name: string,
  platform: string,
  filePath: string
): boolean {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.artifacts !== 'object' || manifest.artifacts === null) {
    return false;
  }

  const entry = manifest.artifacts[name];
  if (!entry || typeof entry !== 'object') {
    return false;
  }

  let expectedSha256: string | undefined;

  if (
    entry.platforms &&
    typeof entry.platforms === 'object' &&
    entry.platforms[platform] &&
    typeof entry.platforms[platform]?.sha256 === 'string'
  ) {
    expectedSha256 = entry.platforms[platform].sha256;
  } else if (typeof entry.sha256 === 'string') {
    expectedSha256 = entry.sha256;
  }

  if (!expectedSha256 || typeof expectedSha256 !== 'string') {
    return false;
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = readFileSync(filePath);
  } catch {
    return false;
  }

  const actualSha256 = createHash('sha256').update(fileBuffer).digest('hex');
  return actualSha256.toLowerCase() === expectedSha256.toLowerCase();
}

/**
 * Check whether a driver has an enrolled sha256 in the artifact manifest.
 * Returns true only when an expected sha256 string exists for name+platform.
 */
export function isDriverEnrolled(
  manifest: ArtifactManifest,
  name: string,
  platform: string
): boolean {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.artifacts !== 'object' || manifest.artifacts === null) {
    return false;
  }
  const entry = manifest.artifacts[name];
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  let expectedSha256: string | undefined;
  if (
    entry.platforms &&
    typeof entry.platforms === 'object' &&
    entry.platforms[platform] &&
    typeof entry.platforms[platform]?.sha256 === 'string'
  ) {
    expectedSha256 = entry.platforms[platform].sha256;
  } else if (typeof entry.sha256 === 'string') {
    expectedSha256 = entry.sha256;
  }
  return typeof expectedSha256 === 'string' && expectedSha256.trim() !== '';
}

/**
 * Assert that a driver file is trusted according to the artifact manifest.
 * Missing manifest file OR unenrolled entry = not enforced (returns silently; exact
 * pre-Gate-B behavior).
 * Enrolled drivers are enforced: hash mismatch throws before spawn; corrupt manifest throws.
 * DriverManifestError.
 */
export function assertDriverTrusted(
  manifest: ArtifactManifest,
  name: string,
  platform: string,
  filePath: string
): void {
  if (!isDriverEnrolled(manifest, name, platform)) {
    return;
  }
  const trusted = verifyFileAgainstManifest(manifest, name, platform, filePath);
  if (!trusted) {
    throw new DriverManifestError(
      `Driver untrusted: binary '${name}' at '${filePath}' failed manifest verification for platform '${platform}'.`
    );
  }
}

