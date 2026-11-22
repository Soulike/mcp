import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const PACKAGE_DIR_PATTERN = /^servers\/[^/]+$/;
const EXPECTED_REPO_URL_PATTERN = /github\.com\/Soulike\/mcp(?:\.git)?$/;
const EXPECTED_PROVENANCE_URI_PATTERN = /github\.com\/Soulike\/mcp(?:@|$)/;
const NPM_REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const NPM_ATTESTATIONS_BASE_URL =
  'https://registry.npmjs.org/-/npm/v1/attestations';
const SLSA_PROVENANCE_V1_TYPE = 'https://slsa.dev/provenance/v1';
const MIN_TRUSTED_PUBLISHING_NPM_VERSION = '11.5.1';
const GITHUB_RELEASES_API_BASE =
  'https://api.github.com/repos/Soulike/mcp/releases/tags';

export interface PreparedRelease {
  name: string;
  version: string;
  tag: string;
  skipNpmPublish: boolean;
  tagExistsOnOrigin: boolean;
}

export interface PrepareReleaseOptions {
  repoDir: string;
  packageDir: string;
  ref?: string | undefined;
  requireRef?: string | undefined;
  targetSha?: string | undefined;
  finalizeExisting?: boolean | undefined;
  githubToken?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  getNpmVersion?: (() => string) | undefined;
}

function isStrictSemver(version: string): boolean {
  return (
    version.trim() === version &&
    !/^[=v]/i.test(version) &&
    semver.valid(version) !== null
  );
}

function readPackageManifest(
  repoDir: string,
  packageDir: string,
): { name: string; version: string } {
  const manifestPath = join(repoDir, packageDir, 'package.json');
  let rawText: string;
  try {
    rawText = readFileSync(manifestPath, 'utf8');
  } catch (error: unknown) {
    throw new Error(
      `Failed to read ${packageDir}/package.json: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const parsed: unknown = JSON.parse(rawText);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid package.json object in ${packageDir}.`);
  }
  if ('private' in parsed && parsed.private === true) {
    throw new Error(`Cannot release private package in ${packageDir}.`);
  }
  if (
    !('name' in parsed) ||
    typeof parsed.name !== 'string' ||
    parsed.name === ''
  ) {
    throw new Error(`Missing package name in ${packageDir}/package.json.`);
  }
  if (
    !('version' in parsed) ||
    typeof parsed.version !== 'string' ||
    !isStrictSemver(parsed.version)
  ) {
    const versionValue =
      'version' in parsed && typeof parsed.version === 'string'
        ? parsed.version
        : '';
    throw new Error(
      `Invalid Semver version "${versionValue}" in ${packageDir}/package.json.`,
    );
  }

  let repoUrl: string | undefined;
  if ('repository' in parsed) {
    if (typeof parsed.repository === 'string') {
      repoUrl = parsed.repository;
    } else if (
      typeof parsed.repository === 'object' &&
      parsed.repository !== null &&
      'url' in parsed.repository &&
      typeof parsed.repository.url === 'string'
    ) {
      repoUrl = parsed.repository.url;
    }
  }
  if (repoUrl === undefined || !EXPECTED_REPO_URL_PATTERN.test(repoUrl)) {
    throw new Error(
      `Expected repository.url pointing to github.com/Soulike/mcp in ${packageDir}/package.json for npm OIDC provenance.`,
    );
  }

  return { name: parsed.name, version: parsed.version };
}

