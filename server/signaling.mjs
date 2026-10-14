import { createHash, randomBytes } from 'node:crypto';

const ROOM_TTL = 6 * 60 * 60 * 1000;
const JOIN_TTL = 2 * 60 * 1000;
const idPattern = /^[A-Za-z0-9_-]{16}$/;
const token = () => randomBytes(12).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const validSDP = value => typeof value === 'string' && value.length <= 25000 && value.startsWith('v=0\r\n');

export function makeHandler(store, now = Date.now) {
  return async request => {
    try {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) {
        return json({ error: 'Forbidden origin' }, 403);
      }
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'JSON required' }, 415);
      const text = await request.text();
      if (text.length > 28000) return json({ error: 'Request too large' }, 413);
      let input;
      try { input = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!input || typeof input !== 'object') return json({ error: 'Invalid request' }, 400);
      const timestamp = now();
      if (input.action === 'create') {
        const room = token();
        const hostKey = randomBytes(24).toString('base64url');
        await store.setJSON(`room/${room}`, { hostHash: digest(hostKey), expires: timestamp + ROOM_TTL,
          seen: timestamp, joins: [] }, { onlyIfNew: true });
        return json({ room, hostKey });
      }
      if (!idPattern.test(input.room || '')) return json({ error: 'Invalid room' }, 400);
      const key = `room/${input.room}`;
      // A single compare-and-swap document prevents two guests from taking the last slot.
      for (let attempt = 0; attempt < 5; attempt++) {
        const entry = await store.getWithMetadata(key, { type: 'json' });
        if (!entry || entry.data.expires <= timestamp) fail(410, 'Комната закрыта. Попросите новую ссылку.');
        const room = entry.data;
        const host = digest(request.headers.get('authorization') || '') === room.hostHash;
        const joins = room.joins.filter(join => join.expires > timestamp);
        const join = joins.find(value => value.id === input.join);
        let result;
        let changed = joins.length !== room.joins.length;
        room.joins = joins;
        switch (input.action) {
          case 'poll':
            if (!host) fail(403, 'Нет доступа к управлению комнатой.');
            if (timestamp - room.seen > 20000) { room.seen = timestamp; changed = true; }
            result = { joins: joins.filter(value => !value.answer && !value.connected) };
            break;
          case 'join':
            if (timestamp - room.seen > 90000) fail(410, 'Ведущий недоступен. Он должен открыть комнату.');
            if (!idPattern.test(input.join || '') || !validSDP(input.offer)) fail(400, 'Некорректное приглашение.');
            if (!join) {
              if (joins.length >= 7) fail(409, 'В комнате уже 8 зрителей или идут подключения.');
              joins.push({ id: input.join, offer: input.offer, expires: timestamp + JOIN_TTL });
              changed = true;
            }
            result = { accepted: true };
            break;
          case 'answer':
            if (!host) fail(403, 'Нет доступа к управлению комнатой.');
            if (!join) fail(410, 'Подключение истекло.');
            if (!validSDP(input.answer)) fail(400, 'Некорректный ответ.');
            join.answer = input.answer;
            changed = true;
            result = { accepted: true };
            break;
          case 'wait':
            if (!join) fail(410, 'Подключение истекло. Откройте ссылку снова.');
            result = { answer: join.answer || null };
            break;
          case 'connected':
          case 'release':
            if (!host) fail(403, 'Нет доступа к управлению комнатой.');
            if (join) {
              if (input.action === 'release') room.joins = joins.filter(value => value !== join);
              else { delete join.offer; delete join.answer; join.connected = true; join.expires = room.expires; }
              changed = true;
            }
            result = { accepted: true };
            break;
          default: fail(400, 'Unknown action');
        }
        if (!changed) return json(result);
        const write = await store.setJSON(key, room, { onlyIfMatch: entry.etag });
        if (write.modified) return json(result);
      }
      return json({ error: 'Повторите подключение через пару секунд.' }, 409);
    } catch (error) {
      return json({ error: error.status ? error.message : 'Сервис комнат временно недоступен.' }, error.status || 503);
    }
  };
}
