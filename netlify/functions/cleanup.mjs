import { getStore } from '@netlify/blobs';

export default async () => {
  const store = getStore({ name: 'watch-rooms', consistency: 'strong' });
  for await (const page of store.list({ prefix: 'room/', paginate: true })) {
    for (const { key } of page.blobs) {
      const room = await store.get(key, { type: 'json' });
      if (room && room.expires < Date.now()) await store.delete(key);
    }
  }
  return new Response(null, { status: 204 });
};
export const config = { schedule: '15 * * * *' };
