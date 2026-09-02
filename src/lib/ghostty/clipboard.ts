const OSC_52_PREFIXES = ['\u001b]52;', '\u009d52;'] as const;
const MAX_ENCODED_CLIPBOARD_BYTES = 1_400_000;

export class TerminalClipboardSequenceParser {
  private pending = '';
  private readonly decoder = new TextDecoder();

  push(data: string | Uint8Array): string[] {
    const chunk = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    const input = this.pending + chunk;
    const clipboardWrites: string[] = [];
    this.pending = '';
    let cursor = 0;

    while (cursor < input.length) {
      const sequence = nextSequence(input, cursor);
      if (!sequence) {
        this.pending = partialPrefixAtEnd(input.slice(cursor));
        break;
      }
      const terminator = findTerminator(input, sequence.contentStart);
      if (!terminator) {
        const incomplete = input.slice(sequence.start);
        if (incomplete.length <= MAX_ENCODED_CLIPBOARD_BYTES) this.pending = incomplete;
        break;
      }
      const content = input.slice(sequence.contentStart, terminator.start);
      const separator = content.indexOf(';');
      if (separator >= 0) {
        const decoded = decodeClipboardPayload(content.slice(separator + 1));
        if (decoded !== null) clipboardWrites.push(decoded);
      }
      cursor = terminator.end;
    }

    return clipboardWrites;
  }

  reset(): void {
    this.pending = '';
    this.decoder.decode();
  }
}

function nextSequence(
  input: string,
  from: number,
): { readonly start: number; readonly contentStart: number } | null {
  let match: { readonly start: number; readonly contentStart: number } | null = null;
  for (const prefix of OSC_52_PREFIXES) {
    const start = input.indexOf(prefix, from);
    if (start < 0 || (match !== null && start >= match.start)) continue;
    match = { start, contentStart: start + prefix.length };
  }
  return match;
}

function findTerminator(
  input: string,
  from: number,
): { readonly start: number; readonly end: number } | null {
  for (let index = from; index < input.length; index += 1) {
    const character = input[index];
    if (character === '\u0007' || character === '\u009c') {
      return { start: index, end: index + 1 };
    }
    if (character === '\u001b') {
      if (input[index + 1] === '\u001b' && input[index + 2] === '\\') {
        return { start: index, end: index + 3 };
      }
      if (input[index + 1] === '\\') return { start: index, end: index + 2 };
    }
  }
  return null;
}

function partialPrefixAtEnd(input: string): string {
  for (let length = Math.min(input.length, OSC_52_PREFIXES[0].length - 1); length > 0; length -= 1) {
    const suffix = input.slice(-length);
    if (OSC_52_PREFIXES.some((prefix) => prefix.startsWith(suffix))) return suffix;
  }
  return '';
}

function decodeClipboardPayload(payload: string): string | null {
  if (
    payload === '?'
    || payload.length > MAX_ENCODED_CLIPBOARD_BYTES
    || !/^[a-zA-Z0-9+/]*={0,2}$/.test(payload)
    || payload.length % 4 === 1
  ) {
    return null;
  }
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
