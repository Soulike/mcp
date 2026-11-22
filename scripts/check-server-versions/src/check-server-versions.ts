import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const SERVER_TEST_PATH_PATTERN =
  /^servers\/[^/]+\/src\/(?:.*\/)?[^/]+\.test\.ts$/;

function isStrictSemver(version: string): boolean {
  return (
    version.trim() === version &&
    !/^[=v]/i.test(version) &&
    semver.valid(version) !== null
  );
}

export function getTriggeredServerPackage(
  filePath: string,
): string | undefined {
  if (!filePath.startsWith('servers/')) {
    return undefined;
  }
  if (SERVER_TEST_PATH_PATTERN.test(filePath)) {
    return undefined;
  }
  const segments = filePath.split('/');
  const packageDir = segments[1];
  if (packageDir === undefined || packageDir === '' || segments.length < 3) {
    return undefined;
  }
  return packageDir;
}

interface PackageManifest {
  version: string;
  privateFlag: boolean;
}

function runGit(repoDir: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitObjectExists(repoDir: string, objectRef: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', objectRef], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function readManifestAtRevision(
  repoDir: string,
  revision: string,
  packageDir: string,
): PackageManifest | undefined {
  const objectRef = `${revision}:servers/${packageDir}/package.json`;
  if (!gitObjectExists(repoDir, objectRef)) {
    return undefined;
  }

  const rawText = runGit(repoDir, ['show', objectRef]);
  const parsed: unknown = JSON.parse(rawText);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid package.json object at ${objectRef}`);
  }
  if (!('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error(`Missing string "version" in ${objectRef}`);
  }
  const privateFlag = 'private' in parsed && parsed.private === true;
  return {
    version: parsed.version,
    privateFlag,
  };
}

export interface VersionCheckResult {
  checkedPackages: readonly string[];
}

export function checkServerVersions(options: {
  repoDir: string;
  baseRev: string;
  headRev: string;
}): VersionCheckResult {
  const diffRaw = runGit(options.repoDir, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    options.baseRev,
    options.headRev,
  ]);

  const changedFiles = diffRaw.split('\0').filter((entry) => entry !== '');
  const triggeredPackages = new Set<string>();
  for (const filePath of changedFiles) {
    const pkg = getTriggeredServerPackage(filePath);
    if (pkg !== undefined) {
      triggeredPackages.add(pkg);
    }
  }

  const failures: string[] = [];
  const checkedPackages: string[] = [];

  for (const packageDir of [...triggeredPackages].sort()) {
    const headManifest = readManifestAtRevision(
      options.repoDir,
      options.headRev,
      packageDir,
    );
    if (headManifest === undefined || headManifest.privateFlag) {
      continue;
    }

    checkedPackages.push(packageDir);

    if (!isStrictSemver(headManifest.version)) {
      failures.push(
        `servers/${packageDir}/package.json has invalid Semver version "${headManifest.version}".`,
      );
      continue;
    }

    const baseManifest = readManifestAtRevision(
      options.repoDir,
      options.baseRev,
      packageDir,
    );
    if (baseManifest === undefined) {
      continue;
    }

    if (!isStrictSemver(baseManifest.version)) {
      failures.push(
        `Baseline servers/${packageDir}/package.json has invalid Semver version "${baseManifest.version}".`,
      );
      continue;
    }

    if (!semver.gt(headManifest.version, baseManifest.version)) {
      failures.push(
        `servers/${packageDir} changed without bumping package.json version (baseline: ${baseManifest.version}, current: ${headManifest.version}).`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }

  return { checkedPackages };
}

export function resolveGitHubActionsRevisions(
  repoDir: string,
  env: NodeJS.ProcessEnv,
): { baseRev: string; headRev: string } {
  const eventName = env['EVENT_NAME'] ?? env['GITHUB_EVENT_NAME'];
  if (eventName === 'pull_request') {
    const baseRef = env['BASE_REF'] ?? env['GITHUB_BASE_REF'];
    const prHeadSha = env['PR_HEAD_SHA'];
    if (
      baseRef === undefined ||
      baseRef === '' ||
      prHeadSha === undefined ||
      prHeadSha === ''
    ) {
      throw new Error(
        'Missing BASE_REF or PR_HEAD_SHA for pull_request version check.',
      );
    }
    const headRev = prHeadSha;
    const baseRev = runGit(repoDir, [
      'merge-base',
      `origin/${baseRef}`,
      headRev,
    ]).trim();
    return { baseRev, headRev };
  }

  const headRev = runGit(repoDir, ['rev-parse', 'HEAD']).trim();
  const baseRev = gitObjectExists(repoDir, 'HEAD~1')
    ? runGit(repoDir, ['rev-parse', 'HEAD~1']).trim()
    : runGit(repoDir, ['hash-object', '-t', 'tree', '/dev/null']).trim();
  return { baseRev, headRev };
}

function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): {
  repoDir: string;
  baseRev: string;
  headRev: string;
} {
  let repoDir = process.cwd();
  let baseRev: string | undefined;
  let headRev: string | undefined;
  let useGitHubActions = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--base' && next !== undefined) {
      baseRev = next;
      index++;
    } else if (arg === '--head' && next !== undefined) {
      headRev = next;
      index++;
    } else if (arg === '--repo' && next !== undefined) {
      repoDir = next;
      index++;
    } else if (arg === '--github-actions') {
      useGitHubActions = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (useGitHubActions) {
    return {
      repoDir,
      ...resolveGitHubActionsRevisions(repoDir, env),
    };
  }

  if (baseRev === undefined || headRev === undefined) {
    throw new Error(
      'Usage: node scripts/check-server-versions/src/check-server-versions.ts (--github-actions | --base <rev> --head <rev>) [--repo <dir>]',
    );
  }

  return { repoDir, baseRev, headRev };
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
    const args = parseCliArgs(process.argv.slice(2), process.env);
    const result = checkServerVersions(args);
    if (result.checkedPackages.length === 0) {
      console.log('Version check passed: no publishable MCP servers changed.');
    } else {
      console.log(
        `Version check passed for: ${result.checkedPackages.join(', ')}`,
      );
    }
  } catch (error: unknown) {
    console.error(
      'Version check failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
