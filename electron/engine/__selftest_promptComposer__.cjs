'use strict';
/**
 * Integration test for the AI image-prompt composer (promptComposer.cjs), using a mocked fetch
 * since we can't hit the real OpenRouter API from this environment. Covers: each of the four
 * "kind" branches produces the right request content from real-shaped context, an entirely
 * empty context still produces a usable request rather than throwing, and both real-world error
 * cases (empty response, non-OK HTTP status) surface as clear errors rather than silently
 * returning garbage.
 */
const assert = require('assert');
const { composeImagePrompt } = require('./promptComposer.cjs');

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

function mockOk(text) {
  return async (_url, opts) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }] }),
    _capturedOpts: opts,
  });
}

(async () => {
  console.log('Verifying AI-composed image prompts pull from real campaign context (character description, notable assets, connection role, location features, recent story) rather than the old, fixed JS string templates -- requested directly, alongside the earlier fix ensuring the Illustrations panel specifically was never left with a genuinely empty prompt.');

  await check('portrait: request content includes name, description, and asset names from context', async () => {
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'a result' } }] }) };
    };
    await composeImagePrompt({
      apiKey: 'x',
      model: 'm',
      kind: 'portrait',
      context: { name: 'Kael', description: 'a grizzled ex-soldier', pronouns: 'he/him', assetNames: ['Gunslinger', 'Armored'], recentStory: 'Fled a burning outpost.' },
    });
    const userContent = capturedBody.messages[1].content;
    assert.ok(userContent.includes('Kael'));
    assert.ok(userContent.includes('grizzled ex-soldier'));
    assert.ok(userContent.includes('Gunslinger, Armored'));
    assert.ok(userContent.includes('burning outpost'));
  });

  await check('connection: request content includes name, role, and notes from context', async () => {
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'a result' } }] }) };
    };
    await composeImagePrompt({ apiKey: 'x', model: 'm', kind: 'connection', context: { name: 'Vess', role: 'Merchant', notes: 'a shady dealer' } });
    const userContent = capturedBody.messages[1].content;
    assert.ok(userContent.includes('Vess'));
    assert.ok(userContent.includes('Role: Merchant'));
    assert.ok(userContent.includes('shady dealer'));
  });

  await check('location: request content includes name, features, and sector notes from context', async () => {
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'a result' } }] }) };
    };
    await composeImagePrompt({
      apiKey: 'x',
      model: 'm',
      kind: 'location',
      context: { name: 'Hollow Reach', features: ['settlement: Ashen Hollow', 'derelict: The Wreck'], sectorNotes: 'a war-torn frontier' },
    });
    const userContent = capturedBody.messages[1].content;
    assert.ok(userContent.includes('Hollow Reach'));
    assert.ok(userContent.includes('settlement: Ashen Hollow, derelict: The Wreck'));
    assert.ok(userContent.includes('war-torn frontier'));
  });

  await check('illustration: request content includes recent story and character context', async () => {
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'a result' } }] }) };
    };
    await composeImagePrompt({ apiKey: 'x', model: 'm', kind: 'illustration', context: { recentStory: 'The crew fled a burning outpost.', characterName: 'Kael', characterDescription: 'a grizzled ex-soldier' } });
    const userContent = capturedBody.messages[1].content;
    assert.ok(userContent.includes('burning outpost'));
    assert.ok(userContent.includes('Kael'));
  });

  await check('an entirely empty context still produces a valid request rather than throwing, falling back to "unnamed"', async () => {
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'a generic result' } }] }) };
    };
    const result = await composeImagePrompt({ apiKey: 'x', model: 'm', kind: 'portrait', context: {} });
    assert.strictEqual(result, 'a generic result');
    assert.ok(capturedBody.messages[1].content.includes('Name: unnamed'));
    assert.ok(capturedBody.messages[1].content.includes('Ironsworn: Starforged'));
  });

  await check('surrounding whitespace on the response is trimmed off', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '  a padded result  \n' } }] }) });
    const result = await composeImagePrompt({ apiKey: 'x', model: 'm', kind: 'portrait', context: {} });
    assert.strictEqual(result, 'a padded result');
  });

  await check('a whitespace-only response is rejected as genuinely empty, not returned as a blank prompt', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '   ' } }] }) });
    await assert.rejects(() => composeImagePrompt({ apiKey: 'x', model: 'm', kind: 'portrait', context: {} }), /empty response/);
  });

  await check('a non-OK HTTP response surfaces a clear error including the status code, not a generic failure', async () => {
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    await assert.rejects(() => composeImagePrompt({ apiKey: 'x', model: 'm', kind: 'portrait', context: {} }), /429/);
  });

  await check('temperature and top_p are included in the request body when set, and omitted entirely (not sent as null) when not -- matching the same convention the main GM conversation call already uses', async () => {
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'a result' } }] }) };
    };
    await composeImagePrompt({ apiKey: 'x', model: 'm', kind: 'portrait', context: {}, temperature: 0.9, topP: 0.8 });
    assert.strictEqual(capturedBody.temperature, 0.9);
    assert.strictEqual(capturedBody.top_p, 0.8);

    await composeImagePrompt({ apiKey: 'x', model: 'm', kind: 'portrait', context: {} });
    assert.ok(!('temperature' in capturedBody), 'temperature key should be entirely absent when not set, not present as null');
    assert.ok(!('top_p' in capturedBody), 'top_p key should be entirely absent when not set, not present as null');
  });

  console.log(`\n${passed}/${total} checks passed.`);
  if (process.exitCode) console.error('SOME CHECKS FAILED -- see above.');
})();
