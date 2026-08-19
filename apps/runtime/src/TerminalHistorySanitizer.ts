function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === 'n') return true;
  if (finalByte === 'R' && /^[0-9;?]*$/.test(body)) return true;
  if (finalByte === 'c' && /^[>0-9;?]*$/.test(body)) return true;
  if ((finalByte === 'p' || finalByte === 'y') && /^[0-9;?]*\$$/.test(body)) return true;
  if (finalByte === 'q' && /^>[0-9;]*$/.test(body)) return true;
  if (finalByte === 'u' && body.startsWith('?')) return true;
  return false;
}

function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith('\u001b\\')) return value.slice(0, -2);
  const lastCharacter = value.at(-1);
  return lastCharacter === '\u0007' || lastCharacter === '\u009c'
    ? value.slice(0, -1)
    : value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) return index + 1;
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) cursor += 1;
  if (cursor >= input.length) return null;
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

/**
 * Removes terminal request/reply traffic from retained history while preserving
 * every visual VT sequence. Replaying a query would otherwise make a terminal
 * answer it again and leak the answer into the running shell.
 */
export function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = '';
  let index = 0;

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length && !isCsiFinalByte(input.charCodeAt(cursor))) cursor += 1;
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const body = input.slice(index + 2, cursor);
        if (!shouldStripCsiSequence(body, input[cursor] ?? '')) {
          visibleText += input.slice(index, cursor + 1);
        }
        index = cursor + 1;
        continue;
      }

      if ([0x5d, 0x50, 0x5e, 0x5f].includes(nextCodePoint)) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content))
          || (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) visibleText += sequence;
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      visibleText += input.slice(index, escapeSequenceEndIndex);
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length && !isCsiFinalByte(input.charCodeAt(cursor))) cursor += 1;
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const body = input.slice(index + 1, cursor);
      if (!shouldStripCsiSequence(body, input[cursor] ?? '')) {
        visibleText += input.slice(index, cursor + 1);
      }
      index = cursor + 1;
      continue;
    }

    if ([0x9d, 0x90, 0x9e, 0x9f].includes(codePoint)) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content))
        || (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) visibleText += sequence;
      index = terminatorIndex;
      continue;
    }

    visibleText += input[index] ?? '';
    index += 1;
  }

  return { visibleText, pendingControlSequence: '' };
}
