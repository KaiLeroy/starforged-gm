'use strict';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Runs a campaign operation against an isolated copy. The caller receives the copy only after the
 * operation succeeds, so a thrown provider/tool error cannot leak partial mutations into the
 * live in-memory campaign record.
 */
async function runCampaignTransaction(record, operation) {
  const workingRecord = cloneJson(record);
  const value = await operation(workingRecord);
  return { record: workingRecord, value };
}

/** Serializes asynchronous mutations for each campaign without blocking unrelated campaigns. */
function createCampaignMutationQueue() {
  const tails = new Map();
  return function serialize(campaignId, operation) {
    const previous = tails.get(campaignId) || Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    tails.set(campaignId, tail);
    tail.finally(() => {
      if (tails.get(campaignId) === tail) tails.delete(campaignId);
    });
    return run;
  };
}

module.exports = { cloneJson, runCampaignTransaction, createCampaignMutationQueue };
