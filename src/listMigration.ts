import { ValueList } from './types';

export interface LegacyToolListsWithScanDir {
  toolId: string;
  toolScanDir?: string;
  lists: ValueList[];
}

/** A legacy list had to be renamed to avoid colliding with another list claimed in this same run. */
export interface ListMigrationRename {
  toolId: string;
  from: string;
  to: string;
}

export interface ListMigrationResult {
  lists: ValueList[];
  renames: ListMigrationRename[];
}

/**
 * Pure planning step for `extension.ts`'s one-time legacy-tool-list
 * migration (moving a tool's own `lists` into the workspace-global array).
 * Two distinct collision cases, deliberately handled differently:
 *
 * 1. A legacy list's name collides with an ALREADY-EXISTING global list
 *    (present before this migration ran -- either hand-created, or
 *    migrated by an earlier run). The existing global always wins and the
 *    legacy list is dropped, unrenamed: the owning tool's own
 *    `ToolOption.valueListName` already spells that same name, so it keeps
 *    resolving correctly with no rewrite needed. Never clobber a global a
 *    user may have since hand-refined.
 * 2. Two legacy tools being migrated in the SAME run collide with each
 *    other (neither is a pre-existing global). Silently letting one win
 *    (as a plain `Map.set` would) means the loser's option silently starts
 *    offering the winner's values -- so instead the second one is renamed
 *    to a fresh unique name, recorded in `renames` so the caller can
 *    rewrite that tool's `ToolOption.valueListName` occurrences and the
 *    `optionListOverrides` of every job using that tool.
 *
 * `list.scanDir` is inherited from `toolScanDir` when the list doesn't
 * already have its own (mirrors the single-tool case already handled
 * directly in `extension.ts`'s `migrateLegacyToolLists`).
 */
export function planListMigration(
  existingGlobals: ValueList[],
  legacy: LegacyToolListsWithScanDir[]
): ListMigrationResult {
  const merged = new Map<string, ValueList>();
  for (const g of existingGlobals) {
    merged.set(g.name, g);
  }
  // Names claimed by a legacy list DURING this run -- only these are
  // eligible to force a rename on a later collision; a pre-existing global
  // collision drops the legacy list instead (case 1 above).
  const claimedThisRun = new Set<string>();
  const renames: ListMigrationRename[] = [];

  for (const { toolId, toolScanDir, lists } of legacy) {
    for (const list of lists) {
      const withScanDir: ValueList = list.scanDir
        ? list
        : toolScanDir
          ? { ...list, scanDir: toolScanDir }
          : list;

      if (!merged.has(withScanDir.name)) {
        merged.set(withScanDir.name, withScanDir);
        claimedThisRun.add(withScanDir.name);
        continue;
      }

      if (!claimedThisRun.has(withScanDir.name)) {
        // Case 1: collides with a pre-existing global -- that global wins.
        continue;
      }

      // Case 2: collides with another legacy list claimed earlier in this
      // same run -- rename this (later) one to a fresh unique name.
      const newName = uniqueName(withScanDir.name, merged);
      const renamed: ValueList = { ...withScanDir, name: newName };
      merged.set(newName, renamed);
      claimedThisRun.add(newName);
      renames.push({ toolId, from: withScanDir.name, to: newName });
    }
  }

  return { lists: [...merged.values()], renames };
}

function uniqueName(base: string, taken: Map<string, ValueList>): string {
  let n = 2;
  let candidate = `${base} (${n})`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${base} (${n})`;
  }
  return candidate;
}
