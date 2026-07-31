import type { Session } from './types/sessions.js';

export function sessionAutoApprovesPermissions(
  session: Pick<Session, 'launch'>
): boolean {
  const launch = session.launch;
  if (launch.type !== 'agent') return false;
  const args = launch.extraArgs ?? [];

  if (launch.provider === 'codex') {
    return hasFlag(args, '--dangerously-bypass-approvals-and-sandbox')
      || hasOptionValue(args, ['--ask-for-approval', '-a'], 'never')
      || args.some((arg, index) =>
        isCodexAutomaticApprovalConfig(arg)
        || (
          (arg === '-c' || arg === '--config')
          && isCodexAutomaticApprovalConfig(args[index + 1] ?? '')
        )
      );
  }

  return hasFlag(args, '--dangerously-skip-permissions')
    || hasOptionValue(args, ['--permission-mode'], 'bypasspermissions');
}

function hasFlag(args: string[], flag: string): boolean {
  const target = flag.toLowerCase();
  return args.some((arg) => arg.trim().toLowerCase() === target);
}

function hasOptionValue(args: string[], flags: string[], expected: string): boolean {
  const normalizedFlags = flags.map((flag) => flag.toLowerCase());
  const normalizedExpected = expected.toLowerCase();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]?.trim().toLowerCase() ?? '';
    if (normalizedFlags.includes(arg)) {
      if (normalizeValue(args[index + 1]) === normalizedExpected) return true;
      continue;
    }
    for (const flag of normalizedFlags) {
      if (arg.startsWith(`${flag}=`) && normalizeValue(arg.slice(flag.length + 1)) === normalizedExpected) {
        return true;
      }
    }
  }
  return false;
}

function isCodexAutomaticApprovalConfig(arg: string): boolean {
  const normalized = normalizeValue(arg).replace(/["'\s]+/g, '');
  return normalized === 'approval_policy=never'
    || normalized === 'approvalpolicy=never'
    || normalized === 'approvals_reviewer=auto_review'
    || normalized === 'approvalsreviewer=auto_review';
}

function normalizeValue(value: string | undefined): string {
  return (value ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
}
