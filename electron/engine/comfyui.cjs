'use strict';

const DEFAULT_TIMEOUT_MS = 180000; // local image gen is hardware-dependent; 3 minutes is a generous ceiling
const POLL_INTERVAL_MS = 1500;
const PLACEHOLDER = '{{PROMPT}}';

function randomSeed() {
  // ComfyUI seeds are typically handled as up-to-64-bit integers; stay well within safe JS integer range.
  return Math.floor(Math.random() * 1e15);
}

const SAMPLER_CLASS_TYPES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);
const SEED_FIELD_NAMES = ['seed', 'noise_seed'];

/**
 * Deep-clones the workflow template, replaces every occurrence of the {{PROMPT}} placeholder
 * (in any string field, anywhere in the graph) with the real prompt text, and randomizes the
 * seed on any recognizable sampler node so repeated generations don't come out identical.
 * Throws if the placeholder is never found -- that's a config problem worth surfacing clearly
 * rather than silently generating whatever the template's default prompt was.
 */
function prepareWorkflow(workflowTemplate, prompt) {
  if (!workflowTemplate || typeof workflowTemplate !== 'object') {
    throw new Error('No workflow template configured. Export a workflow from ComfyUI in API format and paste it into Settings.');
  }
  const workflow = JSON.parse(JSON.stringify(workflowTemplate));
  let sawPlaceholder = false;

  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (typeof val === 'string' && val.includes(PLACEHOLDER)) {
          sawPlaceholder = true;
          node[key] = val.split(PLACEHOLDER).join(prompt);
        } else {
          walk(val);
        }
      }
      if (typeof node.class_type === 'string' && SAMPLER_CLASS_TYPES.has(node.class_type) && node.inputs) {
        for (const f of SEED_FIELD_NAMES) {
          if (f in node.inputs) node.inputs[f] = randomSeed();
        }
      }
    }
  }
  walk(workflow);

  if (!sawPlaceholder) {
    throw new Error(
      `The workflow template has no ${PLACEHOLDER} placeholder. Add it to the text field of your positive-prompt ` +
        'node (e.g. a CLIPTextEncode node\'s "text" input) in the exported workflow JSON, then save Settings again.'
    );
  }
  return workflow;
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) throw new Error('No ComfyUI server URL configured.');
  return baseUrl.replace(/\/+$/, '');
}

/** Quick reachability check for a "Test Connection" button -- hits ComfyUI's system_stats endpoint. */
async function testConnection(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  let res;
  try {
    res = await fetch(`${base}/system_stats`);
  } catch (err) {
    throw new Error(`Could not reach ComfyUI at ${base}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`ComfyUI at ${base} returned HTTP ${res.status}.`);
  return res.json();
}

/**
 * Submits the workflow, polls /history until the image is ready (or times out), fetches the
 * raw image bytes via /view. Returns a Buffer -- the caller decides where to save it.
 */
async function generateImage({ baseUrl, workflowTemplate, prompt, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = () => {} }) {
  const base = normalizeBaseUrl(baseUrl);
  const workflow = prepareWorkflow(workflowTemplate, prompt);
  const clientId = `sfgm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  onProgress('Submitting to ComfyUI…');
  let submitRes;
  try {
    submitRes = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
  } catch (err) {
    throw new Error(`Could not reach ComfyUI at ${base}: ${err.message}`);
  }
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '');
    throw new Error(`ComfyUI rejected the workflow (HTTP ${submitRes.status}): ${text.slice(0, 500)}`);
  }
  const submitData = await submitRes.json();
  const promptId = submitData.prompt_id;
  if (!promptId) throw new Error('ComfyUI accepted the request but did not return a prompt_id.');

  onProgress('Generating…');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let hist;
    try {
      const histRes = await fetch(`${base}/history/${promptId}`);
      if (!histRes.ok) continue;
      hist = await histRes.json();
    } catch {
      continue; // transient -- keep polling until the timeout
    }
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status && entry.status.status_str === 'error') {
      throw new Error('ComfyUI reported an error generating the image -- check the ComfyUI console/log for details.');
    }
    const outputs = entry.outputs || {};
    for (const nodeId of Object.keys(outputs)) {
      const images = outputs[nodeId].images;
      if (images && images.length > 0) {
        const img = images[0];
        onProgress('Fetching image…');
        const viewUrl = `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
        const imgRes = await fetch(viewUrl);
        if (!imgRes.ok) throw new Error(`ComfyUI generated the image but it couldn't be fetched (HTTP ${imgRes.status}).`);
        const arrayBuffer = await imgRes.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
    }
  }
  throw new Error(`Timed out waiting for ComfyUI after ${Math.round(timeoutMs / 1000)}s. It may still be generating -- check the ComfyUI window.`);
}

module.exports = { prepareWorkflow, testConnection, generateImage, randomSeed, PLACEHOLDER };
