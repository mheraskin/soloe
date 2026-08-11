import { describe, expect, it } from 'vitest';
import { AgentObserverManager } from './AgentObserverManager.js';
import {
  AgentRuntimeManager,
  normalizeSdkEvent,
  stateFromSdkType,
  type WorkerSdkAdapter
} from './AgentRuntimeManager.js';

describe('SDK event normalization', () => {
  it('maps provider event names into normalized states', () => {
    expect(stateFromSdkType('tool_use')).toBe('running_tool');
    expect(stateFromSdkType('approval_required')).toBe('waiting_for_approval');
    expect(stateFromSdkType('completed')).toBe('completed');
    expect(stateFromSdkType('error')).toBe('failed');
  });

  it('extracts summaries and provider ids from SDK-like events', () => {
    expect(normalizeSdkEvent({
      type: 'tool_use',
      message: 'running tests',
      sessionId: 'sdk-session-1'
    })).toMatchObject({
      state: 'running_tool',
      summary: 'running tests',
      providerThreadId: 'sdk-session-1'
    });
  });
});

describe('AgentRuntimeManager', () => {
  it('streams adapter events into the observer and completes workers', async () => {
    const observer = new AgentObserverManager();
    const adapter: WorkerSdkAdapter = {
      async run(_prompt, ctx) {
        ctx.emit({ state: 'running_tool', summary: 'running tests', providerThreadId: 'thread-1' });
        return { resultSummary: 'tests passed', providerThreadId: 'thread-1' };
      }
    };
    const runtime = new AgentRuntimeManager({
      observer,
      sdkLoader: async () => adapter
    });

    const created = runtime.createWorkerSession({
      originSessionId: 'main',
      provider: 'codex',
      promptSummary: 'check tests'
    });
    await runtime.sendWorkerPrompt({ workerId: created.workerId, prompt: 'run tests' });
    await eventually(() => {
      expect(runtime.getWorkerStatus(created.workerId).snapshot?.state).toBe('completed');
    });

    const snapshot = runtime.getWorkerStatus(created.workerId).snapshot;
    expect(snapshot?.resultSummary).toBe('tests passed');
    expect(snapshot?.providerThreadId).toBe('thread-1');
    expect(observer.listEvents(created.workerId).some((e) => e.summary === 'running tests')).toBe(true);
  });

  it('marks workers failed when the adapter fails', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({
      observer,
      sdkLoader: async () => ({
        async run() {
          throw new Error('sdk missing capability');
        }
      })
    });

    const created = runtime.createWorkerSession({
      originSessionId: 'main',
      provider: 'claude_code'
    });
    await runtime.sendWorkerPrompt({ workerId: created.workerId, prompt: 'do work' });
    await eventually(() => {
      expect(runtime.getWorkerStatus(created.workerId).snapshot?.state).toBe('failed');
    });
    expect(runtime.getWorkerStatus(created.workerId).snapshot?.error).toContain('sdk missing capability');
  });

  it('propagates the parent effective approval mode to worker events', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({
      observer,
      autoApprovesPermissions: () => true,
      sdkLoader: async () => ({
        async run(_prompt, ctx) {
          ctx.emit({ state: 'waiting_for_approval', summary: 'approval required' });
          return { resultSummary: 'worker completed' };
        }
      })
    });

    const created = runtime.createWorkerSession({
      originSessionId: 'main',
      provider: 'codex'
    });
    await runtime.sendWorkerPrompt({ workerId: created.workerId, prompt: 'do work' });
    await eventually(() => {
      expect(runtime.getWorkerStatus(created.workerId).snapshot?.state).toBe('completed');
    });

    expect(runtime.getWorkerStatus(created.workerId).snapshot?.autoApprovesPermissions).toBe(true);
    expect(observer.listEvents(created.workerId).find((event) => event.state === 'waiting_for_approval'))
      .toMatchObject({ autoApprovesPermissions: true });
  });
});

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
