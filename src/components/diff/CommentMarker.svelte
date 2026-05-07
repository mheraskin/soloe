<script lang="ts">
  import type { DiffComment } from '../../stores/diff-comments.svelte';
  import CommentPopover from './CommentPopover.svelte';

  interface Props {
    comments: DiffComment[];
  }

  let { comments }: Props = $props();

  let primary = $derived(comments[0] ?? null);
  let count = $derived(comments.length);
  // Color shifts to emerald only when every comment at this anchor has been
  // sent — a partially-sent thread keeps the unsent amber as a "still has
  // work" cue.
  let allSent = $derived(comments.length > 0 && comments.every((c) => Boolean(c.sentAt)));
</script>

{#if primary}
  <CommentPopover comment={primary}>
    {#snippet trigger({ props })}
      <button
        type="button"
        {...props}
        onmousedown={(e) => e.stopPropagation()}
        class={[
          'absolute top-0 bottom-0 left-0 z-[1] flex w-[3px] cursor-pointer items-stretch',
          allSent ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-amber-500 hover:bg-amber-400'
        ]}
        aria-label="Comment thread on line {primary.startLine}"
        title={primary.text || 'Comment'}
      >
        {#if count > 1}
          <span
            class={[
              'absolute top-0 -right-3 rounded-full px-1 text-[8px] leading-tight font-semibold',
              allSent ? 'bg-emerald-500 text-emerald-50' : 'bg-amber-500 text-amber-50'
            ]}
          >
            {count}
          </span>
        {/if}
      </button>
    {/snippet}
  </CommentPopover>
{/if}
