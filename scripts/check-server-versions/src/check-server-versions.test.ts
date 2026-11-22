import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkServerVersions,
  compareSemver,
  getTriggeredServerPackage,
  parseSemver,
} from './check-server-versions.ts';

function git(repoDir: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(repoDir: string, message: string): string {
  git(repoDir, ['add', '-A']);
  git(repoDir, [
    '-c',
    'user.name=Test Runner',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    message,
  ]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

async function writeJson(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function withTempRepo(
  run: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await mkdtemp(join(tmpdir(), 'mcp-version-check-'));
  try {
    git(repoDir, ['init', '-b', 'main']);
    await run(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

await describe('semver utilities', async () => {
  await it('parses valid semver strings and rejects invalid formats', () => {
    assert.deepEqual(parseSemver('1.2.3'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    assert.deepEqual(parseSemver('0.1.0-alpha.1+build.5'), {
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: ['alpha', 1],
    });
    assert.equal(parseSemver('v1.2.3'), undefined);
    assert.equal(parseSemver('01.2.3'), undefined);
    assert.equal(parseSemver('1.2'), undefined);
  });

  await it('orders release and prerelease versions per SemVer 2.0.0', () => {
    const order = [
      '0.1.0-alpha',
      '0.1.0-alpha.1',
      '0.1.0-beta.2',
      '0.1.0-beta.11',
      '0.1.0-rc.1',
      '0.1.0',
      '0.1.1',
      '0.2.0',
      '1.0.0',
    ];
    for (let index = 0; index < order.length - 1; index++) {
      const lower = parseSemver(order[index] ?? '');
      const higher = parseSemver(order[index + 1] ?? '');
      assert.ok(lower && higher);
      assert.ok(compareSemver(higher, lower) > 0);
      assert.ok(compareSemver(lower, higher) < 0);
      assert.equal(compareSemver(lower, lower), 0);
    }
  });
});

await describe('getTriggeredServerPackage', async () => {
  await it('triggers on publishable source/docs/manifest files and ignores src/**/*.test.ts', () => {
    assert.equal(
      getTriggeredServerPackage('servers/alpha-mcp/src/server.ts'),
      'alpha-mcp',
    );
    assert.equal(
      getTriggeredServerPackage('servers/alpha-mcp/README.md'),
      'alpha-mcp',
    );
    assert.equal(
      getTriggeredServerPackage('servers/alpha-mcp/src/server.test.ts'),
      undefined,
    );
    assert.equal(
      getTriggeredServerPackage('servers/alpha-mcp/src/tools/search.test.ts'),
      undefined,
    );
    assert.equal(
      getTriggeredServerPackage('packages/shared/index.ts'),
      undefined,
    );
  });
});

await describe('checkServerVersions against Git revisions', async () => {
  await it('fails when a publishable server source changes without a version bump', async () => {
    await withTempRepo(async (repoDir) => {
      await mkdir(join(repoDir, 'servers/alpha-mcp/src'), { recursive: true });
      await writeJson(join(repoDir, 'servers/alpha-mcp/package.json'), {
        name: '@soulike/alpha-mcp',
        version: '0.1.0',
      });
      await writeFile(
        join(repoDir, 'servers/alpha-mcp/src/server.ts'),
        'export const v = 1;\n',
      );
      const baseRev = commitAll(repoDir, 'init');

      await writeFile(
        join(repoDir, 'servers/alpha-mcp/src/server.ts'),
        'export const v = 2;\n',
      );
      const headRev = commitAll(repoDir, 'change source without bump');

      assert.throws(
        () => checkServerVersions({ repoDir, baseRev, headRev }),
        /servers\/alpha-mcp changed without bumping package\.json version/,
      );
    });
  });

  await it('rejects equal or downgraded versions and passes when bumped strictly', async () => {
    await withTempRepo(async (repoDir) => {
      await mkdir(join(repoDir, 'servers/alpha-mcp/src'), { recursive: true });
      await writeJson(join(repoDir, 'servers/alpha-mcp/package.json'), {
        name: '@soulike/alpha-mcp',
        version: '1.2.0',
      });
      await writeFile(
        join(repoDir, 'servers/alpha-mcp/src/server.ts'),
        'export const v = 1;\n',
      );
      const baseRev = commitAll(repoDir, 'init');

      await writeJson(join(repoDir, 'servers/alpha-mcp/package.json'), {
        name: '@soulike/alpha-mcp',
        version: '1.1.9',
      });
      await writeFile(
        join(repoDir, 'servers/alpha-mcp/src/server.ts'),
        'export const v = 2;\n',
      );
      const downgradeRev = commitAll(repoDir, 'downgrade version');

      assert.throws(
        () => checkServerVersions({ repoDir, baseRev, headRev: downgradeRev }),
        /baseline: 1\.2\.0, current: 1\.1\.9/,
      );

      await writeJson(join(repoDir, 'servers/alpha-mcp/package.json'), {
        name: '@soulike/alpha-mcp',
        version: '1.2.1',
      });
      const bumpedRev = commitAll(repoDir, 'bump patch');

      assert.deepEqual(
        checkServerVersions({ repoDir, baseRev, headRev: bumpedRev }),
        { checkedPackages: ['alpha-mcp'] },
      );
    });
  });

  await it('allows test-only edits, private packages, new packages with valid semver, and deleted packages', async () => {
    await withTempRepo(async (repoDir) => {
      await mkdir(join(repoDir, 'servers/alpha-mcp/src'), { recursive: true });
      await mkdir(join(repoDir, 'servers/private-mcp/src'), {
        recursive: true,
      });
      await mkdir(join(repoDir, 'servers/old-mcp/src'), { recursive: true });

      await writeJson(join(repoDir, 'servers/alpha-mcp/package.json'), {
        name: '@soulike/alpha-mcp',
        version: '0.1.0',
      });
      await writeFile(
        join(repoDir, 'servers/alpha-mcp/src/server.test.ts'),
        'export {};\n',
      );
      await writeJson(join(repoDir, 'servers/private-mcp/package.json'), {
        name: '@soulike/private-mcp',
        version: '0.0.0',
        private: true,
      });
      await writeFile(
        join(repoDir, 'servers/private-mcp/src/server.ts'),
        'export const p = 1;\n',
      );
      await writeJson(join(repoDir, 'servers/old-mcp/package.json'), {
        name: '@soulike/old-mcp',
        version: '0.1.0',
      });
      const baseRev = commitAll(repoDir, 'init');

      await writeFile(
        join(repoDir, 'servers/alpha-mcp/src/server.test.ts'),
        'export const updated = true;\n',
      );
      await writeFile(
        join(repoDir, 'servers/private-mcp/src/server.ts'),
        'export const p = 2;\n',
      );
      await rm(join(repoDir, 'servers/old-mcp'), {
        recursive: true,
        force: true,
      });
      await mkdir(join(repoDir, 'servers/new-mcp/src'), { recursive: true });
      await writeJson(join(repoDir, 'servers/new-mcp/package.json'), {
        name: '@soulike/new-mcp',
        version: '0.1.0',
      });
      const headRev = commitAll(repoDir, 'test-only, private, delete, and add');

      assert.deepEqual(checkServerVersions({ repoDir, baseRev, headRev }), {
        checkedPackages: ['new-mcp'],
      });
    });
  });

  await it('ignores unrelated target-branch advances when using merge-base comparison', async () => {
    await withTempRepo(async (repoDir) => {
      await mkdir(join(repoDir, 'servers/alpha-mcp/src'), { recursive: true });
      await mkdir(join(repoDir, 'servers/beta-mcp/src'), { recursive: true });

      await writeJson(join(repoDir, 'servers/alpha-mcp/package.json'), {
        name: '@soulike/alpha-mcp',
        version: '0.1.0',
      });
      await writeJson(join(repoDir, 'servers/beta-mcp/package.json'), {
        name: '@soulike/beta-mcp',
        version: '0.1.0',
      });
      commitAll(repoDir, 'init');

      git(repoDir, ['checkout', '-b', 'feat/alpha']);
      await writeJson(join(repoDir, 'servers/alpha-mcp/package.json'), {
        name: '@soulike/alpha-mcp',
        version: '0.1.1',
      });
      await writeFile(
        join(repoDir, 'servers/alpha-mcp/src/index.ts'),
        'export {};\n',
      );
      const prHead = commitAll(repoDir, 'bump alpha');

      git(repoDir, ['checkout', 'main']);
      await writeFile(
        join(repoDir, 'servers/beta-mcp/src/index.ts'),
        'export const beta = true;\n',
      );
      const movedMain = commitAll(repoDir, 'advance main on beta');

      const mergeBase = git(repoDir, ['merge-base', movedMain, prHead]);
      assert.deepEqual(
        checkServerVersions({ repoDir, baseRev: mergeBase, headRev: prHead }),
        { checkedPackages: ['alpha-mcp'] },
      );
    });
  });
});
