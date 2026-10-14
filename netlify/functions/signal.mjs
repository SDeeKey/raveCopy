import { getStore } from '@netlify/blobs';
import { makeHandler } from '../../server/signaling.mjs';

export default request => makeHandler(getStore({ name: 'watch-rooms', consistency: 'strong' }))(request);
export const config = { rateLimit: { windowLimit: 500, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
