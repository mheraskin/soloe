export interface UsageLimitInfo {
  message: string;
  resetAtLabel?: string;
  detectorVersion: number;
}

export const USAGE_LIMIT_DETECTOR_VERSION = 2;

const RESET_PATTERNS = [
  /\b(?:resets?|reset)\s+(?:at\s+)?([^.\n\r]+)/i,
  /\btry again (?:at|in)\s+([^.\n\r]+)/i
];

export function detectUsageLimit(input: unknown): UsageLimitInfo | null {
  const text = normalizeText(collectText(input).join('\n'));
  if (!text) return null;

  const lower = text.toLowerCase();
  if (lower.includes('not your usage limit')) return null;
  const relevantLine = extractRelevantLine(text);
  const hardLimitPhrase = relevantLine !== null;
  const isQuotaStatus = /\b\d{1,3}%\s+left\b/.test(lower);
  const isUsageLimit = hardLimitPhrase || lower.includes('credit balance is too low');
  if (!isUsageLimit || (isQuotaStatus && !hardLimitPhrase)) return null;

  const message = shortenMessage(relevantLine ?? usefulFallbackMessage(text));
  const resetAtLabel = resetLabelFrom(relevantLine ?? text);
  return {
    message,
    detectorVersion: USAGE_LIMIT_DETECTOR_VERSION,
    ...(resetAtLabel ? { resetAtLabel } : {})
  };
}

export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

function collectText(input: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof input === 'string') return [input];
  if (typeof input === 'number' || typeof input === 'boolean') return [String(input)];
  if (Array.isArray(input)) return input.flatMap((item) => collectText(item, depth + 1));
  if (!input || typeof input !== 'object') return [];
  return Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
    if (typeof value === 'string' && /error|message|limit|reason|status|detail/i.test(key)) {
      return [value];
    }
    return collectText(value, depth + 1);
  });
}

function normalizeText(input: string): string {
  return stripAnsi(input)
    .replace(/[•·]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .trim();
}

function extractRelevantLine(text: string): string | null {
  const parts = text
    .split(/\n|\r/)
    .map((part) => part.trim())
    .filter(Boolean);
  const match = parts.find((part) => detectUsageLimitLine(part));
  return match ? cleanRelevantLine(match) : null;
}

function cleanRelevantLine(line: string): string {
  const lower = line.toLowerCase();
  const starts = [
    'usage_limit_exceeded',
    'rate_limit_exceeded',
    'api error:',
    'error:',
    'failed:',
    'blocked:',
    "you've hit",
    'you have hit',
    'limit reached',
    'credit balance is too low'
  ]
    .map((needle) => lower.indexOf(needle))
    .filter((index) => index >= 0);
  if (starts.length === 0) return line;
  return line.slice(Math.min(...starts)).trim();
}

function usefulFallbackMessage(text: string): string {
  const reset = resetLabelFrom(text);
  if (reset) return `Usage limit reached. Resets ${reset}`;
  return 'Usage limit reached';
}

function detectUsageLimitLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  if (!lower || lower.includes('`')) return false;
  return /\b(?:usage_limit_exceeded|rate_limit_exceeded)\b/.test(lower)
    || /^(?:error|api error|failed|blocked):?\s*(?:usage|rate)\s+limit\s+(?:reached|exceeded)\b(?!\/)/.test(lower)
    || /^you(?:'ve| have)\s+hit\s+(?:your\s+)?(?:usage|session|weekly|opus)\s+limit\b/.test(lower)
    || /^(?:5-hour|5h|session|weekly|opus)\s+limit\s+(?:reached|exceeded)\b(?!\/)/.test(lower)
    || lower.includes('credit balance is too low');
}

function resetLabelFrom(message: string): string | undefined {
  for (const pattern of RESET_PATTERNS) {
    const match = pattern.exec(message);
    const label = match?.[1]?.trim();
    if (label) return label.replace(/\s+$/, '');
  }
  return undefined;
}

function shortenMessage(message: string): string {
  const normalized = message.trim().replace(/\s+/g, ' ');
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
