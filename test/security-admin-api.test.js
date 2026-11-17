import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const workerUrl = 'https://worker.test/api/admin/migrate-kv';

test('sekret bota nie autoryzuje migracji administracyjnej', async () => {
  const response = await worker.fetch(new Request(workerUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer bot-secret' },
  }), { BOT_API_SECRET: 'bot-secret' });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('migracja wymaga osobnego ADMIN_API_SECRET', async () => {
  const response = await worker.fetch(new Request(workerUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret' },
  }), { ADMIN_API_SECRET: 'admin-secret' });

  // Autoryzacja przechodzi; brak bindingu D1 zatrzymuje żądanie przed jakimkolwiek zapisem.
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'd1_not_configured' });
});

test('sekret administracyjny nie daje dostępu do zwykłego API bota', async () => {
  const response = await worker.fetch(new Request('https://worker.test/api/check?username=testuser', {
    headers: { Authorization: 'Bearer admin-secret' },
  }), { ADMIN_API_SECRET: 'admin-secret' });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});
