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
 * The branch rows of an entry, or nothing. The registry reader checks the
 * fields that identify a repository and leaves `branches` as the file has it,
 * so a value that is not a list, or a row in it that names no branch, is left
 * out like an empty list.
 */
const toJsonBranches = (branches: unknown) => {
  if (!Array.isArray(branches)) return undefined;
  const rows = branches
    .filter(
      (row): row is NonNullable<RegistryEntry['branches']>[number] =>
        typeof row === 'object' && row !== null && typeof row.branch === 'string',
    )
    .map(({ branch, indexedAt, lastCommit }) => ({ branch, indexedAt, lastCommit }));
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
  indexedAt: entry.indexedAt,
  lastCommit: entry.lastCommit,
  remoteUrl: entry.remoteUrl,
  stats: entry.stats,
  branch: entry.branch,
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
