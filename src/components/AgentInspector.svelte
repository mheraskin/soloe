<script lang="ts">
  import type { AgentObservedState } from '@shared/types/sessions.js';
  import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';

  let selected = $derived(sessions.selected);
  let observation = $derived(selected ? sessions.observationFor(selected.id) : null);
  let workers = $derived(selected ? sessions.childWorkersFor(selected.id) : []);

  function stateLabel(state: AgentObservedState | undefined): string {
    if (!state) return 'unobserved';
    return state.replaceAll('_', ' ');
  }

  function providerLabel(worker: ObservedAgentSnapshot): string {
    return worker.provider === 'claude_code' ? 'Claude' : 'Codex';
  }

  async function stopWorker(workerId: string | undefined) {
    if (!workerId) return;
    try {
      await sessions.stopWorker(workerId);
    } catch (err) {
      reportError(err);
    }
  }
</script>

<aside class="inspector" aria-label="Agent inspector">
  <div class="section">
    <div class="heading">Session</div>
    {#if selected}
      <div class="kv">
        <span>State</span>
        <strong class="state {observation?.state ?? 'idle'}">{stateLabel(observation?.state)}</strong>
      </div>
      <div class="kv">
        <span>Runtime</span>
        <strong>{observation?.runtimeMode ?? 'tui'}</strong>
      </div>
      {#if observation?.providerThreadId}
        <div class="kv">
          <span>Thread</span>
          <code>{observation.providerThreadId}</code>
        </div>
      {/if}
      {#if observation?.lastEventAt}
        <div class="kv">
          <span>Last event</span>
          <time datetime={observation.lastEventAt}>{new Date(observation.lastEventAt).toLocaleTimeString()}</time>
        </div>
      {/if}
    {:else}
      <p class="muted">No session selected</p>
    {/if}
  </div>

  <div class="section workers">
    <div class="heading">Workers</div>
    {#if workers.length === 0}
      <p class="muted">No background workers</p>
    {:else}
      {#each workers as worker (worker.id)}
        <div class="worker">
          <div class="worker-head">
            <div>
              <strong>{providerLabel(worker)}</strong>
              <span class="state {worker.state}">{stateLabel(worker.state)}</span>
            </div>
            <button
              class="stop"
              disabled={worker.state === 'completed' || worker.state === 'failed' || worker.state === 'exited'}
              onclick={() => stopWorker(worker.workerId)}
            >
              Stop
            </button>
          </div>
          {#if worker.promptSummary}
            <p>{worker.promptSummary}</p>
          {/if}
          {#if worker.resultSummary}
            <p class="result">{worker.resultSummary}</p>
          {/if}
          {#if worker.providerThreadId}
            <code>{worker.providerThreadId}</code>
          {/if}
          {#each sessions.eventsFor(worker.id).slice(0, 4) as event (event.id)}
            <div class="event">
              <time datetime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
              <span>{event.summary}</span>
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .inspector {
    width: 320px;
    flex-shrink: 0;
    background: var(--bg-elev-1);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .section {
    padding: 12px;
    border-bottom: 1px solid var(--border);
  }
  .heading {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .kv {
    display: grid;
    grid-template-columns: 82px minmax(0, 1fr);
    align-items: baseline;
    gap: 8px;
    margin: 7px 0;
  }
  .kv span {
    color: var(--muted);
    font-size: 12px;
  }
  code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
    overflow-wrap: anywhere;
  }
  time {
    color: var(--muted);
    font-size: 12px;
  }
  .muted {
    color: var(--muted);
    margin: 0;
  }
  .workers {
    flex: 1;
    border-bottom: none;
  }
  .worker {
    border-top: 1px solid var(--border);
    padding: 10px 0;
  }
  .worker:first-of-type {
    border-top: none;
    padding-top: 0;
  }
  .worker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .worker-head > div {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .worker p {
    margin: 8px 0 0;
    color: var(--muted);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .worker .result {
    color: var(--fg);
  }
  .state {
    display: inline-flex;
    align-items: center;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .state.starting,
  .state.working,
  .state.running_tool {
    color: var(--amber);
  }
  .state.idle,
  .state.completed {
    color: var(--green);
  }
  .state.failed {
    color: var(--red);
  }
  .stop {
    padding: 4px 8px;
    flex-shrink: 0;
  }
  .event {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr);
    gap: 8px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .event span {
    overflow-wrap: anywhere;
  }
</style>
