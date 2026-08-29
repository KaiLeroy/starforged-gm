'use strict';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Composes a single image-generation prompt via a focused, non-conversational OpenRouter call --
 * the same lightweight pattern summarizer.cjs already uses for context compaction, not routed
 * through the main GM conversation loop (openrouter.cjs's runTurn). Keeping this separate means
 * "compose me a portrait prompt" never appears as a message in the actual campaign transcript,
 * and this call can carry its own narrow, tailored context instead of the full tool-calling
 * system prompt the main loop needs.
 */

async function callForPrompt(apiKey, model, systemPrompt, userContent, temperature, topP) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };
  // Inherits the same optional temperature/top_p Settings apply to the main GM conversation --
  // unlike summarizer.cjs's compaction calls (a deliberately accuracy-focused task, excluded on
  // purpose), composing a vivid, varied image prompt is a creative text task using the same
  // model, so the same creativity preference plausibly should carry over here too.
  if (temperature !== null && temperature !== undefined) body.temperature = temperature;
  if (topP !== null && topP !== undefined) body.top_p = topP;
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Image prompt composition failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content || !content.trim()) {
    throw new Error('Image prompt composition returned an empty response.');
  }
  return content.trim();
}

const SYSTEM_PROMPT =
  'You write a single, vivid, visual image-generation prompt for a text-to-image model (like Stable Diffusion), ' +
  'based on context from an ongoing solo tabletop RPG campaign. Output ONLY the prompt itself -- no preamble, no ' +
  "surrounding quotation marks, no explanation, no alternatives or options. Focus on concrete VISUAL details: " +
  'physical appearance, pose, setting, mood, lighting, art style. Infer plausible, specific visual details from ' +
  "the given context (personality, role, events, gear) even where they aren't stated outright -- a described " +
  'gunslinger likely carries a weapon and dresses for it, for instance -- but never contradict anything ' +
  'explicitly given. Keep it to roughly one or two sentences of comma-separated descriptive phrases, in the ' +
  'style typical of image-generation prompts, not a full narrative paragraph.';

const SETTING_LINE = 'Setting: a science-fiction/space-opera universe (Ironsworn: Starforged).';

/**
 * `kind` selects which context shape is expected and how the request is framed:
 *   'portrait'     -- the player character themselves
 *   'connection'   -- a named NPC the character has a relationship with
 *   'location'     -- a sector hex/location
 *   'illustration' -- a general scene/moment from the story, not tied to one specific subject
 * `context` fields are all optional; only what's actually known is included in the request, and
 * an entirely empty context still produces a reasonable, generic prompt for that kind rather than
 * failing -- there's always at least the setting line and whatever name is available.
 */
async function composeImagePrompt({ apiKey, model, kind, context = {}, temperature = null, topP = null }) {
  let userContent;
  if (kind === 'portrait') {
    userContent =
      `Compose an image prompt for a PORTRAIT of this player character.\n\n` +
      `Name: ${context.name || 'unnamed'}\n` +
      (context.pronouns ? `Pronouns: ${context.pronouns}\n` : '') +
      (context.description ? `Description: ${context.description}\n` : '') +
      (context.assetNames && context.assetNames.length ? `Notable traits/gear from their character sheet: ${context.assetNames.join(', ')}\n` : '') +
      (context.recentStory ? `Recent story context: ${context.recentStory}\n` : '') +
      `\n${SETTING_LINE}`;
  } else if (kind === 'connection') {
    userContent =
      `Compose an image prompt for a PORTRAIT of this named non-player character.\n\n` +
      `Name: ${context.name || 'unnamed'}\n` +
      (context.role ? `Role: ${context.role}\n` : '') +
      (context.notes ? `Notes: ${context.notes}\n` : '') +
      (context.recentStory ? `Recent story context involving them: ${context.recentStory}\n` : '') +
      `\n${SETTING_LINE}`;
  } else if (kind === 'location') {
    userContent =
      `Compose an image prompt for a piece of LOCATION/ENVIRONMENT concept art.\n\n` +
      `Name: ${context.name || 'an unnamed location'}\n` +
      (context.notes ? `Notes: ${context.notes}\n` : '') +
      (context.features && context.features.length ? `Known features here: ${context.features.join(', ')}\n` : '') +
      (context.sectorNotes ? `Sector context: ${context.sectorNotes}\n` : '') +
      `\n${SETTING_LINE}`;
  } else {
    userContent =
      `Compose an image prompt capturing a SCENE or MOMENT from this ongoing campaign.\n\n` +
      (context.recentStory ? `Recent events: ${context.recentStory}\n` : '') +
      (context.characterName ? `The player character is ${context.characterName}${context.characterDescription ? `, ${context.characterDescription}` : ''}.\n` : '') +
      `\n${SETTING_LINE}`;
  }
  return callForPrompt(apiKey, model, SYSTEM_PROMPT, userContent, temperature, topP);
}

module.exports = { composeImagePrompt, OPENROUTER_URL };
