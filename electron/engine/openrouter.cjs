'use strict';
const { TOOL_SCHEMAS, executeTool } = require('./tools.cjs');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// This is a genuine safety net against a truly runaway/looping model, not meant to bound how
// much legitimate work one turn can involve. It needs real headroom: the book's own "Build a
// Starting Sector" procedure (deliberately run as one full upfront batch on the first turn, see
// systemPrompt.cjs's sectorSetupBlock) is, by itself, an estimated 50+ individual tool calls for
// a thorough Terminus-region setup -- 4 settlements each needing 5+ oracle rolls plus a
// reveal/feature call, passages, zoom-in detail, a starting connection, and more -- before any
// actual narration even begins. At 8, a real "Begin the campaign" turn was hitting this cap
// before finishing sector generation, visible to the player as "Hit the tool-call iteration cap
// (8) without a final narration" on literally the very first message of a new campaign.
const MAX_TOOL_ITERATIONS = 60;

/**
 * Runs one full turn: sends `messages` (already including the new user message) to
 * OpenRouter, executes any tool calls the model makes against `campaignState`
 * (mutated in place), feeds the results back, and repeats until the model replies
 * with plain narration, calls present_choice (see below), or the iteration cap is hit.
 *
 * `onEvent(event)` is called for each step so the renderer can show live progress:
 *   { type: 'tool_call', name, args }
 *   { type: 'tool_result', name, result }
 *   { type: 'assistant_message', content }
 *   { type: 'error', message }
 *
 * Returns { messages, pendingChoice } -- messages is the full updated message list, ready to
 * be stored and reused as the conversation history for the next turn. pendingChoice is null on
 * a normal, complete turn; when the model calls present_choice, it's instead
 * { toolCallId, prompt, options, allowCustom } and `messages` ends with that tool_calls message
 * UNRESOLVED (no matching tool-role response yet) -- deliberately incomplete, since resolving it
 * requires the player's real answer, not something this function can supply on its own. The
 * caller (main.cjs's chat:send) must persist pendingChoice alongside messages and surface it to
 * the player; resuming (chat:resolve-choice) appends the real tool result for that toolCallId
 * and calls runTurn again to continue.
 */
async function runTurn({ apiKey, model, messages, campaignState, customAssets = [], imageGen = null, temperature = null, topP = null, onEvent = () => {} }) {
  const working = [...messages];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let response;
    try {
      const body = {
        model,
        messages: working,
        tools: TOOL_SCHEMAS,
      };
      // Only included when actually set -- omitting the key entirely lets the model use its own
      // default, rather than sending e.g. temperature: null/undefined, which some providers may
      // reject or treat unpredictably differently from the key just being absent.
      if (temperature !== null && temperature !== undefined) body.temperature = temperature;
      if (topP !== null && topP !== undefined) body.top_p = topP;
      response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/anthropics', // OpenRouter asks for an identifying referer; replace with your app's page if you have one.
          'X-Title': 'Starforged Solo GM',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      onEvent({ type: 'error', message: `Network error calling OpenRouter: ${err.message}` });
      throw err;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const message = `OpenRouter returned ${response.status}: ${bodyText.slice(0, 500)}`;
      onEvent({ type: 'error', message });
      throw new Error(message);
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    if (!choice) {
      const message = 'OpenRouter response had no choices.';
      onEvent({ type: 'error', message });
      throw new Error(message);
    }

    const assistantMessage = choice.message;
    working.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const content = assistantMessage.content || '';
      if (!content.trim()) {
        // The model returned nothing at all -- no narration, no tool calls. Silent to the
        // player otherwise, since an empty string is falsy and would just vanish from the chat
        // log with no explanation. Surface it as a real error, not a quiet no-op.
        onEvent({
          type: 'error',
          message: 'The AI returned an empty response -- no narration and no action taken. This can happen with some models/providers. Try sending your message again, or check your model selection in Settings.',
        });
      }
      onEvent({ type: 'assistant_message', content });
      return { messages: working, pendingChoice: null };
    }

    let pendingChoice = null;
    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      onEvent({ type: 'tool_call', name: call.function.name, args });

      if (call.function.name === 'present_choice') {
        // Deliberately does NOT go through executeTool -- there's no state to mutate here, only
        // a decision to hand to the player. No tool-role response is appended for this call: it
        // stays genuinely unresolved until chat:resolve-choice supplies the player's real
        // answer, which is the whole point (an LLM-fabricated "result" would just be the model
        // picking for the player again by another name). Any tool calls still remaining in this
        // same batch after this one are deliberately left unprocessed too -- the turn stops
        // here, not part-way through a batch that assumed the choice was already settled.
        pendingChoice = {
          toolCallId: call.id,
          prompt: args.prompt || 'Choose one:',
          options: Array.isArray(args.options) ? args.options : [],
          allowCustom: args.allow_custom !== false,
        };
        break;
      }

      let result;
      try {
        result = await executeTool(call.function.name, args, campaignState, customAssets, imageGen);
      } catch (err) {
        result = { error: err.message };
      }
      onEvent({ type: 'tool_result', name: call.function.name, result });

      working.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    if (pendingChoice) {
      return { messages: working, pendingChoice };
    }
    // Loop continues: send the tool results back to the model for narration or further moves.
  }

  const message = `Hit the tool-call iteration cap (${MAX_TOOL_ITERATIONS}) without a final narration. Returning as-is.`;
  onEvent({ type: 'error', message });
  return { messages: working, pendingChoice: null };
}

module.exports = { runTurn, OPENROUTER_URL, MAX_TOOL_ITERATIONS };
