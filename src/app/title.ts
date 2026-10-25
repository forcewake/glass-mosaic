import type { AgentState } from './webmcp';

/**
 * The standing assistant instruction, carried in `<title>` (index.html) and
 * restated in `<meta name="description">`, as Meta's samples do: agent hosts
 * read the document title as context on every turn
 * (https://github.com/facebook/meta_glasses_webmcp/blob/main/examples/todo/index.html,
 * examples/market/index.html). Keep index.html's `<title>` equal to TITLE_RULE.
 */
export const TITLE_RULE =
  'Glass Mosaic \u2014 Always act with a mosaic_* tool: mosaic_search for any request to show, find or search pictures, videos or sounds, and mosaic_get_state to read what is on screen, on every screen; mosaic_open_item on the mosaic and results; mosaic_next_item, mosaic_previous_item and mosaic_close_viewer only while the viewer is open. Never answer with a description of what you would do.';

const short = (text: string, max = 60) => {
  const t = text.replace(/[\p{Cc}<>`"]/gu, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};

/** Samples pattern (examples/todo/src/view.ts): the rule plus the live screen. */
export function liveTitle(state: AgentState): string {
  let screen: string;
  if (state.mode === 'viewer' && state.item) {
    screen = `viewer, "${short(state.item.title)}" (${state.item.type}, ${state.item.position})`;
  } else if (state.mode === 'results') {
    screen = `results for "${short(state.query, 40)}" (${state.matches} matches)`;
  } else {
    screen = 'mosaic';
  }
  return `${TITLE_RULE} Live screen: ${screen}.`;
}
