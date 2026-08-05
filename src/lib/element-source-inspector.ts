export const ELEMENT_SOURCE_INSPECTOR_SHORTCUT = ['Ctrl', 'Alt', 'Shift', 'S'] as const;
export const ELEMENT_SOURCE_INSPECTOR_VIEWER_GRACE = 500;

export interface ElementSourceFrame {
  filePath: string;
  lineNumber: number | null;
  columnNumber: number | null;
  componentName: string | null;
}

export interface ElementSourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ElementSourcePayload {
  kind: 'hover' | 'leave' | 'select';
  tagName?: string;
  componentName?: string | null;
  source?: ElementSourceFrame | null;
  stack?: ElementSourceFrame[];
  rect?: ElementSourceRect | null;
  label?: string | null;
  pageUrl?: string;
}

export interface HostRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InspectorBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface InspectorPosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ResolvedSourcePath {
  filePath: string;
  worktreeRoot: string;
}

export interface ResolvedSourceFrame {
  frame: ElementSourceFrame;
  worktreeRoot: string;
}

export function resolveSourcePath(
  filePath: string | null | undefined,
  projectRoot: string,
  worktreeRoots: readonly string[] = []
): ResolvedSourcePath | null {
  if (!filePath || !projectRoot) return null;
  const raw = filePath.trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!raw || raw.includes('\0') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) return null;

  const root = normalizeAbsoluteRoot(projectRoot);
  const knownRootByNormalized = new Map<string, string>();
  for (const candidate of [projectRoot, ...worktreeRoots]) {
    const normalized = normalizeAbsoluteRoot(candidate);
    if (normalized && !knownRootByNormalized.has(normalized)) {
      knownRootByNormalized.set(normalized, candidate.trim());
    }
  }
  const knownRoots = Array.from(knownRootByNormalized)
    .sort(([a], [b]) => b.length - a.length);
  let relative = raw;
  let worktreeRoot = projectRoot.trim();
  if (isAbsolutePath(raw)) {
    if (!root) return null;
    const absolute = normalizeAbsoluteRoot(raw);
    const matchedRoot = knownRoots.find(
      ([candidate]) => pathEqualsOrContains(absolute, candidate)
    );
    if (matchedRoot) {
      worktreeRoot = matchedRoot[1];
      relative = absolute.slice(matchedRoot[0].length).replace(/^\/+/, '');
    } else if (absolute.startsWith('/workspace/') && !root.startsWith('/workspace/')) {
      relative = absolute.slice('/workspace/'.length);
    } else {
      return null;
    }
  }

  const parts = relative.split('/');
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) return null;
  if (parts.some((part) => part.includes('\0'))) return null;
  return { filePath: parts.join('/'), worktreeRoot };
}

export function normalizeSourcePath(
  filePath: string | null | undefined,
  projectRoot: string,
  worktreeRoots: readonly string[] = []
): string | null {
  return resolveSourcePath(filePath, projectRoot, worktreeRoots)?.filePath ?? null;
}

export function normalizeSourceFrame(
  frame: ElementSourceFrame | null | undefined,
  projectRoot: string,
  worktreeRoots: readonly string[] = []
): ElementSourceFrame | null {
  return resolveSourceFrame(frame, projectRoot, worktreeRoots)?.frame ?? null;
}

export function resolveSourceFrame(
  frame: ElementSourceFrame | null | undefined,
  projectRoot: string,
  worktreeRoots: readonly string[] = []
): ResolvedSourceFrame | null {
  if (!frame) return null;
  const resolution = resolveSourcePath(frame.filePath, projectRoot, worktreeRoots);
  if (!resolution) return null;
  return {
    frame: {
      filePath: resolution.filePath,
      lineNumber: finitePositiveInteger(frame.lineNumber),
      columnNumber: finitePositiveInteger(frame.columnNumber),
      componentName: cleanLabel(frame.componentName)
    },
    worktreeRoot: resolution.worktreeRoot
  };
}

export function formatSourceLocation(frame: ElementSourceFrame | null | undefined): string {
  if (!frame) return 'Source unavailable';
  const line = frame.lineNumber ? `:${frame.lineNumber}` : '';
  return `${frame.filePath}${line}`;
}

export function formatElementLabel(payload: Pick<ElementSourcePayload, 'componentName' | 'tagName'>): string {
  return cleanLabel(payload.componentName) ?? payload.tagName?.toLowerCase() ?? 'Element';
}

export function mapGuestRectToHost(rect: ElementSourceRect, webview: HostRect): HostRect | null {
  if (
    !Number.isFinite(rect.x) || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
    || rect.viewportWidth <= 0 || rect.viewportHeight <= 0
    || webview.width <= 0 || webview.height <= 0
  ) return null;
  const scaleX = webview.width / rect.viewportWidth;
  const scaleY = webview.height / rect.viewportHeight;
  return {
    left: webview.left + rect.x * scaleX,
    top: webview.top + rect.y * scaleY,
    width: Math.max(0, rect.width * scaleX),
    height: Math.max(0, rect.height * scaleY)
  };
}

export function placeInspectorViewer(
  target: HostRect | null,
  panel: InspectorBounds,
  width = 430,
  height = 340,
  gap = 12
): InspectorPosition {
  const panelWidth = Math.max(1, panel.right - panel.left);
  const panelHeight = Math.max(1, panel.bottom - panel.top);
  const viewerWidth = Math.min(width, Math.max(220, panelWidth - 16));
  const viewerHeight = Math.min(height, Math.max(180, panelHeight - 16));
  const candidates = target
    ? [
        { left: target.left + target.width + gap, top: target.top },
        { left: target.left - viewerWidth - gap, top: target.top },
        { left: target.left, top: target.top + target.height + gap },
        { left: target.left, top: target.top - viewerHeight - gap }
      ]
    : [{ left: panel.right - viewerWidth - 16, top: panel.top + 16 }];

  const fits = candidates.find((candidate) =>
    candidate.left >= panel.left + 8
    && candidate.top >= panel.top + 8
    && candidate.left + viewerWidth <= panel.right - 8
    && candidate.top + viewerHeight <= panel.bottom - 8
  );
  const chosen = fits ?? candidates[0]!;
  return {
    left: clamp(chosen.left, panel.left + 8, Math.max(panel.left + 8, panel.right - viewerWidth - 8)),
    top: clamp(chosen.top, panel.top + 8, Math.max(panel.top + 8, panel.bottom - viewerHeight - 8)),
    width: viewerWidth,
    height: viewerHeight
  };
}

export function shortcutSignature(keys: readonly string[]): string {
  return keys.map((key) => key.trim().toLowerCase()).filter(Boolean).join('+');
}

export function shortcutLabel(keys: readonly string[]): string {
  return keys.map((key) => key === 'Ctrl' ? 'Ctrl/Cmd' : key).join(' + ');
}

function normalizeAbsoluteRoot(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/, '').replace(/\/\.\//g, '/');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

function pathEqualsOrContains(absolutePath: string, root: string): boolean {
  const caseInsensitive = /^[A-Za-z]:\//.test(root);
  const candidate = caseInsensitive ? absolutePath.toLowerCase() : absolutePath;
  const normalizedRoot = caseInsensitive ? root.toLowerCase() : root;
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function finitePositiveInteger(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) >= 1 ? Math.floor(Number(value)) : null;
}

function cleanLabel(value: string | null | undefined): string | null {
  const label = typeof value === 'string' ? value.trim() : '';
  return label ? label.slice(0, 120) : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
