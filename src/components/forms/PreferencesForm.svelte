<script lang="ts">
  import { Tabs } from 'bits-ui';
  import { Box, Cpu, Palette, PlugZap, Rocket, TerminalSquare, X } from '@lucide/svelte';
  import { settings } from '../../stores/settings.svelte';
  import type {
    DiffFontSizePref,
    ModelProvider,
    ModelSelection,
    ModelTask,
    QuickLaunchPreset,
    SettingsBinaries,
    TerminalFontSizePref,
    ThemePref
  } from '@shared/types/settings.js';
  import { MODEL_CATALOG, modelCatalogFor } from '@shared/types/settings.js';
  import type { AgentRuntimeProvider, RunMode, SessionLaunchKind, ShellKind } from '@shared/types/sessions.js';
  import { reportError } from '../../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';
  import * as Select from '$lib/components/ui/select';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { cn } from '$lib/utils';
  import AgentIntegrationForm from './AgentIntegrationForm.svelte';
  import KindIcon from '../KindIcon.svelte';

  const themes: ThemePref[] = ['dark', 'light', 'system'];
  const terminalFontSizes: TerminalFontSizePref[] = [11, 12, 13, 14];
  const diffFontSizes: DiffFontSizePref[] = [11, 12, 13, 14, 15, 16];
  const runModes: RunMode[] = ['windows', 'wsl'];
  const shells: ShellKind[] = ['auto', 'bash', 'zsh', 'pwsh', 'cmd', 'custom'];
  const newSessionKinds: { value: SessionLaunchKind; label: string }[] = [
    { value: 'terminal', label: 'Terminal' },
    { value: 'claude_code', label: 'Claude' },
    { value: 'codex', label: 'Codex' }
  ];
  const binaryKeys: { key: keyof SettingsBinaries; label: string; placeholder: string }[] = [
    { key: 'claude', label: 'Claude binary', placeholder: 'claude' },
    { key: 'codex', label: 'Codex binary', placeholder: 'codex' },
    { key: 'git', label: 'git', placeholder: 'git' },
    { key: 'gh', label: 'gh', placeholder: 'gh' },
    { key: 'fd', label: 'fd', placeholder: 'fd' },
    { key: 'rg', label: 'rg', placeholder: 'rg' },
    { key: 'editor', label: 'External editor', placeholder: 'code' }
  ];

  const modelTasks: { key: ModelTask; label: string; hint: string }[] = [
    {
      key: 'textGeneration',
      label: 'Session naming',
      hint: 'Used to auto-rename a session from its first prompt.'
    },
    {
      key: 'gitCommitGeneration',
      label: 'Git commit messages',
      hint: 'Used when suggesting commit messages from a diff.'
    },
    {
      key: 'worktreeOverview',
      label: 'Worktree overview',
      hint: 'Used to summarize a worktree and answer follow-up questions about it.'
    }
  ];

  const tabs = [
    { value: 'integration', label: 'Integration', icon: PlugZap },
    { value: 'appearance', label: 'Appearance', icon: Palette },
    { value: 'models', label: 'Models', icon: Cpu },
    { value: 'quicklaunch', label: 'Quick Launch', icon: Rocket },
    { value: 'terminal', label: 'Terminal', icon: TerminalSquare },
    { value: 'binaries', label: 'Binaries', icon: Box }
  ] as const;

  let activeTab = $state<string>('integration');
  let lastAppliedTabNonce = -1;

  // React to settings.openDialog('integration') and similar by jumping to
  // the requested tab. The nonce changes on every call so reopening with
  // the same tab still triggers a switch.
  $effect(() => {
    const t = settings.targetTab;
    if (!t) return;
    if (t.nonce === lastAppliedTabNonce) return;
    lastAppliedTabNonce = t.nonce;
    activeTab = t.tab;
  });

  const triggerClass = cn(
    'group/tab flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium',
    'text-muted-foreground transition-colors outline-none',
    'hover:bg-muted hover:text-foreground',
    'focus-visible:ring-2 focus-visible:ring-ring/50',
    'data-[state=active]:bg-muted data-[state=active]:text-foreground'
  );

  const contentClass = 'flex flex-col gap-4 px-5 py-4 outline-none';

  function modelKey(value: ModelSelection | undefined): string {
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

  function modelLabel(value: ModelSelection | undefined): string {
    if (!value) return 'Select a model';
    const entry = MODEL_CATALOG.find(
      (m) => m.provider === value.provider && m.id === value.id
    );
    return entry?.label ?? `${value.provider}: ${value.id}`;
  }

  function providerKind(provider: ModelProvider): 'claude_code' | 'codex' {
    return provider === 'claude' ? 'claude_code' : 'codex';
  }

  function presetProviderToModel(provider: AgentRuntimeProvider): ModelProvider {
    return provider === 'claude_code' ? 'claude' : 'codex';
  }

  async function setModel(task: ModelTask, value: string) {
    const parsed = parseModelKey(value);
    if (!parsed) return;
    try {
      await settings.update({ models: { [task]: parsed } });
    } catch (e) { reportError(e); }
  }

  async function setAppearance<K extends 'theme'>(
    key: K,
    value: ThemePref
  ) {
    try {
      await settings.update({ appearance: { [key]: value } as never });
    } catch (e) { reportError(e); }
  }

  async function setTerminalFontSize(value: TerminalFontSizePref) {
    try {
      await settings.update({ terminal: { fontSize: value } });
    } catch (e) { reportError(e); }
  }

  async function setDiffFontSize(value: DiffFontSizePref) {
    try {
      await settings.update({ diff: { fontSize: value } });
    } catch (e) { reportError(e); }
  }

  async function setConfirmDeleteTabs(value: boolean) {
    try {
      await settings.update({ terminal: { confirmDeleteTabs: value } });
    } catch (e) { reportError(e); }
  }

  async function setDefault<K extends 'runMode' | 'wslDistro' | 'shell'>(
    key: K,
    value: string
  ) {
    try {
      await settings.update({ defaults: { [key]: value || undefined } as never });
    } catch (e) { reportError(e); }
  }

  async function setDefaultCwd(value: string) {
    try {
      await settings.update({ defaults: { cwd: value.trim() || '~' } });
    } catch (e) { reportError(e); }
  }

  async function setDefaultNewSessionKind(value: SessionLaunchKind) {
    try {
      await settings.update({ defaults: { newSessionKind: value } });
    } catch (e) { reportError(e); }
  }

  async function setBinary(key: keyof SettingsBinaries, value: string) {
    try {
      await settings.update({ binaries: { [key]: value } as never });
    } catch (e) { reportError(e); }
  }

  const quickLaunchProviders: { value: AgentRuntimeProvider; label: string }[] = [
    { value: 'claude_code', label: 'Claude' },
    { value: 'codex', label: 'Codex' }
  ];

  function generatePresetId(): string {
    return `ql_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  async function addPreset(): Promise<void> {
    const next: QuickLaunchPreset[] = [
      ...settings.current.quickLaunch,
      { id: generatePresetId(), label: '', provider: 'claude_code' }
    ];
    try {
      await settings.update({ quickLaunch: next });
    } catch (e) { reportError(e); }
  }

  async function removePreset(id: string): Promise<void> {
    const next = settings.current.quickLaunch.filter((p) => p.id !== id);
    try {
      await settings.update({ quickLaunch: next });
    } catch (e) { reportError(e); }
  }

  async function updatePreset(id: string, patch: Partial<QuickLaunchPreset>): Promise<void> {
    const next = settings.current.quickLaunch.map((p) =>
      p.id === id ? { ...p, ...patch } : p
    );
    try {
      await settings.update({ quickLaunch: next });
    } catch (e) { reportError(e); }
  }
</script>

<Tabs.Root
  orientation="vertical"
  value={activeTab}
  onValueChange={(v) => (activeTab = v)}
  class="flex min-h-0 flex-1 overflow-hidden"
>
  <Tabs.List
    class="flex w-44 shrink-0 flex-col items-stretch gap-0.5 border-r border-border bg-muted/30 p-2"
  >
    {#each tabs as tab (tab.value)}
      <Tabs.Trigger value={tab.value} class={triggerClass}>
        <tab.icon class="size-3.5 shrink-0" />
        <span>{tab.label}</span>
      </Tabs.Trigger>
    {/each}
  </Tabs.List>

  <ScrollArea class="min-h-0 flex-1">
    <Tabs.Content value="integration" class={contentClass}>
      <AgentIntegrationForm />
    </Tabs.Content>

    <Tabs.Content value="appearance" class={contentClass}>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground">Theme</Label>
        <Select.Root
          type="single"
          value={settings.current.appearance.theme}
          onValueChange={(v) => setAppearance('theme', v as ThemePref)}
        >
          <Select.Trigger class="w-full">{settings.current.appearance.theme}</Select.Trigger>
          <Select.Content>
            {#each themes as t (t)}
              <Select.Item value={t} label={t}>{t}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground">Diff font size</Label>
        <Select.Root
          type="single"
          value={String(settings.current.diff.fontSize)}
          onValueChange={(v) => setDiffFontSize(Number(v) as DiffFontSizePref)}
        >
          <Select.Trigger class="w-full">{settings.current.diff.fontSize}px</Select.Trigger>
          <Select.Content>
            {#each diffFontSizes as f (f)}
              <Select.Item value={String(f)} label={`${f}px`}>{f}px</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    </Tabs.Content>

    <Tabs.Content value="models" class={contentClass}>
      <p class="m-0 text-[11px] text-muted-foreground">
        Pick which CLI handles each background LLM task. Connect a provider in Integration if it
        isn't listed.
      </p>
      {#each modelTasks as task (task.key)}
        {@const selected = settings.current.models[task.key]}
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground">{task.label}</Label>
          <Select.Root
            type="single"
            value={modelKey(selected)}
            onValueChange={(v) => setModel(task.key, v)}
          >
            <Select.Trigger class="w-full">
              <span class="flex items-center gap-2">
                {#if selected}
                  <KindIcon kind={providerKind(selected.provider)} size={14} />
                {/if}
                <span>{modelLabel(selected)}</span>
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
          <span class="text-[11px] text-muted-foreground">{task.hint}</span>
        </div>
      {/each}
    </Tabs.Content>

    <Tabs.Content value="quicklaunch" class={contentClass}>
      <p class="m-0 text-[11px] text-muted-foreground">
        Presets appear below the three main icons in the <b>+</b> popover for quick one-click
        launching.
      </p>
      {#each settings.current.quickLaunch as preset (preset.id)}
        {@const presetModelOptions = modelCatalogFor(presetProviderToModel(preset.provider))}
        {@const presetSelectedModel = presetModelOptions.find((m) => m.id === preset.model)}
        <div class="flex flex-col gap-2 rounded-md border border-border p-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <KindIcon kind={preset.provider} size={16} />
              <span class="text-sm font-medium">
                {preset.label || '(untitled)'}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-6 shrink-0 text-muted-foreground hover:text-destructive"
              title="Remove preset"
              onclick={() => removePreset(preset.id)}
            >
              <X class="size-3.5" />
            </Button>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs text-muted-foreground" for={`ql-label-${preset.id}`}>Label</Label>
            <Input
              id={`ql-label-${preset.id}`}
              type="text"
              placeholder="e.g. Opus 4.7"
              value={preset.label}
              onchange={(e) =>
                updatePreset(preset.id, { label: (e.currentTarget as HTMLInputElement).value })}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs text-muted-foreground">Provider</Label>
            <Select.Root
              type="single"
              value={preset.provider}
              onValueChange={(v) =>
                updatePreset(preset.id, { provider: v as AgentRuntimeProvider })}
            >
              <Select.Trigger class="w-full">
                {quickLaunchProviders.find((p) => p.value === preset.provider)?.label ?? preset.provider}
              </Select.Trigger>
              <Select.Content>
                {#each quickLaunchProviders as p (p.value)}
                  <Select.Item value={p.value} label={p.label}>{p.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs text-muted-foreground">Model</Label>
            <Select.Root
              type="single"
              value={preset.model ?? '__default__'}
              onValueChange={(v) =>
                updatePreset(preset.id, { model: v === '__default__' ? undefined : v })}
            >
              <Select.Trigger class="w-full">
                <span class="flex items-center gap-2">
                  {#if preset.model}
                    <KindIcon kind={preset.provider} size={14} />
                  {/if}
                  <span>{presetSelectedModel?.label ?? (preset.model || '(CLI default)')}</span>
                </span>
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="__default__" label="(CLI default)">
                  (CLI default)
                </Select.Item>
                {#each presetModelOptions as entry (entry.id)}
                  <Select.Item value={entry.id} label={entry.label}>
                    <span class="flex items-center gap-2">
                      <KindIcon kind={providerKind(entry.provider)} size={14} />
                      <span>{entry.label}</span>
                    </span>
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          {#if preset.provider === 'claude_code'}
            <div class="flex items-center gap-2">
              <Checkbox
                id={`ql-skip-perms-${preset.id}`}
                checked={preset.dangerouslySkipPermissions ?? false}
                onCheckedChange={(v) =>
                  updatePreset(preset.id, { dangerouslySkipPermissions: v === true || undefined })}
              />
              <Label for={`ql-skip-perms-${preset.id}`} class="text-sm text-foreground">
                --dangerously-skip-permissions
              </Label>
            </div>
          {/if}
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs text-muted-foreground" for={`ql-args-${preset.id}`}>
              Extra CLI args
            </Label>
            <Input
              id={`ql-args-${preset.id}`}
              type="text"
              placeholder={preset.provider === 'claude_code'
                ? '--verbose --allowedTools bash,computer'
                : '--full-auto'}
              value={preset.extraArgs ?? ''}
              onchange={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value.trim();
                updatePreset(preset.id, { extraArgs: v || undefined });
              }}
            />
            <span class="text-[11px] text-muted-foreground">
              Space-separated flags appended to the CLI command.
            </span>
          </div>
        </div>
      {/each}
      <Button variant="outline" class="w-full" onclick={addPreset}>
        Add preset
      </Button>
    </Tabs.Content>

    <Tabs.Content value="terminal" class={contentClass}>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground">Quick-open default</Label>
        <Select.Root
          type="single"
          value={settings.current.defaults.newSessionKind}
          onValueChange={(v) => setDefaultNewSessionKind(v as SessionLaunchKind)}
        >
          <Select.Trigger class="w-full">
            {newSessionKinds.find((k) => k.value === settings.current.defaults.newSessionKind)
              ?.label ?? 'Terminal'}
          </Select.Trigger>
          <Select.Content>
            {#each newSessionKinds as kind (kind.value)}
              <Select.Item value={kind.value} label={kind.label}>{kind.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <span class="text-[11px] text-muted-foreground">
          Session type opened by <kbd class="rounded border border-border px-1 font-mono text-[10px]">Ctrl+T</kbd> and the <b>+</b> button.
        </span>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground">Run mode</Label>
        <Select.Root
          type="single"
          value={settings.current.defaults.runMode}
          onValueChange={(v) => setDefault('runMode', v)}
        >
          <Select.Trigger class="w-full">{settings.current.defaults.runMode}</Select.Trigger>
          <Select.Content>
            {#each runModes as r (r)}
              <Select.Item value={r} label={r}>{r}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground" for="pref-wsl-distro">WSL distro</Label>
        <Input
          id="pref-wsl-distro"
          type="text"
          placeholder="Ubuntu"
          value={settings.current.defaults.wslDistro ?? ''}
          onchange={(e) => setDefault('wslDistro', (e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground">Shell</Label>
        <Select.Root
          type="single"
          value={settings.current.defaults.shell}
          onValueChange={(v) => setDefault('shell', v)}
        >
          <Select.Trigger class="w-full">{settings.current.defaults.shell}</Select.Trigger>
          <Select.Content>
            {#each shells as s (s)}
              <Select.Item value={s} label={s}>{s}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground" for="pref-default-cwd">
          Default working directory
        </Label>
        <Input
          id="pref-default-cwd"
          type="text"
          placeholder="~"
          value={settings.current.defaults.cwd}
          onchange={(e) => setDefaultCwd((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground">Font size</Label>
        <Select.Root
          type="single"
          value={String(settings.current.terminal.fontSize)}
          onValueChange={(v) => setTerminalFontSize(Number(v) as TerminalFontSizePref)}
        >
          <Select.Trigger class="w-full">{settings.current.terminal.fontSize}px</Select.Trigger>
          <Select.Content>
            {#each terminalFontSizes as f (f)}
              <Select.Item value={String(f)} label={`${f}px`}>{f}px</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex items-center justify-between gap-3">
        <Label for="pref-confirm-delete-tabs" class="text-xs text-muted-foreground">
          Confirm when closing sessions via the trash icon
        </Label>
        <Switch
          id="pref-confirm-delete-tabs"
          checked={settings.current.terminal.confirmDeleteTabs}
          onCheckedChange={setConfirmDeleteTabs}
        />
      </div>
    </Tabs.Content>

    <Tabs.Content value="binaries" class={contentClass}>
      <p class="m-0 text-[11px] text-muted-foreground">Leave blank to use the binary on PATH.</p>
      {#each binaryKeys as b (b.key)}
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground" for={`bin-${b.key}`}>{b.label}</Label>
          <Input
            id={`bin-${b.key}`}
            type="text"
            placeholder={b.placeholder}
            value={settings.current.binaries[b.key] ?? ''}
            onchange={(e) => setBinary(b.key, (e.currentTarget as HTMLInputElement).value)}
          />
        </div>
      {/each}
    </Tabs.Content>
  </ScrollArea>
</Tabs.Root>
