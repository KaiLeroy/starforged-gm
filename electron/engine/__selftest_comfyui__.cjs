'use strict';
/**
 * Tests for comfyui.cjs using a mocked fetch, since there's no real ComfyUI server reachable
 * from this environment (or most CI environments). Covers workflow templating (the part most
 * likely to break silently against a real user's exported workflow) and the full submit/poll/
 * fetch HTTP flow.
 */
const assert = require('assert');
const comfyui = require('./comfyui.cjs');

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

function mockOk(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
}
function mockFail(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

(async () => {
  console.log('prepareWorkflow');

  await check('throws with no workflow template configured', () => {
    assert.throws(() => comfyui.prepareWorkflow(null, 'a cat'), /No workflow template configured/);
  });

  await check('throws when the {{PROMPT}} placeholder is missing', () => {
    const template = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a fixed prompt with no placeholder' } } };
    assert.throws(() => comfyui.prepareWorkflow(template, 'a cat'), /no.*PROMPT.*placeholder/i);
  });

  await check('replaces the placeholder wherever it appears, including nested deep in the graph', () => {
    const template = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'photo of {{PROMPT}}, cinematic lighting' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality' } }, // negative prompt, untouched
      '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'sf_{{PROMPT}}_output' } },
    };
    const result = comfyui.prepareWorkflow(template, 'a cyberpunk pilot');
    assert.strictEqual(result['1'].inputs.text, 'photo of a cyberpunk pilot, cinematic lighting');
    assert.strictEqual(result['2'].inputs.text, 'blurry, low quality');
    assert.strictEqual(result['3'].inputs.filename_prefix, 'sf_a cyberpunk pilot_output');
  });

  await check('does not mutate the original template object', () => {
    const template = { '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{PROMPT}}' } } };
    comfyui.prepareWorkflow(template, 'a planet');
    assert.strictEqual(template['1'].inputs.text, '{{PROMPT}}', 'original template should be untouched (deep clone)');
  });

  await check('randomizes the seed on recognizable sampler nodes', () => {
    const template = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{PROMPT}}' } },
      '2': { class_type: 'KSampler', inputs: { seed: 12345, steps: 20 } },
    };
    const r1 = comfyui.prepareWorkflow(template, 'x');
    const r2 = comfyui.prepareWorkflow(template, 'x');
    assert.notStrictEqual(r1['2'].inputs.seed, 12345, 'seed should be randomized away from the template value');
    assert.notStrictEqual(r1['2'].inputs.seed, r2['2'].inputs.seed, 'two separate calls should get different random seeds');
    assert.strictEqual(r1['2'].inputs.steps, 20, 'non-seed sampler fields should be left alone');
  });

  console.log('testConnection');

  await check('resolves with system stats on success', async () => {
    global.fetch = async (url) => {
      assert.ok(url.endsWith('/system_stats'));
      return mockOk({ system: { comfyui_version: '0.1' } });
    };
    const stats = await comfyui.testConnection('http://127.0.0.1:8188');
    assert.strictEqual(stats.system.comfyui_version, '0.1');
  });

  await check('rejects with a clear message on network failure', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.rejects(() => comfyui.testConnection('http://127.0.0.1:8188'), /Could not reach ComfyUI.*ECONNREFUSED/);
  });

  await check('rejects on a non-OK HTTP response', async () => {
    global.fetch = async () => mockFail(500, 'internal error');
    await assert.rejects(() => comfyui.testConnection('http://127.0.0.1:8188'), /HTTP 500/);
  });

  await check('strips trailing slashes from the base URL', async () => {
    let calledUrl = null;
    global.fetch = async (url) => {
      calledUrl = url;
      return mockOk({});
    };
    await comfyui.testConnection('http://127.0.0.1:8188///');
    assert.strictEqual(calledUrl, 'http://127.0.0.1:8188/system_stats');
  });

  console.log('generateImage (full submit/poll/fetch flow)');

  const workingTemplate = { '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{PROMPT}}' } } };

  await check('happy path: submits, polls until output appears, fetches and returns the image bytes', async () => {
    let call = 0;
    global.fetch = async (url, opts) => {
      call++;
      if (call === 1) {
        assert.ok(url.endsWith('/prompt'));
        assert.strictEqual(opts.method, 'POST');
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.prompt['1'].inputs.text, 'a red planet');
        return mockOk({ prompt_id: 'abc123' });
      }
      if (call === 2) {
        // First poll: still running, no outputs yet.
        assert.ok(url.includes('/history/abc123'));
        return mockOk({ abc123: { status: { status_str: 'running' }, outputs: {} } });
      }
      if (call === 3) {
        // Second poll: done.
        assert.ok(url.includes('/history/abc123'));
        return mockOk({ abc123: { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
      }
      // Fourth call: fetching the actual image bytes via /view.
      assert.ok(url.includes('/view'));
      assert.ok(url.includes('filename=out.png'));
      return mockOk({});
    };
    const buffer = await comfyui.generateImage({ baseUrl: 'http://127.0.0.1:8188', workflowTemplate: workingTemplate, prompt: 'a red planet', timeoutMs: 10000 });
    assert.ok(Buffer.isBuffer(buffer));
    assert.strictEqual(buffer.length, 4);
    assert.strictEqual(call, 4);
  });

  await check('throws a clean error if ComfyUI rejects the workflow', async () => {
    global.fetch = async () => mockFail(400, 'invalid workflow: missing node');
    await assert.rejects(
      () => comfyui.generateImage({ baseUrl: 'http://127.0.0.1:8188', workflowTemplate: workingTemplate, prompt: 'x' }),
      /rejected the workflow.*400/
    );
  });

  await check('throws a clean error if ComfyUI reports a generation error mid-run', async () => {
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) return mockOk({ prompt_id: 'err1' });
      return mockOk({ err1: { status: { status_str: 'error' }, outputs: {} } });
    };
    await assert.rejects(
      () => comfyui.generateImage({ baseUrl: 'http://127.0.0.1:8188', workflowTemplate: workingTemplate, prompt: 'x', timeoutMs: 10000 }),
      /ComfyUI reported an error/
    );
  });

  await check('times out cleanly rather than hanging forever if nothing ever completes', async () => {
    global.fetch = async (url) => {
      if (url.endsWith('/prompt')) return mockOk({ prompt_id: 'never-done' });
      return mockOk({ 'never-done': { status: { status_str: 'running' }, outputs: {} } });
    };
    await assert.rejects(
      () => comfyui.generateImage({ baseUrl: 'http://127.0.0.1:8188', workflowTemplate: workingTemplate, prompt: 'x', timeoutMs: 100 }),
      /Timed out/
    );
  });

  await check('rejects if no prompt_id comes back from the submit call', async () => {
    global.fetch = async () => mockOk({});
    await assert.rejects(
      () => comfyui.generateImage({ baseUrl: 'http://127.0.0.1:8188', workflowTemplate: workingTemplate, prompt: 'x' }),
      /did not return a prompt_id/
    );
  });

  console.log(`\n${passed}/${total} checks passed.`);
  if (process.exitCode) console.error('SOME CHECKS FAILED -- see above.');
})();
