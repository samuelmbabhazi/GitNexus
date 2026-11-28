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
import { listRegisteredRepos, readRegistryStrict } from '../../src/storage/repo-manager.js';

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

  it('reads a row whose remoteUrl is not a string instead of losing the registry', async () => {
    // The credential strip ran on any truthy value and threw on this one: the
    // strict read rejected the whole registry and the lenient one returned no row.
    const row = { name: 'demo', path: '/demo', storagePath: '/demo/.gitnexus', remoteUrl: 42 };
    await fs.writeFile(registry(), JSON.stringify([row]));

    expect(await readRegistryStrict()).toEqual([row]);
    expect(await listRegisteredRepos()).toEqual([row]);
  });

  it('lists a repository whatever its optional fields hold in the registry', async () => {
    // A row that validation keeps: an owned storage folder with an index.
    const repo = path.join(home, 'repo');
    const slot = path.join(repo, '.gitnexus');
    await fs.mkdir(slot, { recursive: true });
    await fs.writeFile(path.join(slot, 'lbug'), '');
    await fs.writeFile(
      path.join(slot, 'gitnexus.json'),
      JSON.stringify({ repoPath: repo, storagePath: slot }),
    );
    const row = {
      name: 'demo',
      path: repo,
      storagePath: slot,
      indexedAt: '2026-06-10T12:00:00.000Z',
      lastCommit: 'aaaaaaa1',
    };
    const texts = ['indexedAt', 'lastCommit', 'remoteUrl', 'branch'];
    const internal = ['shareOptOut', 'discovery', 'unknownField'];
    const values = [42, 0, true, false, null, '', 'text', {}, { length: 1 }, [], ['x'], [null]];
    const isText = (value: unknown) => typeof value === 'string';
    /** Whether `field` is absent from the printed row, or has the type the contract gives it. */
    const fits = (field: string, printed: Record<string, unknown>): boolean => {
      if (!(field in printed)) return true;
      const value = printed[field];
      if (texts.includes(field)) return isText(value);
      if (field === 'stats') {
        return (
          typeof value === 'object' &&
          value !== null &&
          Object.values(value).every((count) => typeof count === 'number')
        );
      }
      if (field === 'branches') {
        return (
          Array.isArray(value) &&
          value.every(
            (branch: Record<string, unknown>) =>
              isText(branch.branch) && isText(branch.indexedAt) && isText(branch.lastCommit),
          )
        );
      }
      return false;
    };

    // Every optional field takes every value in turn, through the real reader.
    const unexpected: string[] = [];
    for (const field of [...texts, 'stats', 'branches', ...internal]) {
      for (const value of values) {
        logSpy.mockClear();
        await fs.writeFile(registry(), JSON.stringify([{ ...row, [field]: value }]));
        await listCommand({ json: true });
        const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
          repositories?: Record<string, unknown>[];
        };
        const rows = printed.repositories ?? [];
        if (rows.length !== 1 || rows[0].name !== 'demo' || !fits(field, rows[0])) {
          unexpected.push(`${field} = ${JSON.stringify(value)}: ${JSON.stringify(printed)}`);
        }
      }
    }

    expect(unexpected).toEqual([]);
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('reports a registry path that is not a file', async () => {
    await fs.mkdir(registry());

    expect(await run()).toEqual({
      printed: [{ schemaVersion: 1, error: 'registry-unreadable', message: expect.any(String) }],
      exitCode: 1,
    });
  });
});
