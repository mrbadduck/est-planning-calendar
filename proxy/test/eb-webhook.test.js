import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDevVars, maskEndpoint, planWebhook, WEBHOOK_ACTIONS, WORKER_ORIGIN } from '../../scripts/eb-webhook.mjs';

const EP = `${WORKER_ORIGIN}/webhooks/eventbrite/s3cret`;

test('maskEndpoint hides the path secret', () => {
  assert.equal(maskEndpoint(EP), `${WORKER_ORIGIN}/webhooks/eventbrite/****`);
  assert.equal(maskEndpoint(EP + '/'), `${WORKER_ORIGIN}/webhooks/eventbrite/****`);
  assert.equal(maskEndpoint('https://example.com/hook'), 'https://example.com/…');
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

test('maskEndpoint shows third-party webhooks as host only', () => {
  assert.equal(maskEndpoint('https://hooks.zapier.com/hooks/catch/1/tok/'), 'https://hooks.zapier.com/\u2026');
});

test('parseDevVars strips inline comments from unquoted values, keeps quoted ones', () => {
  const v = parseDevVars('# c\nA=abc   # note\nB="x # y"\r\nC = \'q\'\nD=has#hash\n');
  assert.equal(v.A, 'abc');
  assert.equal(v.B, 'x # y');
  assert.equal(v.C, 'q');
  assert.equal(v.D, 'has#hash');
  assert.equal(v['# c'], undefined);
});

test('parseDevVars: an empty value followed by a comment is empty', () => {
  const v = parseDevVars('EB_WEBHOOK_SECRET=   # set me\nB=#only\nC=x #note\n');
  assert.equal(v.EB_WEBHOOK_SECRET, '');
  assert.equal(v.B, '');
  assert.equal(v.C, 'x');
});
