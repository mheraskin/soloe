const WORDS = [
  'ember', 'cobalt', 'marble', 'wisp', 'sage', 'flint', 'dune', 'aspen',
  'cedar', 'onyx', 'quartz', 'amber', 'slate', 'ivory', 'bramble', 'cinder',
  'frost', 'gale', 'meadow', 'pebble', 'ridge', 'shale', 'thorn', 'tundra',
  'willow', 'azure', 'crimson', 'lichen', 'moss', 'plume', 'reef', 'briar'
];

export function randomName(): string {
  const idx = Math.floor(Math.random() * WORDS.length);
  return WORDS[idx] ?? 'session';
}
