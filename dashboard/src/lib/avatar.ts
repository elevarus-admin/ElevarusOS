/**
 * Avatar utilities for ElevarusOS agents.
 *
 * Uses DiceBear's free CDN to generate deterministic robot avatars from a
 * seed string (agent ID). The same seed always produces the same avatar,
 * so avatars are stable across page loads without any stored state.
 *
 * Style: bottts — robot faces that feel human-adjacent but clearly AI.
 * Docs:  https://www.dicebear.com/styles/bottts
 */

/** Brand palette used as avatar background chips */
const BG_COLORS = [
  'b6e3f4', // sky blue
  'c0aede', // lavender
  'd1d4f9', // periwinkle
  'ffd5dc', // blush
  'ffdfbf', // peach
];

/**
 * Returns a DiceBear CDN URL for a robot avatar seeded by `agentId`.
 * The background colour is deterministically picked from the brand palette
 * so avatars look cohesive in the grid but are visually distinct.
 */
export function agentAvatarUrl(agentId: string, size = 80): string {
  // Simple hash to pick a stable background colour
  const hash = agentId.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const bg = BG_COLORS[hash % BG_COLORS.length];

  const params = new URLSearchParams({
    seed:            agentId,
    backgroundColor: bg,
    size:            String(size),
  });

  return `https://api.dicebear.com/9.x/bottts/svg?${params.toString()}`;
}
