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


test('brak ADMIN_API_SECRET odmawia migracji przed dostępem do usług', async () => {
  const response = await worker.fetch(new Request(workerUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret' },
  }), { BOT_API_SECRET: 'admin-secret' });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});


test('migrator odrzuca nieobsługiwane parametry query', async () => {
  const response = await worker.fetch(new Request(workerUrl + '?broadcaster_id=999999999', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret' },
  }), { ADMIN_API_SECRET: 'admin-secret' });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_query_parameter' });
});

test('migrator odrzuca body zamiast ignorować niezwalidowane dane', async () => {
  const response = await worker.fetch(new Request(workerUrl + '?dry_run=true', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer admin-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ broadcaster_id: '999999999', dry_run: false }),
  }), { ADMIN_API_SECRET: 'admin-secret' });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'unexpected_request_body' });
});

test('migrator odrzuca powtórzony parametr dry_run', async () => {
  const response = await worker.fetch(new Request(workerUrl + '?dry_run=true&dry_run=false', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret' },
  }), { ADMIN_API_SECRET: 'admin-secret' });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_dry_run' });
});


test('import odrzuca cursory przeznaczone wyłącznie dla dry-run', async () => {
  const response = await worker.fetch(new Request(workerUrl + '?dry_run=false&links_cursor=abc', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret' },
  }), { ADMIN_API_SECRET: 'admin-secret' });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'pagination_only_available_for_dry_run' });
});

test('dry-run odrzuca cursor i flage ukończenia tego samego prefiksu jednocześnie', async () => {
  const response = await worker.fetch(new Request(workerUrl + '?dry_run=true&links_done=true&links_cursor=abc', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret' },
  }), { ADMIN_API_SECRET: 'admin-secret' });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'conflicting_pagination_parameters' });
});
