import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../server/signaling.mjs';

export function memoryStore() {
  const entries = new Map();
  let version = 0;
  return {
    async getWithMetadata(key) { return structuredClone(entries.get(key) || null); },
    async setJSON(key, data, options = {}) {
      const previous = entries.get(key);
      if ((options.onlyIfNew && previous) || (options.onlyIfMatch && previous?.etag !== options.onlyIfMatch)) return { modified: false };
      entries.set(key, { data: structuredClone(data), etag: String(++version) });
      return { modified: true };
    }
  };
}

function setup() {
  let time = 1000000;
  const handler = makeHandler(memoryStore(), () => time);
  const call = async (data, key = '', origin = 'https://site.test') => {
    const response = await handler(new Request('https://site.test/.netlify/functions/signal', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: key, origin }, body: JSON.stringify(data)
    }));
    return { status: response.status, ...(await response.json()) };
  };
  return { call, advance: duration => { time += duration; } };
}
const offer = 'v=0\r\nexample offer';
const answer = 'v=0\r\nexample answer';
const join = 'AAAAAAAAAAAAAAAA';

test('guest exchanges descriptions automatically; host credentials stay private', async () => {
  const { call } = setup();
  const { room, hostKey } = await call({ action: 'create' });
  assert.equal(room.length, 16);
  assert.equal((await call({ action: 'join', room, join, offer })).status, 200);
  assert.equal((await call({ action: 'poll', room })).status, 403);
  assert.equal((await call({ action: 'answer', room, join, answer })).status, 403);
  const pending = await call({ action: 'poll', room }, hostKey);
  assert.equal(pending.joins[0].offer, offer);
  assert.equal(pending.hostKey, undefined);
  assert.equal((await call({ action: 'wait', room, join })).answer, null);
  await call({ action: 'answer', room, join, answer }, hostKey);
  assert.equal((await call({ action: 'wait', room, join })).answer, answer);
  await call({ action: 'connected', room, join }, hostKey);
  assert.deepEqual((await call({ action: 'poll', room }, hostKey)).joins, []);
  await call({ action: 'release', room, join }, hostKey);
  assert.equal((await call({ action: 'wait', room, join })).status, 410);
});
test('concurrent joins cannot exceed seven guests', async () => {
  const { call } = setup();
  const { room } = await call({ action: 'create' });
  for (let index = 0; index < 6; index++) await call({ action: 'join', room, join: `AAAAAAAAAAAAAAA${index}`, offer });
  const responses = await Promise.all([6, 7].map(index => call({ action: 'join', room, join: `AAAAAAAAAAAAAAA${index}`, offer })));
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
});
test('expired connections free slots; absent host stops new admission', async () => {
  const { call, advance } = setup();
  const { room, hostKey } = await call({ action: 'create' });
  await call({ action: 'join', room, join, offer });
  advance(130000);
  assert.equal((await call({ action: 'join', room, join, offer })).status, 410);
  await call({ action: 'poll', room }, hostKey);
  assert.equal((await call({ action: 'join', room, join, offer })).status, 200);
});
test('expired room cannot be revived', async () => {
  const { call, advance } = setup();
  const { room, hostKey } = await call({ action: 'create' });
  advance(6 * 3600000);
  assert.equal((await call({ action: 'poll', room }, hostKey)).status, 410);
});
test('reject cross-origin creation and malformed SDP', async () => {
  const { call } = setup();
  assert.equal((await call({ action: 'create' }, '', 'https://other.test')).status, 403);
  const { room } = await call({ action: 'create' });
  assert.equal((await call({ action: 'join', room, join, offer: 'bad' })).status, 400);
});
