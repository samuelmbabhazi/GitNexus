/**
 * `gitnexus list --json` against a real registry file (#1533).
 *
 * `list-status-branch.test.ts` mocks the registry module, so it cannot show
 * what the command prints for a file that is absent, empty or damaged. Here
 * the module is the real one and `GITNEXUS_HOME` is a temporary folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCommand } from '../../src/cli/list.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

describe('list --json and the registry file', () => {
  let home: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitCodeBefore: typeof process.exitCode;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-list-json-'));
    vi.stubEnv('GITNEXUS_HOME', home);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitCodeBefore = process.exitCode;
  });

  afterEach(async () => {
    process.exitCode = exitCodeBefore;
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  });

  const registry = (): string => path.join(home, 'registry.json');
  const run = async () => {
    await listCommand({ json: true });
    return {
      printed: logSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as unknown),
      exitCode: process.exitCode,
    };
  };

  it.each([
    { label: 'no registry file', contents: undefined },
    { label: 'a registry with no row', contents: '[]' },
  ])('prints an empty list for $label', async ({ contents }) => {
    if (contents !== undefined) await fs.writeFile(registry(), contents);

    expect(await run()).toEqual({
      printed: [{ schemaVersion: 1, repositories: [] }],
      exitCode: exitCodeBefore,
    });
  });

  it.each([
    {
      label: 'a file cut short',
      contents: '[{"name": "demo", "path": "/de',
      reason: 'not valid JSON',
    },
    {
      label: 'an object in place of the list',
      contents: '{"demo": {}}',
      reason: 'not a JSON array',
    },
    {
      label: 'a row without a name',
      contents: '[{"path": "/demo", "storagePath": "/demo/.gitnexus"}]',
      reason: 'does not identify a repo',
    },
  ])('reports $label as an unreadable registry', async ({ contents, reason }) => {
    await fs.writeFile(registry(), contents);

    expect(await run()).toEqual({
      printed: [
        {
          schemaVersion: 1,
          error: 'registry-unreadable',
          message: expect.stringContaining(reason),
        },
      ],
      exitCode: 1,
    });
  });

  it('lists the rows it is given without reading the registry again', async () => {
    // The file breaks after the caller's strict read: a second, lenient read
    // returns no row.
    const row = {
      name: 'demo',
      path: '/demo',
      storagePath: '/demo/.gitnexus',
      indexedAt: '2026-06-10T12:00:00.000Z',
      lastCommit: 'aaaaaaa1',
    };
    await fs.writeFile(registry(), '[{"name": "demo", "path": "/de');

    expect(await listRegisteredRepos({ entries: [row] })).toEqual([row]);
    expect(await listRegisteredRepos()).toEqual([]);
  });

  it('reports a registry path that is not a file', async () => {
    await fs.mkdir(registry());

    expect(await run()).toEqual({
      printed: [{ schemaVersion: 1, error: 'registry-unreadable', message: expect.any(String) }],
      exitCode: 1,
    });
  });
});
