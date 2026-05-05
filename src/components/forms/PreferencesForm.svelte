<script lang="ts">
  import { Tabs } from 'bits-ui';
  import { Box, Cpu, Palette, PlugZap, SlidersHorizontal, TerminalSquare } from '@lucide/svelte';
  import { settings } from '../../stores/settings.svelte';
  import type {
    ModelSelection,
    ModelTask,
    SettingsBinaries,
    TerminalFontSizePref,
    ThemePref
  } from '@shared/types/settings.js';
  import { MODEL_CATALOG } from '@shared/types/settings.js';
  import type { RunMode, SessionLaunchKind, ShellKind } from '@shared/types/sessions.js';
  import { reportError } from '../../stores/toast.svelte';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';
  import * as Select from '$lib/components/ui/select';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { cn } from '$lib/utils';
  import AgentIntegrationForm from './AgentIntegrationForm.svelte';

  const themes: ThemePref[] = ['dark', 'light', 'system'];
  const terminalFontSizes: TerminalFontSizePref[] = [11, 12, 13, 14];
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
    }
  ];

  const tabs = [
    { value: 'integration', label: 'Integration', icon: PlugZap },
    { value: 'appearance', label: 'Appearance', icon: Palette },
    { value: 'models', label: 'Models', icon: Cpu },
    { value: 'terminal', label: 'Terminal', icon: TerminalSquare },
    { value: 'defaults', label: 'Defaults', icon: SlidersHorizontal },
    { value: 'binaries', label: 'Binaries', icon: Box }
  ] as const;

  let activeTab = $state<string>('integration');

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
    </Tabs.Content>

    <Tabs.Content value="models" class={contentClass}>
      <p class="m-0 text-[11px] text-muted-foreground">
        Pick which CLI handles each background LLM task. Connect a provider in Integration if it
        isn't listed.
      </p>
      {#each modelTasks as task (task.key)}
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground">{task.label}</Label>
          <Select.Root
            type="single"
            value={modelKey(settings.current.models[task.key])}
            onValueChange={(v) => setModel(task.key, v)}
          >
            <Select.Trigger class="w-full">
              {modelLabel(settings.current.models[task.key])}
            </Select.Trigger>
            <Select.Content>
              {#each MODEL_CATALOG as entry (modelKey(entry))}
                <Select.Item value={modelKey(entry)} label={entry.label}>
                  <span class="flex items-center gap-2">
                    <span class="text-[10px] tracking-wider text-muted-foreground uppercase">
                      {entry.provider}
                    </span>
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

    <Tabs.Content value="terminal" class={contentClass}>
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
          Confirm before closing sessions
        </Label>
        <Switch
          id="pref-confirm-delete-tabs"
          checked={settings.current.terminal.confirmDeleteTabs}
          onCheckedChange={setConfirmDeleteTabs}
        />
      </div>
    </Tabs.Content>

    <Tabs.Content value="defaults" class={contentClass}>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground">New session button</Label>
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
