'use strict';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Multi-layer context summarization.
 *
 * The raw message history (record.messages) has no ceiling on its own -- every user message,
 * assistant narration, tool call, and tool result from the entire campaign gets resent to the
 * model every single turn, forever. That's fine for a normal campaign, but has no safety net for
 * a genuinely long one: eventually it would just fail outright once it exceeds the model's
 * context window, with nothing graceful in between.
 *
 * This adds two compression tiers, sitting between "raw message history" and "gone":
 *   Tier 0 (unchanged): the most recent RECENT_WINDOW_MESSAGES stay verbatim in record.messages,
 *     sent to the API exactly as they are now -- full detail, tool calls and all.
 *   Tier 1 (recent summary): when messages age out of Tier 0, the oldest SUMMARIZE_BATCH_SIZE of
 *     them get condensed by a real LLM call into a moderate-detail narrative recap, appended to
 *     campaignState.storySummary.recent, and removed from record.messages.
 *   Tier 2 (distant summary): once storySummary.recent grows past DISTANT_COMPACT_THRESHOLD
 *     characters, it gets folded into campaignState.storySummary.distant via a second,
 *     higher-compression LLM pass, and recent is reset to empty.
 *
 * Content only ever flows one direction (raw -> recent -> distant), getting more compressed each
 * step, and both summary tiers are surfaced in the system prompt (see systemPrompt.cjs) so the
 * model retains real continuity for events no longer in the raw transcript at all.
 */

const RECENT_WINDOW_MESSAGES = 60; // keep this many of the newest messages fully verbatim
const SUMMARIZE_BATCH_SIZE = 30; // how many of the oldest messages to fold into a summary at once
const DISTANT_COMPACT_THRESHOLD = 2000; // characters; once storySummary.recent exceeds this, compact it further

/** Strips a batch of raw messages down to just their narrative content -- user actions and the
 *  GM's own prose -- discarding tool_calls/tool-result plumbing, which is mechanical noise the
 *  story summary doesn't need (the mechanical outcomes that matter are already permanent, durable
 *  campaign state -- meters, tracks, impacts -- not something a prose recap needs to re-derive). */
function extractNarrativeText(messages) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'user' && m.content) {
      lines.push(`Player: ${m.content}`);
    } else if (m.role === 'assistant' && m.content && m.content.trim()) {
      lines.push(`GM: ${m.content}`);
    }
  }
  return lines.join('\n\n');
}

async function callSummarizer(apiKey, model, systemPrompt, userContent) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Summarization call failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content || !content.trim()) {
    throw new Error('Summarization call returned an empty response.');
  }
  return content.trim();
}

/** Tier 1: condenses a batch of aging raw messages into a moderate-detail narrative recap,
 *  appended to the existing recent-tier summary (not replacing it -- each batch adds on). */
async function summarizeBatch(apiKey, model, existingRecentSummary, messagesToSummarize) {
  const narrative = extractNarrativeText(messagesToSummarize);
  if (!narrative.trim()) return existingRecentSummary; // nothing narratively meaningful in this batch (pure tool-call turns) -- nothing to add
  const systemPrompt =
    'You are compressing part of an ongoing solo tabletop RPG campaign transcript into a concise ' +
    "narrative recap for the game master's own later reference. Preserve concrete plot points, " +
    'named characters and places, decisions made, and unresolved threads. Skip dice mechanics, ' +
    'exact numbers, and moment-to-moment description -- keep only what a GM would need to ' +
    'remember to keep the story consistent. Write it as plain prose, past tense, third person, ' +
    'a few sentences to a short paragraph. No preamble, just the recap itself.';
  const userContent = existingRecentSummary
    ? `Earlier recap so far:\n${existingRecentSummary}\n\nNew events to fold in:\n${narrative}\n\nProduce one updated recap covering everything above.`
    : `Events to summarize:\n${narrative}`;
  return callSummarizer(apiKey, model, systemPrompt, userContent);
}

/** Tier 2: further compresses the recent-tier summary into the distant-tier summary once the
 *  former has grown large enough to be worth compacting again. */
async function compactToDistant(apiKey, model, existingDistantSummary, recentSummary) {
  const systemPrompt =
    'You are merging a new chunk of story recap into the long-term "story so far" summary for an ' +
    'ongoing solo tabletop RPG campaign. Compress aggressively -- keep only the events, decisions, ' +
    'and relationships that still matter for future context. It is fine to lose fine detail here; ' +
    'this is the deep-background layer, not the recent one. Plain prose, past tense, third person, ' +
    'as short as you can make it while keeping it genuinely useful. No preamble, just the summary.';
  const userContent = existingDistantSummary
    ? `Existing long-term summary:\n${existingDistantSummary}\n\nNew material to fold in:\n${recentSummary}\n\nProduce one updated long-term summary covering everything above.`
    : `Material to summarize:\n${recentSummary}`;
  return callSummarizer(apiKey, model, systemPrompt, userContent);
}

/**
 * Runs whatever compaction is currently due against a campaign record, mutating both
 * record.messages (trimmed) and campaignState.storySummary (grown) in place. Safe to call every
 * turn -- it's a no-op below the thresholds. Never throws: a failed summarization call (network
 * issue, bad key) just leaves the history as-is for this turn rather than blocking play, since
 * this is a maintenance step, not something the player is waiting on.
 */
async function maybeCompact({ apiKey, model, record, campaignState }) {
  if (!apiKey) return { compacted: false };
  let compacted = false;

  try {
    while (record.messages.length > RECENT_WINDOW_MESSAGES + SUMMARIZE_BATCH_SIZE) {
      const batch = record.messages.slice(0, SUMMARIZE_BATCH_SIZE);
      campaignState.storySummary.recent = await summarizeBatch(apiKey, model, campaignState.storySummary.recent, batch);
      record.messages = record.messages.slice(SUMMARIZE_BATCH_SIZE);
      compacted = true;
    }

    if (campaignState.storySummary.recent.length > DISTANT_COMPACT_THRESHOLD) {
      campaignState.storySummary.distant = await compactToDistant(apiKey, model, campaignState.storySummary.distant, campaignState.storySummary.recent);
      campaignState.storySummary.recent = '';
      compacted = true;
    }
  } catch (e) {
    // Leave everything as-is for this turn and try again next turn -- see the doc comment above.
    return { compacted, error: e.message };
  }

  return { compacted };
}

module.exports = {
  OPENROUTER_URL,
  RECENT_WINDOW_MESSAGES,
  SUMMARIZE_BATCH_SIZE,
  DISTANT_COMPACT_THRESHOLD,
  extractNarrativeText,
  summarizeBatch,
  compactToDistant,
  maybeCompact,
};
