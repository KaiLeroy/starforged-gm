'use strict';
/**
 * Integration test for the multi-layer context summarizer (summarizer.cjs), using a mocked
 * fetch since we can't hit the real OpenRouter API from this environment. Covers: narrative
 * extraction filtering, both compaction tiers, the multi-batch while-loop (not just a single
 * pass), threshold boundaries, and that a failed summarization call never corrupts state or
 * blocks the turn it happened during.
 */
const assert = require('assert');
const summarizer = require('./summarizer.cjs');
const state = require('./state.cjs');

let passed = 0;
let total = 0;
async function check(label, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${label}`);
  } catch (err) {
    console.error(`FAIL  - ${label}\n        ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

function fakeMessages(count) {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i} with narrative content.` });
  }
  return msgs;
}

function mockSummarizerFetch(responseText) {
  return async (url, opts) => {
    assert.strictEqual(url, summarizer.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.messages[0].role, 'system');
    assert.strictEqual(body.messages[1].role, 'user');
    return { ok: true, json: async () => ({ choices: [{ message: { content: responseText } }] }) };
  };
}

(async () => {
  await check('extractNarrativeText keeps user and assistant prose, discards tool_calls/tool-role plumbing', async () => {
    const mixed = [
      { role: 'user', content: 'I attack the pirate.' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1' }] },
      { role: 'tool', content: '{"outcome":"strong_hit"}' },
      { role: 'assistant', content: 'You strike true, the pirate staggers back.' },
    ];
    const text = summarizer.extractNarrativeText(mixed);
    assert.ok(text.includes('I attack the pirate.'));
    assert.ok(text.includes('You strike true'));
    assert.ok(!text.includes('outcome'), 'tool result JSON should not leak into the narrative extraction');
    assert.ok(!text.includes('strong_hit'));
  });

  await check('extractNarrativeText returns empty string for an all-mechanical batch (no user/assistant prose at all)', async () => {
    const allMechanical = [
      { role: 'assistant', content: null, tool_calls: [{ id: '1' }] },
      { role: 'tool', content: 'result' },
    ];
    assert.strictEqual(summarizer.extractNarrativeText(allMechanical), '');
  });

  await check('maybeCompact is a complete no-op without an API key, regardless of message count', async () => {
    const cs = state.newCampaignState();
    const record = { messages: fakeMessages(500) };
    const result = await summarizer.maybeCompact({ apiKey: null, model: 'm', record, campaignState: cs });
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(record.messages.length, 500);
    assert.deepStrictEqual(cs.storySummary, { recent: '', distant: '' });
  });

  await check('maybeCompact is a no-op below the threshold', async () => {
    const cs = state.newCampaignState();
    const record = { messages: fakeMessages(50) };
    global.fetch = async () => {
      throw new Error('fetch should not be called below the threshold');
    };
    const result = await summarizer.maybeCompact({ apiKey: 'fake', model: 'm', record, campaignState: cs });
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(record.messages.length, 50);
  });

  await check('crossing the threshold triggers Tier 1: oldest batch summarized and removed, newest messages left verbatim', async () => {
    const cs = state.newCampaignState();
    const record = { messages: fakeMessages(95) }; // just over RECENT_WINDOW_MESSAGES(60) + SUMMARIZE_BATCH_SIZE(30) = 90
    const originalNewest = record.messages.slice(-10);
    global.fetch = mockSummarizerFetch('A condensed recap.');
    const result = await summarizer.maybeCompact({ apiKey: 'fake', model: 'm', record, campaignState: cs });
    assert.strictEqual(result.compacted, true);
    assert.strictEqual(record.messages.length, 65, '95 - one batch of 30 = 65');
    assert.deepStrictEqual(record.messages.slice(-10), originalNewest, 'the newest messages must survive completely untouched');
    assert.strictEqual(cs.storySummary.recent, 'A condensed recap.');
  });

  await check('a large backlog compacts in a loop, not just a single pass, until back under threshold', async () => {
    const cs = state.newCampaignState();
    const record = { messages: fakeMessages(130) };
    let callCount = 0;
    global.fetch = async (url, opts) => {
      callCount++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: `Recap batch ${callCount}.` } }] }) };
    };
    const result = await summarizer.maybeCompact({ apiKey: 'fake', model: 'm', record, campaignState: cs });
    assert.strictEqual(result.compacted, true);
    assert.ok(callCount >= 2, `expected multiple summarization calls for a large backlog, got ${callCount}`);
    assert.ok(record.messages.length <= summarizer.RECENT_WINDOW_MESSAGES + summarizer.SUMMARIZE_BATCH_SIZE);
  });

  await check('successive batches accumulate into the recent summary rather than overwriting it', async () => {
    const cs = state.newCampaignState();
    cs.storySummary.recent = 'Earlier events.';
    const record = { messages: fakeMessages(95) };
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.ok(body.messages[1].content.includes('Earlier events.'), 'the existing recent summary should be fed back in as context for the new batch');
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Earlier events, plus the new batch.' } }] }) };
    };
    await summarizer.maybeCompact({ apiKey: 'fake', model: 'm', record, campaignState: cs });
    assert.strictEqual(cs.storySummary.recent, 'Earlier events, plus the new batch.');
  });

  await check('Tier 2 triggers once the recent summary exceeds the distant-compaction threshold, and resets recent to empty', async () => {
    const cs = state.newCampaignState();
    const record = { messages: fakeMessages(95) };
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const isDistantCall = body.messages[0].content.includes('long-term');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: isDistantCall ? 'A compact long-term recap.' : 'x'.repeat(summarizer.DISTANT_COMPACT_THRESHOLD + 500) } }] }),
      };
    };
    const result = await summarizer.maybeCompact({ apiKey: 'fake', model: 'm', record, campaignState: cs });
    assert.strictEqual(result.compacted, true);
    assert.strictEqual(cs.storySummary.recent, '', 'recent should be reset to empty once folded into distant');
    assert.strictEqual(cs.storySummary.distant, 'A compact long-term recap.');
  });

  await check('a network failure during summarization leaves messages and storySummary completely untouched, and does not throw', async () => {
    const cs = state.newCampaignState();
    const record = { messages: fakeMessages(95) };
    const before = record.messages.length;
    global.fetch = async () => {
      throw new Error('network unreachable');
    };
    const result = await summarizer.maybeCompact({ apiKey: 'fake', model: 'm', record, campaignState: cs });
    assert.strictEqual(result.compacted, false);
    assert.ok(result.error);
    assert.strictEqual(record.messages.length, before);
    assert.deepStrictEqual(cs.storySummary, { recent: '', distant: '' });
  });

  await check('a non-OK HTTP response (bad key, rate limit, etc.) is handled the same way -- no throw, no corruption', async () => {
    const cs = state.newCampaignState();
    const record = { messages: fakeMessages(95) };
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const result = await summarizer.maybeCompact({ apiKey: 'fake', model: 'm', record, campaignState: cs });
    assert.strictEqual(result.compacted, false);
    assert.ok(result.error.includes('401'));
    assert.strictEqual(record.messages.length, 95);
  });

  await check('an empty or whitespace-only summarizer response is treated as a failure, not accepted as a valid (empty) summary', async () => {
    const cs = state.newCampaignState();
    const record = { messages: fakeMessages(95) };
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '   ' } }] }) });
    const result = await summarizer.maybeCompact({ apiKey: 'fake', model: 'm', record, campaignState: cs });
    assert.strictEqual(result.compacted, false);
    assert.ok(result.error);
    assert.strictEqual(record.messages.length, 95);
  });

  console.log(`\n${passed}/${total} checks passed.`);
  if (process.exitCode) console.error('SOME CHECKS FAILED -- see above.');
})();
