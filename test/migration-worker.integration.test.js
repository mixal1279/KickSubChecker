import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const sekret = 'test-secret';
const broadcasterId = '123456789';

function utworzEnv({ tokenWazny = true } = {}) {
  const zapisyKv = [];
  const wywolaniaD1 = [];
  const dane = new Map([
    ['ljay:tokens', {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: tokenWazny ? Date.now() + 300_000 : Date.now() - 1,
    }],
    ['config:broadcaster_id', broadcasterId],
  ]);

  const db = {
    prepare(sql) {
      wywolaniaD1.push({ typ: 'prepare', sql });
      throw new Error('Dry-run nie może wykonywać zapytań D1.');
    },
    async batch() {
      wywolaniaD1.push({ typ: 'batch' });
      throw new Error('Dry-run nie może wykonywać batch D1.');
    },
  };

  const env = {
    BOT_API_SECRET: sekret,
    KICK_BROADCASTER_ID: broadcasterId,
    DB: db,
    D1_ENABLED: 'false',
    SUBS_KV: {
      async get(key, type) {
        const value = dane.get(key) ?? null;
        if (type === 'json' && value && typeof value === 'string') return JSON.parse(value);
        return value;
      },
      async put(key, value) {
        zapisyKv.push({ operacja: 'put', key, value });
        dane.set(key, value);
      },
      async delete(key) {
        zapisyKv.push({ operacja: 'delete', key });
        dane.delete(key);
      },
      async list({ prefix }) {
        return { keys: [...dane.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
      },
    },
  };

  return { env, zapisyKv, wywolaniaD1 };
}

function utworzRequest() {
  return new Request('https://worker.test/api/admin/migrate-kv?dry_run=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sekret}` },
  });
}

test('endpoint dry-run wykonuje wyłącznie GET tożsamości Kick i nie zapisuje KV ani D1', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv();
  const poprzedniFetch = globalThis.fetch;
  const wywolaniaHttp = [];

  globalThis.fetch = async (url, options = {}) => {
    wywolaniaHttp.push({ url: String(url), method: options.method || 'GET' });
    assert.equal(String(url), 'https://api.kick.com/public/v1/users');
    return new Response(JSON.stringify({
      data: [{ user_id: broadcasterId, username: 'testchannel' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await worker.fetch(utworzRequest(), env);
    assert.equal(response.status, 200);
    const raport = await response.json();
    assert.equal(raport.dry_run, true);
    assert.equal(raport.broadcaster_id, broadcasterId);
    assert.equal(wywolaniaHttp.length, 1);
    assert.deepEqual(wywolaniaHttp.map((call) => call.method), ['GET']);
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});

test('endpoint dry-run odrzuca wygasły token bez refresh OAuth i bez zapisów', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv({ tokenWazny: false });
  const poprzedniFetch = globalThis.fetch;
  const wywolaniaHttp = [];

  globalThis.fetch = async (url, options = {}) => {
    wywolaniaHttp.push({ url: String(url), method: options.method || 'GET' });
    throw new Error('Nieoczekiwane wywołanie HTTP.');
  };

  try {
    const response = await worker.fetch(utworzRequest(), env);
    assert.equal(response.status, 500);
    assert.deepEqual(wywolaniaHttp, []);
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});

test('endpoint migracji wymaga poprawnego Bearer tokena przed dostępem do usług', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv();
  const response = await worker.fetch(new Request(
    'https://worker.test/api/admin/migrate-kv?dry_run=true',
    { method: 'POST' },
  ), env);

  assert.equal(response.status, 401);
  assert.deepEqual(zapisyKv, []);
  assert.deepEqual(wywolaniaD1, []);
});
