export interface UsageLimitInfo {
  message: string;
  resetAtLabel?: string;
}

const RESET_PATTERNS = [
  /\b(?:resets?|reset)\s+(?:at\s+)?([^.\n\r]+)/i,
  /\btry again (?:at|in)\s+([^.\n\r]+)/i
];

export function detectUsageLimit(input: unknown): UsageLimitInfo | null {
  const text = normalizeText(collectText(input).join('\n'));
  if (!text) return null;

  const lower = text.toLowerCase();
  if (lower.includes('not your usage limit')) return null;
  const isUsageLimit =
    lower.includes('usage_limit_exceeded')
    || lower.includes("you've hit your usage limit")
    || lower.includes('you have hit your usage limit')
    || lower.includes("you've hit your session limit")
    || lower.includes('you have hit your session limit')
    || lower.includes("you've hit your weekly limit")
    || lower.includes('you have hit your weekly limit')
    || lower.includes("you've hit your opus limit")
    || lower.includes('you have hit your opus limit')
    || lower.includes('credit balance is too low');
  if (!isUsageLimit) return null;

  const message = shortenMessage(extractRelevantLine(text) ?? text);
  const resetAtLabel = resetLabelFrom(text);
  return {
    message,
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
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRelevantLine(text: string): string | null {
  const parts = text
    .split(/(?<=\.)\s+|\n|\r/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.find((part) => detectUsageLimitLine(part)) ?? null;
}

function detectUsageLimitLine(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.includes('usage_limit_exceeded')
    || lower.includes('usage limit')
    || lower.includes('session limit')
    || lower.includes('weekly limit')
    || lower.includes('opus limit')
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