async function checkPublishedOnNpm(
  packageName: string,
  version: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const encodedPkg = encodeURIComponent(packageName);
  const response = await fetchFn(
    `${NPM_REGISTRY_BASE_URL}/${encodedPkg}/${version}`,
  );
  if (response.status === 200) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  throw new Error(
    `Unexpected npm registry status ${response.status} checking ${packageName}@${version}.`,
  );
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function fetchProvenanceGitCommit(
  packageName: string,
  version: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const encodedPkg = encodeURIComponent(packageName);
  const response = await fetchFn(
    `${NPM_ATTESTATIONS_BASE_URL}/${encodedPkg}@${version}`,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch npm provenance for ${packageName}@${version} (HTTP ${response.status}); cannot verify source commit.`,
    );
  }

  const raw: unknown = await response.json();
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('attestations' in raw) ||
    !isUnknownArray(raw.attestations)
  ) {
    throw new Error(
      `Invalid npm attestations payload for ${packageName}@${version}.`,
    );
  }

  for (const attestation of raw.attestations) {
    if (
      typeof attestation !== 'object' ||
      attestation === null ||
      !('predicateType' in attestation) ||
      attestation.predicateType !== SLSA_PROVENANCE_V1_TYPE ||
      !('bundle' in attestation) ||
      typeof attestation.bundle !== 'object' ||
      attestation.bundle === null ||
      !('dsseEnvelope' in attestation.bundle) ||
      typeof attestation.bundle.dsseEnvelope !== 'object' ||
      attestation.bundle.dsseEnvelope === null ||
      !('payload' in attestation.bundle.dsseEnvelope) ||
      typeof attestation.bundle.dsseEnvelope.payload !== 'string'
    ) {
      continue;
    }

    const decoded: unknown = JSON.parse(
      Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString(
        'utf8',
      ),
    );
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('predicate' in decoded) ||
      typeof decoded.predicate !== 'object' ||
      decoded.predicate === null ||
      !('buildDefinition' in decoded.predicate) ||
      typeof decoded.predicate.buildDefinition !== 'object' ||
      decoded.predicate.buildDefinition === null ||
      !('resolvedDependencies' in decoded.predicate.buildDefinition) ||
      !isUnknownArray(decoded.predicate.buildDefinition.resolvedDependencies)
    ) {
      continue;
    }

    for (const dep of decoded.predicate.buildDefinition.resolvedDependencies) {
      if (
        typeof dep === 'object' &&
        dep !== null &&
        'uri' in dep &&
        typeof dep.uri === 'string' &&
        EXPECTED_PROVENANCE_URI_PATTERN.test(dep.uri) &&
        'digest' in dep &&
        typeof dep.digest === 'object' &&
        dep.digest !== null &&
        'gitCommit' in dep.digest &&
        typeof dep.digest.gitCommit === 'string' &&
        dep.digest.gitCommit !== ''
      ) {
        return dep.digest.gitCommit;
      }
    }
  }

  throw new Error(
    `No matching SLSA provenance gitCommit found for ${packageName}@${version}; cannot verify source commit.`,
  );
}

async function checkGitHubReleaseExists(
  tag: string,
  githubToken: string | undefined,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (githubToken !== undefined && githubToken !== '') {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }
  const response = await fetchFn(
    `${GITHUB_RELEASES_API_BASE}/${encodeURIComponent(tag)}`,
    { headers },
  );
  if (response.status === 200) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  throw new Error(
    `Unexpected GitHub Releases API status ${response.status} checking tag "${tag}".`,
  );
}

function findOriginTagSha(repoDir: string, tag: string): string | undefined {
  const ref = `refs/tags/${tag}`;
  const peeledRef = `${ref}^{}`;
  const output = execFileSync(
    'git',
    ['ls-remote', '--tags', 'origin', ref, peeledRef],
    {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  if (output === '') {
    return undefined;
  }

  let directSha: string | undefined;
  let peeledSha: string | undefined;
  for (const line of output.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha === undefined || name === undefined) {
      continue;
    }
    if (name === peeledRef) {
      peeledSha = sha;
    } else if (name === ref) {
      directSha = sha;
    }
  }
  return peeledSha ?? directSha;
}

function readDefaultNpmVersion(): string {
  return execFileSync('npm', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ensureCompatibleNpmVersion(
  getNpmVersion: (() => string) | undefined,
): void {
  const npmVersion = (getNpmVersion ?? readDefaultNpmVersion)();
  if (
    semver.valid(npmVersion) === null ||
    !semver.gte(npmVersion, MIN_TRUSTED_PUBLISHING_NPM_VERSION)
  ) {
    throw new Error(
      `npm >= ${MIN_TRUSTED_PUBLISHING_NPM_VERSION} is required for OIDC trusted publishing (found "${npmVersion}").`,
    );
  }
}

export async function prepareRelease(
  options: PrepareReleaseOptions,
): Promise<PreparedRelease> {
  if (options.requireRef !== undefined && options.ref !== options.requireRef) {
    throw new Error(
      `Releases may only be triggered from ${options.requireRef} (got ${options.ref ?? 'unknown'}).`,
    );
  }

  if (!PACKAGE_DIR_PATTERN.test(options.packageDir)) {
    throw new Error(
      `Invalid package-dir "${options.packageDir}". Expected "servers/<name>".`,
    );
  }

  const manifest = readPackageManifest(options.repoDir, options.packageDir);
  const tag = `${basename(options.packageDir)}@${manifest.version}`;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const finalizeExisting = options.finalizeExisting === true;

  const [npmExists, githubReleaseExists] = await Promise.all([
    checkPublishedOnNpm(manifest.name, manifest.version, fetchFn),
    checkGitHubReleaseExists(tag, options.githubToken, fetchFn),
  ]);
  const originTagSha = findOriginTagSha(options.repoDir, tag);

  if (githubReleaseExists) {
    throw new Error(`GitHub release "${tag}" already exists.`);
  }

  if (!finalizeExisting) {
    ensureCompatibleNpmVersion(options.getNpmVersion);
    if (npmExists) {
      throw new Error(
        `${manifest.name}@${manifest.version} is already published on npm. Re-run with finalize_existing=true only to complete a missing GitHub release for this commit.`,
      );
    }
    if (originTagSha !== undefined) {
      throw new Error(
        `Git tag "${tag}" already exists on origin (${originTagSha}).`,
      );
    }
    return {
      name: manifest.name,
      version: manifest.version,
      tag,
      skipNpmPublish: false,
      tagExistsOnOrigin: false,
    };
  }

  if (!npmExists) {
    throw new Error(
      `Cannot finalize ${manifest.name}@${manifest.version}: version is not published on npm yet.`,
    );
  }
  if (options.targetSha === undefined || options.targetSha === '') {
    throw new Error(
      `Cannot finalize ${manifest.name}@${manifest.version}: target SHA is required to verify ownership.`,
    );
  }
  const provenanceCommit = await fetchProvenanceGitCommit(
    manifest.name,
    manifest.version,
    fetchFn,
  );
  if (provenanceCommit !== options.targetSha) {
    throw new Error(
      `Published ${manifest.name}@${manifest.version} provenance gitCommit (${provenanceCommit}) does not match target SHA (${options.targetSha}).`,
    );
  }
  if (originTagSha !== undefined && originTagSha !== options.targetSha) {
    throw new Error(
      `Git tag "${tag}" on origin points to ${originTagSha}, expected ${options.targetSha}.`,
    );
  }

  return {
    name: manifest.name,
    version: manifest.version,
    tag,
    skipNpmPublish: true,
    tagExistsOnOrigin: originTagSha !== undefined,
  };
}

function parseCliArgs(argv: readonly string[]): {
  repoDir: string;
  packageDir: string;
  ref: string | undefined;
  requireRef: string | undefined;
  targetSha: string | undefined;
  finalizeExisting: boolean;
  githubToken: string | undefined;
  githubOutputPath: string | undefined;
} {
  let repoDir = process.cwd();
  let packageDir: string | undefined;
  let ref = process.env['GITHUB_REF'];
  let requireRef: string | undefined;
  let targetSha = process.env['GITHUB_SHA'];
  let finalizeExisting = process.env['FINALIZE_EXISTING'] === 'true';
  const githubToken = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
  let githubOutputPath = process.env['GITHUB_OUTPUT'];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--package-dir' && next !== undefined) {
      packageDir = next;
      index++;
    } else if (arg === '--repo' && next !== undefined) {
      repoDir = next;
      index++;
    } else if (arg === '--ref' && next !== undefined) {
      ref = next;
      index++;
    } else if (arg === '--require-ref' && next !== undefined) {
      requireRef = next;
      index++;
    } else if (arg === '--target-sha' && next !== undefined) {
      targetSha = next;
      index++;
    } else if (arg === '--finalize-existing') {
      finalizeExisting = true;
    } else if (arg === '--github-output' && next !== undefined) {
      githubOutputPath = next;
      index++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (packageDir === undefined || packageDir === '') {
    throw new Error(
      'Usage: node scripts/release-mcp/src/prepare-release.ts --package-dir <servers/name> [--require-ref <ref>] [--ref <ref>] [--target-sha <sha>] [--finalize-existing] [--github-output <path>]',
    );
  }

  return {
    repoDir,
    packageDir,
    ref,
    requireRef,
    targetSha,
    finalizeExisting,
    githubToken,
    githubOutputPath,
  };
}

function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const result = await prepareRelease({
      repoDir: args.repoDir,
      packageDir: args.packageDir,
      ref: args.ref,
      requireRef: args.requireRef,
      targetSha: args.targetSha,
      finalizeExisting: args.finalizeExisting,
      githubToken: args.githubToken,
    });

    if (args.githubOutputPath !== undefined && args.githubOutputPath !== '') {
      appendFileSync(args.githubOutputPath, `name=${result.name}\n`);
      appendFileSync(args.githubOutputPath, `version=${result.version}\n`);
      appendFileSync(args.githubOutputPath, `tag=${result.tag}\n`);
      appendFileSync(
        args.githubOutputPath,
        `skip_npm_publish=${result.skipNpmPublish}\n`,
      );
      appendFileSync(
        args.githubOutputPath,
        `tag_exists=${result.tagExistsOnOrigin}\n`,
      );
    }

    console.log(
      `Release validated: ${result.name}@${result.version} (tag ${result.tag}, skipNpmPublish=${result.skipNpmPublish})`,
    );
  } catch (error: unknown) {
    console.error(
      'Release preparation failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
