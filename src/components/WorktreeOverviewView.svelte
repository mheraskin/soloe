<script lang="ts">
  import { onDestroy } from 'svelte';
  import { RefreshCw, Loader2, AlertCircle } from '@lucide/svelte';
  import type {
    AskFollowUpChunk,
    AskFollowUpRequest,
    OverviewStatus,
    WorktreeOverview
  } from '@shared/types/overview.js';
  import { ipc } from '../lib/ipc';
  import { sessions } from '../stores/sessions.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as Select from '$lib/components/ui/select';
  import { MODEL_CATALOG, type ModelProvider, type ModelSelection } from '@shared/types/settings.js';
  import { renderMarkdown } from '../lib/markdown';
  import ChatPanel, { type ChatPanelMessage } from './ChatPanel.svelte';
  import KindIcon from './KindIcon.svelte';

  interface Props {
    cwd: string;
    baseBranch?: string;
  }

  let { cwd, baseBranch }: Props = $props();

  let overview = $state<WorktreeOverview | null>(null);
  let loading = $state(false);
  let regenerating = $state(false);
  let lastError = $state<string | null>(null);
  let chatHistory = $state<ChatPanelMessage[]>([]);
  let autoRegenAttemptedFor = $state<string | null>(null);

  let activeRequestId: string | null = null;
  let activeOnChunk: ((text: string) => void) | null = null;
  let activeStreamResolve: ((result: { ok: boolean; error?: string }) => void) | null = null;

  // Transcript files for the agent sessions currently open in this worktree.
  // The overview is scoped to these — closed/historical sessions don't
  // contribute even if their .jsonl is still on disk.
  const openSessionFiles = $derived.by(() =>
    sessions.sessions
      .filter((s) => s.cwd === cwd && s.launch.type === 'agent' && s.transcriptPath)
      .map((s) => s.transcriptPath as string)
  );

  const detachChunk = ipc.overview.onChunk(handleChunk);

  onDestroy(() => {
    detachChunk();
    if (activeRequestId) {
      void ipc.overview.askCancel(activeRequestId).catch(() => {});
    }
  });

  $effect(() => {
    const target = cwd;
    if (!target) {
      void clearOverview();
      return;
    }
    void loadOverview(target);
  });

  // Kick off a regenerate when the cache is missing or stale relative to
  // current sources. One attempt per cwd: if it errors, leave the user in
  // control rather than burning another spawn. The main-process service
  // dedupes concurrent regens for the same cwd, so reopening while one is
  // in flight is safe.
  $effect(() => {
    if (!overview || loading || regenerating) return;
    if (overview.status !== 'missing' && overview.status !== 'stale') return;
    if (overview.errorMessage) return;
    if (autoRegenAttemptedFor === cwd) return;
    autoRegenAttemptedFor = cwd;
    void regenerate();
  });

  async function clearOverview() {
    overview = null;
    chatHistory = [];
    autoRegenAttemptedFor = null;
  }

  async function loadOverview(targetCwd: string) {
    overview = null;
    chatHistory = [];
    loading = true;
    lastError = null;
    const req = {
      worktreeCwd: targetCwd,
      runMode: settings.current.defaults.runMode,
      wslDistro: settings.current.defaults.wslDistro,
      baseBranch,
      sessionFiles: openSessionFiles
    };
    console.log('[overview] get →', req);
    try {
      const result = await ipc.overview.get(req);
      console.log('[overview] get ←', { status: result.status, hasText: !!result.text, errorMessage: result.errorMessage });
      if (cwd === targetCwd) overview = result;
    } catch (err) {
      console.error('[overview] get threw', err);
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (cwd === targetCwd) loading = false;
    }
  }

  async function regenerate() {
    console.log('[overview] regenerate clicked', { regenerating, cwd, loading });
    if (regenerating) return;
    regenerating = true;
    lastError = null;
    const targetCwd = cwd;
    const req = {
      worktreeCwd: targetCwd,
      runMode: settings.current.defaults.runMode,
      wslDistro: settings.current.defaults.wslDistro,
      baseBranch,
      sessionFiles: openSessionFiles
    };
    console.log('[overview] regenerate →', req);
    try {
      const result = await ipc.overview.regenerate(req);
      console.log('[overview] regenerate ←', {
        status: result.status,
        hasText: !!result.text,
        errorMessage: result.errorMessage,
        generatedBy: result.generatedBy
      });
      if (cwd === targetCwd) overview = result;
    } catch (err) {
      console.error('[overview] regenerate threw', err);
      lastError = err instanceof Error ? err.message : String(err);
      reportError(err);
    } finally {
      if (cwd === targetCwd) regenerating = false;
    }
  }

  function handleChunk(chunk: AskFollowUpChunk) {
    if (!activeRequestId || chunk.requestId !== activeRequestId) return;
    if (chunk.type === 'delta' && chunk.text) {
      activeOnChunk?.(chunk.text);
    } else if (chunk.type === 'done') {
      activeStreamResolve?.({ ok: true });
      resetStream();
    } else if (chunk.type === 'error') {
      activeStreamResolve?.({ ok: false, error: chunk.error ?? 'unknown' });
      resetStream();
    }
  }

  function resetStream() {
    activeRequestId = null;
    activeOnChunk = null;
    activeStreamResolve = null;
  }

  async function send(
    message: string,
    history: ChatPanelMessage[],
    onChunk: (text: string) => void
  ): Promise<{ ok: boolean; error?: string }> {
    const targetCwd = cwd;
    const request: AskFollowUpRequest = {
      worktreeCwd: targetCwd,
      runMode: settings.current.defaults.runMode,
      wslDistro: settings.current.defaults.wslDistro,
      baseBranch,
      sessionFiles: openSessionFiles,
      message,
      history
    };
    try {
      const { requestId } = await ipc.overview.askStart(request);
      activeRequestId = requestId;
      activeOnChunk = onChunk;
      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        activeStreamResolve = resolve;
      });
    } catch (err) {
      resetStream();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function cancelStream() {
    if (!activeRequestId) return;
    void ipc.overview.askCancel(activeRequestId).catch(() => {});
    activeStreamResolve?.({ ok: false, error: 'cancelled' });
    resetStream();
  }

  function statusBadgeVariant(status: OverviewStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
    if (status === 'fresh') return 'default';
    if (status === 'cached') return 'secondary';
    if (status === 'stale') return 'outline';
    return 'outline';
  }

  function statusLabel(status: OverviewStatus): string {
    if (status === 'fresh') return 'Fresh';
    if (status === 'cached') return 'Cached';
    if (status === 'stale') return 'Stale';
    return 'No overview';
  }

  function statusHint(o: WorktreeOverview): string {
    if (o.status === 'fresh') return 'Up to date with current sources';
    if (o.status === 'cached') {
      const ago = formatRelative(o.generatedAt);
      return `Generated ${ago}, sources unchanged`;
    }
    if (o.status === 'stale') {
      const ago = formatRelative(o.generatedAt);
      return `Generated ${ago}, sources have changed since`;
    }
    return 'No overview generated yet — click Regenerate';
  }

  function formatRelative(iso: string | null): string {
    if (!iso) return 'never';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return 'unknown';
    const diff = Date.now() - t;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  let providerLabel = $derived.by(() => {
    if (!overview?.generatedBy) return null;
    const p = overview.generatedBy.provider === 'claude_code' ? 'Claude' : 'Codex';
    return `${p} · ${overview.generatedBy.model}`;
  });

  // Model the next regenerate will use. Falls back to textGeneration for
  // settings written before worktreeOverview existed (mirrors pickProvider
  // in WorktreeOverviewService).
  let selectedModel = $derived.by<ModelSelection | null>(() => {
    return (
      settings.current.models.worktreeOverview ??
      settings.current.models.textGeneration ??
      null
    );
  });

  function modelKey(value: ModelSelection | null | undefined): string {
    return value ? `${value.provider}:${value.id}` : '';
  }
  function parseModelKey(value: string): ModelSelection | null {
    const idx = value.indexOf(':');
    if (idx <= 0) return null;
    const provider = value.slice(0, idx);
    const id = value.slice(idx + 1);
    if (provider !== 'codex' && provider !== 'claude') return null;
    if (!id) return null;
    return { provider, id };
  }
  function modelLabel(value: ModelSelection | null | undefined): string {
    if (!value) return 'Default model';
    const entry = MODEL_CATALOG.find((m) => m.provider === value.provider && m.id === value.id);
    return entry?.label ?? `${value.provider}: ${value.id}`;
  }
  function providerKind(provider: ModelProvider): 'claude_code' | 'codex' {
    return provider === 'claude' ? 'claude_code' : 'codex';
  }
  async function setSelectedModel(value: string) {
    const parsed = parseModelKey(value);
    if (!parsed) return;
    try {
      await settings.update({ models: { worktreeOverview: parsed } });
    } catch (e) {
      reportError(e);
    }
  }

  // Show "Regenerate to apply" when the user has picked a model that
  // differs from whatever produced the cached overview. Compares by
  // provider+id; the catalog uses 'claude' but generatedBy uses
  // 'claude_code', so we normalize.
  let modelChangedSinceLastRun = $derived.by(() => {
    if (!selectedModel || !overview?.generatedBy) return false;
    const generatedProvider: ModelProvider =
      overview.generatedBy.provider === 'claude_code' ? 'claude' : 'codex';
    return (
      generatedProvider !== selectedModel.provider ||
      overview.generatedBy.model !== selectedModel.id
    );
  });

  let sourcesLabel = $derived.by(() => {
    if (!overview) return '';
    const s = overview.sources;
    if (s.sessionCount === 0) return 'no sessions';
    const sess = `${s.sessionCount} session${s.sessionCount === 1 ? '' : 's'}`;
    const turns = `${s.totalTurns} turn${s.totalTurns === 1 ? '' : 's'}`;
    const tokens = `~${formatTokens(s.approxInputTokens)} tok`;
    return `${sess} · ${turns} · ${tokens}`;
  });

  function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex flex-col gap-2 border-b border-border bg-card/40 px-3 py-2">
    <div class="flex items-center gap-2">
      <span class="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Worktree overview</span>
      {#if overview}
        <Badge variant={statusBadgeVariant(overview.status)} class="text-[10px]">
          {statusLabel(overview.status)}
        </Badge>
      {/if}
      <div class="flex-1"></div>
      <Select.Root
        type="single"
        value={modelKey(selectedModel)}
        onValueChange={(v) => void setSelectedModel(v)}
      >
        <Select.Trigger class="h-7 w-auto min-w-[150px] gap-1.5 px-2 py-0 text-xs" aria-label="Overview model">
          <span class="flex items-center gap-1.5 truncate">
            {#if selectedModel}
              <KindIcon kind={providerKind(selectedModel.provider)} size={12} />
            {/if}
            <span class="truncate">{modelLabel(selectedModel)}</span>
          </span>
        </Select.Trigger>
        <Select.Content>
          {#each MODEL_CATALOG as entry (modelKey(entry))}
            <Select.Item value={modelKey(entry)} label={entry.label}>
              <span class="flex items-center gap-2">
                <KindIcon kind={providerKind(entry.provider)} size={14} />
                <span>{entry.label}</span>
              </span>
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Button
        variant="outline"
        size="xs"
        onclick={regenerate}
        disabled={regenerating || loading || !cwd}
        aria-label="Regenerate overview"
      >
        {#if regenerating}
          <Loader2 class="mr-1 h-3 w-3 animate-spin" />
          Regenerating…
        {:else}
          <RefreshCw class="mr-1 h-3 w-3" />
          Regenerate
        {/if}
      </Button>
    </div>
    {#if overview}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{statusHint(overview)}</span>
        {#if providerLabel}
          <span class="text-foreground/70">· {providerLabel}</span>
        {/if}
        <span>· {sourcesLabel}</span>
        {#if modelChangedSinceLastRun && !regenerating}
          <span class="text-primary/90">· click Regenerate to apply {modelLabel(selectedModel)}</span>
        {/if}
      </div>
    {/if}
    {#if lastError}
      <div class="flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
        <AlertCircle class="mt-0.5 h-3 w-3 flex-shrink-0" />
        <span class="break-words">{lastError}</span>
      </div>
    {/if}
  </header>

  {#snippet overviewBubble()}
    <div class="rounded-md border border-border/60 bg-card px-3 py-2 text-sm">
      <div class="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Overview</span>
        {#if regenerating}
          <span class="inline-flex items-center gap-1 normal-case">
            <Loader2 class="h-3 w-3 animate-spin" />
            <span class="font-normal tracking-normal">regenerating…</span>
          </span>
        {/if}
      </div>
      {#if loading && !overview}
        <div class="flex items-center gap-2 text-muted-foreground">
          <Loader2 class="h-3 w-3 animate-spin" />
          <span>Loading overview…</span>
        </div>
      {:else if !overview}
        <p class="text-muted-foreground">Select a worktree to see its overview.</p>
      {:else if regenerating && !overview.text}
        <div class="flex items-center gap-2 text-muted-foreground">
          <Loader2 class="h-3 w-3 animate-spin" />
          <span>Reading sessions and asking the model…</span>
        </div>
      {:else if overview.text}
        {#if regenerating}
          <div class="mb-2 flex items-center gap-2 rounded border border-primary/30 bg-primary/5 px-2 py-1 text-xs text-foreground/80">
            <Loader2 class="h-3 w-3 flex-shrink-0 animate-spin" />
            <span>Regenerating overview… showing previous version below.</span>
          </div>
        {/if}
        <div class="md-prose">{@html renderMarkdown(overview.text)}</div>
      {:else if overview.status === 'missing'}
        <p class="text-muted-foreground">
          No overview generated yet. Click <em>Regenerate</em> to summarize what's been done in this worktree.
        </p>
      {:else if overview.errorMessage}
        <p class="text-destructive">{overview.errorMessage}</p>
      {:else}
        <p class="text-muted-foreground">Overview is empty.</p>
      {/if}
    </div>
  {/snippet}

  <div class="flex min-h-0 flex-1 flex-col">
    <ChatPanel
      {send}
      bind:history={chatHistory}
      onCancel={cancelStream}
      disabled={!overview || overview.status === 'missing'}
      placeholder="Ask a follow-up about this worktree…"
      contextSummary={overview ? sourcesLabel : ''}
      prefix={overviewBubble}
    />
  </div>
</div>
