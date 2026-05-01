export function posixSingleQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPosixCommandLine(
  env: Record<string, string>,
  executable: string,
  args: string[]
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    parts.push(`${key}=${posixSingleQuote(value)}`);
  }
  parts.push(posixSingleQuote(executable));
  for (const arg of args) parts.push(posixSingleQuote(arg));
  return parts.join(' ');
}
