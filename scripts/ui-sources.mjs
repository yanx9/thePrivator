/**
 * Shared UI source discovery for the verifier source guardrails.
 *
 * The guardrails used to read `src/App.tsx` directly. That was both fragile and
 * weaker than intended: a negative assertion like "the UI must not import
 * @tauri-apps/plugin-fs" only ever inspected one file, so the same import in any
 * other component would have passed unnoticed. It also meant that splitting
 * App.tsx into components would fail every positive assertion -- not because a
 * rule was broken, but because the string moved to a sibling file.
 *
 * Scanning the whole UI tree fixes both. Negative rules apply per file so the
 * failure names the offender; positive rules ("the UI must call this typed
 * wrapper") apply to the union, since it does not matter which module holds them.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Test files legitimately contain raw command names, mocks, and unsafe sentinels. */
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

/**
 * Files exempt from the negative rules, by repo-relative POSIX path.
 *
 * `src/sidecar/client.ts` is the single module allowed to call `invoke` -- that
 * chokepoint is the reason the rest of the UI can be checked mechanically.
 */
export const UI_SOURCE_NEGATIVE_RULE_EXEMPTIONS = new Set(["src/sidecar/client.ts"]);

function walk(directory, results) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(absolutePath, results);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    results.push(absolutePath);
  }
  return results;
}

/**
 * Read every non-test UI source under `src/`.
 *
 * @param {string} rootDir repository root
 * @param {{ includeTests?: boolean, subdirectory?: string }} [options]
 * @returns {{ files: Array<{ path: string, text: string }>, combined: string, count: number }}
 *   `files` carries repo-relative POSIX paths for per-file negative rules;
 *   `combined` is their concatenation for positive "somewhere in the UI" rules.
 */
export function readUiSources(rootDir, { includeTests = false, subdirectory = "src" } = {}) {
  const base = join(rootDir, subdirectory);
  if (!statSyncSafe(base)?.isDirectory()) {
    return { files: [], combined: "", count: 0 };
  }

  const files = [];
  for (const absolutePath of walk(base, [])) {
    const relativePath = relative(rootDir, absolutePath).split(sep).join("/");
    if (!includeTests && TEST_FILE_PATTERN.test(relativePath)) continue;
    files.push({ path: relativePath, text: readFileSync(absolutePath, "utf8") });
  }

  return {
    files,
    combined: files.map((file) => file.text).join("\n"),
    count: files.length,
  };
}

/** Files subject to the negative rules: everything except the declared exemptions. */
export function readGuardedUiSources(rootDir, options = {}) {
  const { files, count } = readUiSources(rootDir, options);
  const guarded = files.filter((file) => !UI_SOURCE_NEGATIVE_RULE_EXEMPTIONS.has(file.path));
  return { files: guarded, combined: guarded.map((file) => file.text).join("\n"), count };
}

function statSyncSafe(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}
