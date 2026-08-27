// Sidebar paths exist to answer "which checkout is this", not "what is the
// absolute location" — that stays in the tooltip. CSS truncation answers the
// wrong end of the string (`/home/mhera…`), so shorten by segment instead and
// keep the tail, which is the part that identifies the Worktree.
const HOME_PREFIXES = [/^\/home\/[^/]+/, /^\/Users\/[^/]+/, /^\/root(?=\/|$)/];
const WINDOWS_HOME = /^[A-Za-z]:\\Users\\[^\\]+/;

export function displayPath(path: string, maxSegments = 3): string {
  if (!path) return '';
  const windows = path.includes('\\') && !path.startsWith('/');
  const separator = windows ? '\\' : '/';
  let rest = path;
  let prefix = '';

  if (windows) {
    const match = WINDOWS_HOME.exec(path);
    if (match) {
      prefix = '~';
      rest = path.slice(match[0].length);
    }
  } else {
    for (const pattern of HOME_PREFIXES) {
      const match = pattern.exec(path);
      if (!match) continue;
      prefix = '~';
      rest = path.slice(match[0].length);
      break;
    }
  }

  const segments = rest.split(separator).filter((segment) => segment.length > 0);
  if (segments.length <= maxSegments) {
    const joined = segments.join(separator);
    if (prefix) return joined ? `${prefix}${separator}${joined}` : prefix;
    return windows ? path : `${separator}${joined}`;
  }

  const tail = segments.slice(-maxSegments).join(separator);
  const head = prefix || '';
  return `${head}${separator}\u2026${separator}${tail}`;
}
