'use strict';
/**
 * Integration test for runTurn() using a mocked fetch, since we can't hit the real
 * OpenRouter API from this environment. This exercises the orchestration loop itself --
 * message construction, tool_call_id threading, multi-tool-call turns, error handling,
 * and the iteration cap -- none of which the per-function unit tests in __selftest__.cjs
 * actually cover, since they call executeTool() directly and never touch runTurn().
 */
const assert = require('assert');
const { runTurn, MAX_TOOL_ITERATIONS } = require('./openrouter.cjs');
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

function mockOk(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function mockFail(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

function assistantToolCallMsg(calls) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: calls.map((c, i) => ({
      id: `call_${i}_${c.name}`,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  };
}
function assistantTextMsg(text) {
  return { role: 'assistant', content: text };
}

(async () => {
  await check('single tool call then narration: correct message shape and event sequence', async () => {
    const cs = state.newCampaignState();
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) {
        return mockOk({ choices: [{ message: assistantToolCallMsg([{ name: 'roll_action_move', args: { move_name: 'Face Danger', stat: 'edge', stat_value: 2 } }]) }] });
      }
      return mockOk({ choices: [{ message: assistantTextMsg('You leap across the gap.') }] });
    };

    const events = [];
    const { messages } = await runTurn({
      apiKey: 'fake',
      model: 'fake-model',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'I leap across the gap' }],
      campaignState: cs,
      onEvent: (e) => events.push(e),
    });

    assert.strictEqual(call, 2, 'expected exactly two fetch calls');
    assert.deepStrictEqual(events.map((e) => e.type), ['tool_call', 'tool_result', 'assistant_message']);

    // Message shape must be valid to send back to the API on the next turn.
    assert.strictEqual(messages.length, 5); // system, user, assistant(tool_calls), tool, assistant(text)
    const [sys, user, asst1, toolMsg, asst2] = messages;
    assert.strictEqual(sys.role, 'system');
    assert.strictEqual(user.role, 'user');
    assert.strictEqual(asst1.role, 'assistant');
    assert.ok(Array.isArray(asst1.tool_calls) && asst1.tool_calls.length === 1);
    assert.strictEqual(toolMsg.role, 'tool');
    assert.strictEqual(toolMsg.tool_call_id, asst1.tool_calls[0].id, 'tool_call_id must match the call it answers');
    const parsedResult = JSON.parse(toolMsg.content);
    assert.ok(!parsedResult.error, 'the action roll itself should not error');
    assert.strictEqual(parsedResult.move.name, 'Face Danger');
    assert.strictEqual(asst2.role, 'assistant');
    assert.strictEqual(asst2.content, 'You leap across the gap.');

    // And the underlying campaign state actually changed (momentum, etc. depending on outcome).
    assert.ok(typeof cs.character.meters.momentum === 'number');
  });

  await check('multiple parallel tool calls in one assistant turn thread tool_call_id correctly', async () => {
    const cs = state.newCampaignState();
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) {
        return mockOk({
          choices: [
            {
              message: assistantToolCallMsg([
                { name: 'roll_oracle', args: { oracle_name: 'Action' } },
                { name: 'update_meter', args: { meter: 'supply', delta: -1 } },
              ]),
            },
          ],
        });
      }
      return mockOk({ choices: [{ message: assistantTextMsg('done') }] });
    };

    const { messages } = await runTurn({
      apiKey: 'fake',
      model: 'fake-model',
      messages: [{ role: 'user', content: 'test' }],
      campaignState: cs,
      onEvent: () => {},
    });

    const toolMsgs = messages.filter((m) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 2);
    const asst = messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.strictEqual(toolMsgs[0].tool_call_id, asst.tool_calls[0].id);
    assert.strictEqual(toolMsgs[1].tool_call_id, asst.tool_calls[1].id);
    assert.strictEqual(cs.character.meters.supply, 4, 'supply should have dropped by 1 from the mocked call');
  });

  await check('a tool call with bad arguments produces a tool error message, not a thrown exception', async () => {
    const cs = state.newCampaignState();
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) {
        // move_name that doesn't exist -- executeTool should return {error}, not throw.
        return mockOk({ choices: [{ message: assistantToolCallMsg([{ name: 'roll_action_move', args: { move_name: 'Nonexistent Move', stat: 'edge', stat_value: 2 } }]) }] });
      }
      return mockOk({ choices: [{ message: assistantTextMsg('ok') }] });
    };
    const { messages } = await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: () => {} });
    const toolMsg = messages.find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg.content);
    assert.ok(parsed.error, 'expected a clean error, not a crash');
  });

  await check('malformed JSON in tool_calls.function.arguments does not crash the loop', async () => {
    const cs = state.newCampaignState();
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) {
        return mockOk({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'earn_experience', arguments: '{not valid json' } }],
              },
            },
          ],
        });
      }
      return mockOk({ choices: [{ message: assistantTextMsg('ok') }] });
    };
    const { messages } = await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: () => {} });
    const toolMsg = messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'should still produce a tool result message even with malformed arguments');
  });

  await check('network error rejects and fires an error event', async () => {
    const cs = state.newCampaignState();
    global.fetch = async () => {
      throw new Error('ECONNRESET');
    };
    const events = [];
    await assert.rejects(() =>
      runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: (e) => events.push(e) })
    );
    assert.ok(events.some((e) => e.type === 'error' && /ECONNRESET/.test(e.message)));
  });

  await check('non-OK HTTP response rejects and fires an error event with the status', async () => {
    const cs = state.newCampaignState();
    global.fetch = async () => mockFail(401, 'Invalid API key');
    const events = [];
    await assert.rejects(() =>
      runTurn({ apiKey: 'bad-key', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: (e) => events.push(e) })
    );
    assert.ok(events.some((e) => e.type === 'error' && /401/.test(e.message)));
  });

  await check('a model that only ever calls tools hits the iteration cap and returns instead of looping forever', async () => {
    const cs = state.newCampaignState();
    let call = 0;
    global.fetch = async () => {
      call++;
      return mockOk({ choices: [{ message: assistantToolCallMsg([{ name: 'roll_oracle', args: { oracle_name: 'Action' } }]) }] });
    };
    const events = [];
    const { messages } = await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: (e) => events.push(e) });
    assert.strictEqual(call, MAX_TOOL_ITERATIONS, `expected exactly ${MAX_TOOL_ITERATIONS} fetch calls before bailing`);
    assert.ok(events.some((e) => e.type === 'error' && /iteration cap/.test(e.message)));
    assert.ok(messages.length > 0, 'should still return whatever history accumulated, not throw');
  });

  await check('assistant message with empty tool_calls array is treated as final narration, not another round', async () => {
    const cs = state.newCampaignState();
    let call = 0;
    global.fetch = async () => {
      call++;
      return mockOk({ choices: [{ message: { role: 'assistant', content: 'Fine.', tool_calls: [] } }] });
    };
    const { messages } = await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: () => {} });
    assert.strictEqual(call, 1, 'an empty tool_calls array should end the loop immediately, not be treated as truthy');
    assert.strictEqual(messages[messages.length - 1].content, 'Fine.');
  });

  await check('a genuinely empty final response (no narration, no tool calls) emits a visible error, not a silent no-op', async () => {
    const cs = state.newCampaignState();
    global.fetch = async () => mockOk({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [] } }] });
    const events = [];
    const { messages } = await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: (e) => events.push(e) });
    const errorEvent = events.find((e) => e.type === 'error');
    assert.ok(errorEvent, 'an empty response should emit a visible error event, not fail silently');
    assert.match(errorEvent.message, /empty response/i);
    assert.strictEqual(messages[messages.length - 1].content, '', 'the loop should still return normally (not throw) so the turn completes and the error is what surfaces');
  });

  await check('whitespace-only content is treated the same as genuinely empty, not as valid narration', async () => {
    const cs = state.newCampaignState();
    global.fetch = async () => mockOk({ choices: [{ message: { role: 'assistant', content: '   \n  ', tool_calls: [] } }] });
    const events = [];
    await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: (e) => events.push(e) });
    assert.ok(events.some((e) => e.type === 'error' && /empty response/i.test(e.message)), 'whitespace-only content should still trigger the empty-response error');
  });

  await check('null content with no tool calls (a genuinely malformed response) also surfaces as an error, not a crash', async () => {
    const cs = state.newCampaignState();
    global.fetch = async () => mockOk({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [] } }] });
    const events = [];
    await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: (e) => events.push(e) });
    assert.ok(events.some((e) => e.type === 'error' && /empty response/i.test(e.message)));
  });

  await check('temperature and top_p are omitted from the request body entirely when not set (null or simply absent), not sent as null/undefined', async () => {
    const cs = state.newCampaignState();
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return mockOk({ choices: [{ message: assistantTextMsg('ok') }] });
    };
    await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs });
    assert.ok(!('temperature' in capturedBody), 'temperature key should be entirely absent, not present as null');
    assert.ok(!('top_p' in capturedBody), 'top_p key should be entirely absent, not present as null');
  });

  await check('temperature and top_p are included in the request body with their real values when set, including temperature: 0 (a valid, meaningful value, not treated as falsy-and-therefore-unset)', async () => {
    const cs = state.newCampaignState();
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return mockOk({ choices: [{ message: assistantTextMsg('ok') }] });
    };
    await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, temperature: 0, topP: 0.9 });
    assert.strictEqual(capturedBody.temperature, 0);
    assert.strictEqual(capturedBody.top_p, 0.9);
  });

  await check('present_choice called alone pauses the turn: pendingChoice is populated correctly, the call never reaches executeTool (no tool-role response appended for it), and the transcript still gets a tool_call event for visibility', async () => {
    const cs = state.newCampaignState();
    global.fetch = async () => mockOk({ choices: [{ message: assistantToolCallMsg([{ name: 'present_choice', args: { prompt: 'How do you use your success?', options: [{ label: '+2 momentum' }, { label: 'Bonus on next move' }] } }]) }] });
    const events = [];
    const { messages, pendingChoice } = await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs, onEvent: (e) => events.push(e) });
    assert.strictEqual(pendingChoice.prompt, 'How do you use your success?');
    assert.strictEqual(pendingChoice.options.length, 2);
    assert.strictEqual(pendingChoice.allowCustom, true, 'should default to true when allow_custom is not specified');
    assert.strictEqual(messages[messages.length - 1].role, 'assistant', 'the unresolved tool_calls message should be the last thing in history');
    assert.ok(!messages.some((m) => m.role === 'tool'), 'no tool-role response should exist for present_choice yet');
    assert.ok(events.some((e) => e.type === 'tool_call' && e.name === 'present_choice'));
  });

  await check('present_choice bundled after a normal tool call in the same batch: the earlier call still executes for real (its result reaches campaignState) before the turn pauses, and the loop stops immediately rather than continuing to poll the model', async () => {
    const cs = state.newCampaignState();
    const startingMomentum = cs.character.meters.momentum;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return mockOk({
        choices: [{
          message: assistantToolCallMsg([
            { name: 'update_meter', args: { meter: 'momentum', delta: 2 } },
            { name: 'present_choice', args: { prompt: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] } },
          ]),
        }],
      });
    };
    const { messages, pendingChoice } = await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs });
    assert.notStrictEqual(cs.character.meters.momentum, startingMomentum, 'the normal call before present_choice should have actually executed');
    assert.strictEqual(messages.filter((m) => m.role === 'tool').length, 1, 'exactly one real tool result -- for the normal call, not present_choice');
    assert.strictEqual(fetchCalls, 1, 'the loop should stop at present_choice, not keep polling the model');
    assert.ok(pendingChoice);
  });

  await check('full pause -> resolve -> resume round trip (mirroring chat:send + chat:resolve-choice in main.cjs, which cannot be imported directly outside Electron): the player\'s real answer reaches the model as the tool result, and the turn completes normally from there', async () => {
    const cs = state.newCampaignState();
    let fetchCalls = 0;
    let capturedResumeBody = null;
    global.fetch = async (_url, opts) => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return mockOk({ choices: [{ message: assistantToolCallMsg([{ name: 'present_choice', args: { prompt: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] } }]) }] });
      }
      capturedResumeBody = JSON.parse(opts.body);
      return mockOk({ choices: [{ message: assistantTextMsg('You chose A, and the story continues.') }] });
    };

    const paused = await runTurn({ apiKey: 'fake', model: 'm', messages: [{ role: 'user', content: 'x' }], campaignState: cs });
    assert.ok(paused.pendingChoice);

    // Mirrors chat:resolve-choice's own resolution logic exactly: append a real tool-role
    // response for the pending choice's own tool_call_id using the player's answer.
    const resumedMessages = [...paused.messages, { role: 'tool', tool_call_id: paused.pendingChoice.toolCallId, content: JSON.stringify({ player_chose: 'A' }) }];

    const resumed = await runTurn({ apiKey: 'fake', model: 'm', messages: resumedMessages, campaignState: cs });
    assert.strictEqual(resumed.pendingChoice, null, 'the turn should complete normally after the choice is resolved');
    assert.strictEqual(resumed.messages[resumed.messages.length - 1].content, 'You chose A, and the story continues.');
    assert.ok(capturedResumeBody.messages.some((m) => m.role === 'tool' && m.content.includes('"player_chose":"A"')), 'the player\'s actual answer should have been sent to the model on resume');
  });

  await check('resolve-choice defensive handling for a tool call stranded after present_choice in the same batch (a model bundling calls despite the tool\'s own instruction not to): every tool_call ends up with a real response before resuming, keeping the conversation valid', async () => {
    // Mirrors chat:resolve-choice's own defensive logic in main.cjs directly, since that
    // function can't be imported outside Electron -- same approach already used elsewhere in
    // this project's test suite for other IPC-layer logic (see the undo checkpoint simulation
    // in __selftest__.cjs).
    const lastMessage = assistantToolCallMsg([
      { name: 'present_choice', args: { prompt: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] } },
      { name: 'update_meter', args: { meter: 'momentum', delta: 1 } }, // stranded -- comes after present_choice, never executed
    ]);
    const pending = { toolCallId: lastMessage.tool_calls[0].id };
    const messages = [{ role: 'user', content: 'x' }, lastMessage];

    const alreadyResolvedIds = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    const toolResults = [];
    for (const call of lastMessage.tool_calls) {
      if (alreadyResolvedIds.has(call.id)) continue;
      if (call.id === pending.toolCallId) {
        toolResults.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ player_chose: 'A' }) });
      } else {
        toolResults.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'Skipped -- a player choice had to be resolved first.' }) });
      }
    }

    assert.strictEqual(toolResults.length, 2, 'both tool_calls in the batch should get a response, not just the pending one');
    const allCallIds = new Set(lastMessage.tool_calls.map((c) => c.id));
    const allResolvedIds = new Set(toolResults.map((r) => r.tool_call_id));
    assert.deepStrictEqual(allCallIds, allResolvedIds, 'every single tool_call_id from the batch must end up with a matching response');
    const strandedResult = toolResults.find((r) => r.tool_call_id !== pending.toolCallId);
    assert.ok(JSON.parse(strandedResult.content).error.includes('Skipped'));
  });

  console.log(`\n${passed}/${total} checks passed.`);
  if (process.exitCode) console.error('SOME CHECKS FAILED -- see above.');
})();
