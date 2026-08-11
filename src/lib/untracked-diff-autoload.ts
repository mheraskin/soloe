import type { WorkingChange } from '@shared/types/git.js';

/**
 * Dependency, cache, and generated-output directories whose untracked files
 * stay manual-load only. Match is case-insensitive and applies to any path
 * segment, so the policy works in monorepos as well as repository roots.
 */
export const UNTRACKED_DIFF_AUTOLOAD_EXCLUDED_DIRECTORIES = [
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  '.pnpm-store',
  '.yarn',
  '.npm',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vite',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  'coverage',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  'pods',
  'deriveddata'
] as const;

/** Generated text formats that are rarely useful as an automatic review. */
export const UNTRACKED_DIFF_AUTOLOAD_EXCLUDED_SUFFIXES = [
  '.map',
  '.tsbuildinfo',
  '.min.js',
  '.min.css',
  '.log',
  '.lcov'
] as const;

export const UNTRACKED_DIFF_AUTOLOAD_MAX_LINES = 4_000;
export const UNTRACKED_DIFF_AUTOLOAD_CONCURRENCY = 2;

const excludedDirectories = new Set<string>(UNTRACKED_DIFF_AUTOLOAD_EXCLUDED_DIRECTORIES);

export function shouldAutoLoadUntrackedDiff(change: WorkingChange): boolean {
  if (change.kind !== 'untracked' || change.binary) return false;
  if (change.insertions > UNTRACKED_DIFF_AUTOLOAD_MAX_LINES) return false;

  const normalized = change.path.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => excludedDirectories.has(segment))) return false;
  return !UNTRACKED_DIFF_AUTOLOAD_EXCLUDED_SUFFIXES.some((suffix) =>
    normalized.endsWith(suffix)
  );
}
