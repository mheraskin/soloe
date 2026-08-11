/**
 * Incrementally extracts current-directory reports emitted by common shell
 * integrations. PTY output can split an OSC sequence across arbitrary chunks,
 * so callers keep one parser for the lifetime of a Terminal.
 */
export class TerminalLocationParser {
  private buffer = '';

  constructor(private readonly windowsPaths: boolean) {}

  push(data: string): string[] {
    if (!this.buffer && !data.includes('\x1b]')) {
      this.buffer = data.endsWith('\x1b') ? '\x1b' : '';
      return [];
    }

    const text = this.buffer + data;
    const locations: string[] = [];
    const regex = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      const cwd = cwdFromOsc(match[1] ?? '', this.windowsPaths);
      if (cwd) locations.push(cwd);
    }

    const lastStart = text.lastIndexOf('\x1b]');
    if (lastStart >= 0 && !hasOscTerminator(text, lastStart)) {
      this.buffer = text.slice(lastStart, lastStart + 4096);
    } else {
      this.buffer = text.endsWith('\x1b') ? '\x1b' : '';
    }
    return locations;
  }
}

function hasOscTerminator(text: string, start: number): boolean {
  const bel = text.indexOf('\x07', start);
  const st = text.indexOf('\x1b\\', start);
  return bel >= 0 || st >= 0;
}

function cwdFromOsc(payload: string, windowsPaths: boolean): string | null {
  if (payload.startsWith('7;')) {
    return cwdFromLocationValue(payload.slice(2), windowsPaths);
  }
  if (payload.startsWith('633;P;')) {
    const cwd = propertyValue(payload.slice('633;P;'.length), 'Cwd');
    return cwd ? cwdFromLocationValue(unescapeIntegrationValue(cwd), windowsPaths) : null;
  }
  if (payload.startsWith('1337;CurrentDir=')) {
    return cwdFromLocationValue(
      unescapeIntegrationValue(payload.slice('1337;CurrentDir='.length)),
      windowsPaths
    );
  }
  return null;
}

function cwdFromLocationValue(payload: string, windowsPaths: boolean): string | null {
  if (!payload.startsWith('file://')) return normalizeOscPath(payload, windowsPaths);
  try {
    const url = new URL(payload);
    if (url.protocol !== 'file:') return null;
    return normalizeOscPath(decodeURIComponent(url.pathname), windowsPaths);
  } catch {
    return null;
  }
}

function propertyValue(payload: string, name: string): string | null {
  const prefix = `${name}=`;
  if (payload.startsWith(prefix)) return payload.slice(prefix.length);
  const marker = `;${prefix}`;
  const index = payload.indexOf(marker);
  return index < 0 ? null : payload.slice(index + marker.length);
}

function unescapeIntegrationValue(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function normalizeOscPath(pathname: string, windowsPaths: boolean): string | null {
  if (!pathname) return null;
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\');
  }
  if (windowsPaths && /^[A-Za-z]:\//.test(pathname)) {
    return pathname.replace(/\//g, '\\');
  }
  if (windowsPaths && pathname.startsWith('//')) {
    return pathname.replace(/\//g, '\\');
  }
  return pathname;
}
