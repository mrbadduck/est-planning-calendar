import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskEndpoint, planWebhook, WEBHOOK_ACTIONS, WORKER_ORIGIN } from '../../scripts/eb-webhook.mjs';

const EP = `${WORKER_ORIGIN}/webhooks/eventbrite/s3cret`;

test('maskEndpoint hides the path secret', () => {
  assert.equal(maskEndpoint(EP), `${WORKER_ORIGIN}/webhooks/eventbrite/****`);
  assert.equal(maskEndpoint(EP + '/'), `${WORKER_ORIGIN}/webhooks/eventbrite/****`);
  assert.equal(maskEndpoint('https://example.com/hook'), 'https://example.com/hook');
  assert.equal(maskEndpoint(undefined), '');
});

test('planWebhook creates when no webhook points at the Worker', () => {
  const plan = planWebhook([{ id: '1', endpoint_url: 'https://zapier.com/hooks/x' }], EP);
  assert.equal(plan.action, 'create');
  assert.equal(plan.body.endpoint_url, EP);
  assert.equal(plan.body.actions, WEBHOOK_ACTIONS);
  assert.equal(WEBHOOK_ACTIONS, 'event.created,event.published,event.updated,event.unpublished');
});

test('planWebhook reports exists for any webhook on the same Worker endpoint, whatever the secret', () => {
  const plan = planWebhook([{ id: '7', endpoint_url: `${WORKER_ORIGIN}/webhooks/eventbrite/old` }], EP);
  assert.equal(plan.action, 'exists');
  assert.equal(plan.existing.id, '7');
});

test('planWebhook handles an empty or missing list', () => {
  assert.equal(planWebhook([], EP).action, 'create');
  assert.equal(planWebhook(undefined, EP).action, 'create');
});
