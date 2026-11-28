/**
 * List Command
 *
 * Shows all indexed repositories from the global registry.
 */

import {
  listRegisteredRepos,
  readRegistryStrict,
  type RegistryEntry,
} from '../storage/repo-manager.js';
import { t } from './i18n/index.js';

export interface ListOptions {
  json?: boolean;
}

/**
 * A registry value under the type the JSON contract gives it, or nothing. The
 * registry reader checks the fields that identify a repository and leaves the
 * others as the file has them, so each one is checked here before it is
 * printed for a script.
 */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * The numeric counters of a `stats` object. Finite ones only: `1e400` parses
 * to `Infinity`, which JSON would print back as `null`.
 */
const counters = (value: unknown): Record<string, number> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter((pair): pair is [string, number] => Number.isFinite(pair[1])),
      )
    : undefined;

/**
 * The branch rows of an entry, or nothing. A row is kept when its three fields
 * are strings; a value that is not a list, or a list with no such row, is left
 * out like an empty list.
 */
const toJsonBranches = (branches: unknown) => {
  if (!Array.isArray(branches)) return undefined;
  const rows = branches.flatMap((row: unknown) => {
    if (typeof row !== 'object' || row === null) return [];
    const { branch, indexedAt, lastCommit } = row as Record<string, unknown>;
    return typeof branch === 'string' &&
      typeof indexedAt === 'string' &&
      typeof lastCommit === 'string'
      ? [{ branch, indexedAt, lastCommit }]
      : [];
  });
  return rows.length ? rows : undefined;
};

/**
 * One `list --json` row: the registry fields, under the names the MCP
 * `list_repos` tool gives them. It is not the whole `list_repos` row, which
 * also carries `staleness`, `siblings`, `contentRetention` and
 * `sourceAvailable`, computed per repository.
 */
const toJsonRow = (entry: RegistryEntry) => ({
  name: entry.name,
  path: entry.path,
  storagePath: entry.storagePath,
  indexedAt: text(entry.indexedAt),
  lastCommit: text(entry.lastCommit),
  remoteUrl: text(entry.remoteUrl),
  stats: counters(entry.stats),
  branch: text(entry.branch),
  branches: toJsonBranches(entry.branches),
});

export const listCommand = async (options: ListOptions = {}) => {
  let strictRows: RegistryEntry[] | undefined;
  if (options.json) {
    // A script acts on this list. A registry that cannot be read or parsed
    // must not reach it as an empty one, or every repository would look
    // removed. Only a registry file that is absent means nothing is indexed.
    try {
      strictRows = await readRegistryStrict();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ schemaVersion: 1, error: 'registry-unreadable', message }));
      process.exitCode = 1;
      return;
    }
  }

  // With `--json` the listing validates the rows of that strict read. Reading
  // the file again, leniently, could turn a registry that broke in between
  // into an empty list.
  const entries = await listRegisteredRepos({
    validate: true,
    ...(strictRows ? { entries: strictRows } : {}),
  });

  if (options.json) {
    // One line on stdout, so a script can parse it; no registry is an empty list.
    console.log(JSON.stringify({ schemaVersion: 1, repositories: entries.map(toJsonRow) }));
    return;
  }

  if (entries.length === 0) {
    console.log(t('common.notIndexed'));
    console.log(t('common.runAnalyze'));
    return;
  }

  console.log(`\n  ${t('list.title', { count: entries.length })}\n`);

  // Count occurrences of each name so colliding entries can be
  // disambiguated in the header (#829). Unique-name entries render
  // identically to pre-#829 output; only collisions gain a suffix.
  const nameCounts = new Map<string, number>();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  for (const entry of entries) {
    const indexedDate = new Date(entry.indexedAt).toLocaleString();
    const stats = entry.stats || {};
    const commitShort = entry.lastCommit?.slice(0, 7) || t('list.unknown');
    const hasCollision = (nameCounts.get(entry.name.toLowerCase()) ?? 0) > 1;
    const header = hasCollision ? `${entry.name}  (${entry.path})` : entry.name;

    console.log(`  ${header}`);
    console.log(`    ${t('common.path')}:    ${entry.path}`);
    console.log(`    ${t('list.indexed')}: ${indexedDate}`);
    console.log(`    ${t('list.commit')}:  ${commitShort}`);
    if (entry.branch) console.log(`    ${t('list.branch')}:  ${entry.branch}`);
    console.log(
      `    ${t('list.stats')}:   ${t('list.statsValue', {
        files: stats.files ?? 0,
        symbols: stats.nodes ?? 0,
        edges: stats.edges ?? 0,
      })}`,
    );
    if (stats.communities) console.log(`    ${t('list.clusters')}:   ${stats.communities}`);
    if (stats.processes) console.log(`    ${t('list.processes')}:  ${stats.processes}`);
    // Per-branch indexes (#2106). Only rendered when extra branches were
    // indexed for this path, so single-branch output is unchanged.
    if (entry.branches && entry.branches.length > 0) {
      console.log(`    ${t('list.branchIndexes')}:`);
      for (const b of entry.branches) {
        const bCommit = b.lastCommit?.slice(0, 7) || t('list.unknown');
        const bIndexed = new Date(b.indexedAt).toLocaleString();
        console.log(
          `      ${t('list.branchLine', { branch: b.branch, commit: bCommit, indexed: bIndexed })}`,
        );
      }
    }
    console.log('');
  }
};
