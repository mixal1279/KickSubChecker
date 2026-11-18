import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const sekret = 'test-secret';
const sekretAdmina = 'test-admin-secret';
const broadcasterId = '123456789';

function utworzEnv({
  tokenWazny = true,
  tokenObecny = true,
  storedBroadcasterId = broadcasterId,
  bladOdczytuKv = false,
} = {}) {
  const zapisyKv = [];
  const wywolaniaD1 = [];
  const dane = new Map();
  if (tokenObecny) dane.set('ljay:tokens', {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: tokenWazny ? Date.now() + 300_000 : Date.now() - 1,
  });
  if (storedBroadcasterId !== null) dane.set('config:broadcaster_id', storedBroadcasterId);
  if (storedBroadcasterId !== null) dane.set('config:broadcaster_username', 'testchannel');

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

  let aktywnaBlokada = false;
  let tokenyWlasciciela = null;
  const env = {
    OAUTH_TOKENS: {
      getByName(nazwa) {
        assert.equal(nazwa, 'refresh-owner');
        return {
          async pobierzTokeny() { return tokenyWlasciciela; },
          async zainicjujTokeny(dane) {
            if (!tokenyWlasciciela) tokenyWlasciciela = { ...dane };
            return { ...tokenyWlasciciela };
          },
          async zapiszTokeny(dane) { tokenyWlasciciela = { ...dane }; return true; },
          async zapiszOdswiezoneTokeny(dane, id, poprzedniRefreshToken) {
            if (!aktywnaBlokada || id !== 'test-refresh-lease'
              || tokenyWlasciciela?.refresh_token !== poprzedniRefreshToken) return false;
            tokenyWlasciciela = { ...dane };
            return true;
          },
          async zarezerwujBlokade(_klucz, czas) {
            assert.ok(czas >= 20_000);
            if (aktywnaBlokada) return null;
            aktywnaBlokada = true;
            return 'test-refresh-lease';
          },
          async zwolnijBlokade(_klucz, id) {
            if (id !== 'test-refresh-lease' || !aktywnaBlokada) return false;
            aktywnaBlokada = false;
            return true;
          },
        };
      },
    },
    BOT_API_SECRET: sekret,
    ADMIN_API_SECRET: sekretAdmina,
    KICK_BROADCASTER_ID: broadcasterId,
    DB: db,
    D1_ENABLED: 'false',
    MIGRATION_WRITE_FREEZE: 'true',
    SUBS_KV: {
      async get(key, type) {
        if (bladOdczytuKv) throw new Error('symulowana awaria KV get');
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
      async list({ prefix, cursor, limit = 1000 }) {
        const keys = [...dane.keys()].filter((key) => key.startsWith(prefix)).sort();
        const offset = cursor == null ? 0 : Number(cursor);
        const selected = keys.slice(offset, offset + limit);
        const nextOffset = offset + selected.length;
        const listComplete = nextOffset >= keys.length;
        return {
          keys: selected.map((name) => ({ name })),
          list_complete: listComplete,
          ...(listComplete ? {} : { cursor: String(nextOffset) }),
        };
      },
    },
  };

  return { env, dane, zapisyKv, wywolaniaD1, pobierzTokenyWlasciciela: () => tokenyWlasciciela };
}

function utworzRequest() {
  return new Request('https://worker.test/api/admin/migrate-kv?dry_run=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sekretAdmina}` },
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
  const { env, zapisyKv, wywolaniaD1, pobierzTokenyWlasciciela } = utworzEnv({ tokenWazny: false });
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


test('endpoint dry-run odrzuca brak tokenu OAuth bez wywołania Kick', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv({ tokenObecny: false });
  const poprzedniFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Nieoczekiwane wywołanie HTTP.'); };

  try {
    const response = await worker.fetch(utworzRequest(), env);
    assert.equal(response.status, 500);
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});

test('endpoint dry-run odrzuca niezgodny broadcaster ID przed migracją', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv({ storedBroadcasterId: '987654321' });
  const poprzedniFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ user_id: broadcasterId, username: 'testchannel' }],
  }), { status: 200 });

  try {
    const response = await worker.fetch(utworzRequest(), env);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'broadcaster_mismatch' });
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});

test('endpoint dry-run odrzuca niepoprawny broadcaster ID z odpowiedzi Kick', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv();
  const poprzedniFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ user_id: 'not-a-kick-id', username: 'testchannel' }],
  }), { status: 200 });

  try {
    const response = await worker.fetch(utworzRequest(), env);
    assert.equal(response.status, 500);
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});

test('endpoint migracji odmawia pracy bez kompletnego bindingu KV', async () => {
  const przypadki = [
    undefined,
    { async get() { return null; } },
  ];

  for (const binding of przypadki) {
    const { env, zapisyKv, wywolaniaD1 } = utworzEnv();
    env.SUBS_KV = binding;
    const response = await worker.fetch(utworzRequest(), env);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'kv_not_configured' });
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  }
});

test('endpoint migracji odmawia pracy bez bindingu D1', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv();
  env.DB = undefined;
  const response = await worker.fetch(utworzRequest(), env);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'd1_not_configured' });
  assert.deepEqual(zapisyKv, []);
  assert.deepEqual(wywolaniaD1, []);
});

test('endpoint migracji bezpiecznie kończy się przy awarii odczytu KV', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv({ bladOdczytuKv: true });
  const response = await worker.fetch(utworzRequest(), env);

  assert.equal(response.status, 500);
  assert.deepEqual(zapisyKv, []);
  assert.deepEqual(wywolaniaD1, []);
});


test('dry-run paginuje KV bez przekraczania budżetu subrequests i bez zapisów', async () => {
  const { env, dane, zapisyKv, wywolaniaD1 } = utworzEnv();
  for (const key of [...dane.keys()]) {
    if (key.startsWith('link:discord:') || key.startsWith('sub:')) dane.delete(key);
  }
  for (let i = 0; i < 13; i++) {
    const discordId = String(23456789012345670n + BigInt(i));
    const kickId = String(3456700n + BigInt(i));
    const username = `testuser${i}`;
    dane.set(`link:discord:${discordId}`, {
      discord_id: discordId, kick_user_id: kickId, username,
    });
    dane.set(`sub:subuser${i}`, {
      username: `subuser${i}`, user_id: kickId,
      expires_at: new Date(Date.now() + 60_000).toISOString(), source: 'admin',
    });
  }

  const poprzedniFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.kick.com/public/v1/users');
    return new Response(JSON.stringify({
      data: [{ user_id: broadcasterId, username: 'testchannel' }],
    }), { status: 200 });
  };

  try {
    const pierwsza = await worker.fetch(utworzRequest(), env);
    assert.equal(pierwsza.status, 200);
    const raportPierwszy = await pierwsza.json();
    assert.equal(raportPierwszy.links_seen, 12);
    assert.equal(raportPierwszy.subscriptions_seen, 12);
    assert.equal(raportPierwszy.links_complete, false);
    assert.equal(raportPierwszy.subscriptions_complete, false);
    assert.equal(raportPierwszy.has_more, true);
    assert.equal(raportPierwszy.duplicate_check_scope, 'current_page');
    assert.equal(raportPierwszy.counts_scope, 'current_page');
    assert.equal(typeof raportPierwszy.links_cursor, 'string');
    assert.equal(typeof raportPierwszy.subscriptions_cursor, 'string');

    const url = new URL('https://worker.test/api/admin/migrate-kv');
    url.searchParams.set('dry_run', 'true');
    url.searchParams.set('links_cursor', raportPierwszy.links_cursor);
    url.searchParams.set('subscriptions_cursor', raportPierwszy.subscriptions_cursor);
    const druga = await worker.fetch(new Request(url, {
      method: 'POST', headers: { Authorization: `Bearer ${sekretAdmina}` },
    }), env);
    assert.equal(druga.status, 200);
    const raportDrugi = await druga.json();
    assert.equal(raportDrugi.links_seen, 1);
    assert.equal(raportDrugi.subscriptions_seen, 1);
    assert.equal(raportDrugi.links_complete, true);
    assert.equal(raportDrugi.subscriptions_complete, true);
    assert.equal(raportDrugi.has_more, false);
    assert.equal(raportDrugi.links_cursor, null);
    assert.equal(raportDrugi.subscriptions_cursor, null);
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});


test('import wygasłego OAuth odświeża token z timeoutem i nie przechodzi dalej po awarii D1', async () => {
  const { env, zapisyKv, wywolaniaD1, pobierzTokenyWlasciciela } = utworzEnv({ tokenWazny: false });
  const poprzedniFetch = globalThis.fetch;
  const wywolania = [];
  globalThis.fetch = async (url, options = {}) => {
    const adres = String(url);
    wywolania.push(adres);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    if (adres === 'https://id.kick.com/oauth/token') {
      assert.equal(options.method, 'POST');
      return new Response(JSON.stringify({
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        expires_in: 3600,
      }), { status: 200 });
    }
    assert.equal(adres, 'https://api.kick.com/public/v1/users');
    return new Response(JSON.stringify({
      data: [{ user_id: broadcasterId, username: 'testchannel' }],
    }), { status: 200 });
  };

  try {
    const response = await worker.fetch(new Request(
      'https://worker.test/api/admin/migrate-kv?dry_run=false',
      { method: 'POST', headers: { Authorization: `Bearer ${sekretAdmina}` } },
    ), env);
    assert.equal(response.status, 500);
    assert.deepEqual(wywolania, [
      'https://id.kick.com/oauth/token',
      'https://api.kick.com/public/v1/users',
    ]);
    assert.equal(zapisyKv.length, 0, 'rotacja tokenów nie może zapisywać do eventual-consistent KV');
    assert.deepEqual(pobierzTokenyWlasciciela(), {
      access_token: 'refreshed-access-token',
      refresh_token: 'refreshed-refresh-token',
      expires_at: pobierzTokenyWlasciciela().expires_at,
    });
    const ponowienie = await worker.fetch(new Request(
      'https://worker.test/api/admin/migrate-kv?dry_run=true',
      { method: 'POST', headers: { Authorization: `Bearer ${sekretAdmina}` } },
    ), env);
    assert.equal(ponowienie.status, 200);
    assert.equal(wywolania.filter((adres) => adres === 'https://id.kick.com/oauth/token').length, 1,
      'po rotacji Worker musi korzystać z DO, nawet gdy KV nadal zwraca stary refresh token');
    assert.equal(wywolaniaD1.length, 1);
    assert.equal(wywolaniaD1[0].typ, 'prepare');
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});


test('refresh OAuth bez nowego refresh_token nie nadpisuje trwałych tokenów', async () => {
  const { env, dane, pobierzTokenyWlasciciela } = utworzEnv({ tokenWazny: false });
  const poprzedniFetch = globalThis.fetch;
  const poprzednieTokeny = dane.get('ljay:tokens');
  const wywolania = [];

  globalThis.fetch = async (url) => {
    wywolania.push(String(url));
    return new Response(JSON.stringify({
      access_token: 'nowy-access-bez-refresh',
      expires_in: 3600,
    }), { status: 200 });
  };

  try {
    const response = await worker.fetch(new Request(
      'https://worker.test/api/admin/migrate-kv?dry_run=false',
      { method: 'POST', headers: { Authorization: `Bearer ${sekretAdmina}` } },
    ), env);
    assert.equal(response.status, 500);
    assert.deepEqual(wywolania, ['https://id.kick.com/oauth/token']);
    assert.deepEqual(pobierzTokenyWlasciciela(), poprzednieTokeny);
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});

test('błąd OAuth nie ujawnia treści odpowiedzi ani tokenów w logach', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv({ tokenWazny: false });
  const poprzedniFetch = globalThis.fetch;
  const poprzedniConsoleError = console.error;
  let logi = '';
  globalThis.fetch = async (_url, options = {}) => {
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({
      error: 'invalid_grant',
      access_token: 'SENSITIVE_ACCESS_TOKEN_TEST',
      refresh_token: 'SENSITIVE_REFRESH_TOKEN_TEST',
    }), { status: 401 });
  };
  console.error = (...args) => { logi += args.join(' '); };

  try {
    const response = await worker.fetch(new Request(
      'https://worker.test/api/admin/migrate-kv?dry_run=false',
      { method: 'POST', headers: { Authorization: `Bearer ${sekretAdmina}` } },
    ), env);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body.includes('SENSITIVE_ACCESS_TOKEN_TEST'), false);
    assert.equal(body.includes('SENSITIVE_REFRESH_TOKEN_TEST'), false);
    assert.equal(logi.includes('SENSITIVE_ACCESS_TOKEN_TEST'), false);
    assert.equal(logi.includes('SENSITIVE_REFRESH_TOKEN_TEST'), false);
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  } finally {
    globalThis.fetch = poprzedniFetch;
    console.error = poprzedniConsoleError;
  }
});

test('import migracji odrzuca brak write freeze przed kontaktem z Kick i D1', async () => {
  const { env, zapisyKv, wywolaniaD1 } = utworzEnv();
  env.MIGRATION_WRITE_FREEZE = 'false';
  const poprzedniFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Kick nie powinien być wywołany.'); };
  try {
    const response = await worker.fetch(new Request(
      'https://worker.test/api/admin/migrate-kv?dry_run=false',
      { method: 'POST', headers: { Authorization: `Bearer ${sekretAdmina}` } },
    ), env);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'migration_write_freeze_required' });
    assert.deepEqual(zapisyKv, []);
    assert.deepEqual(wywolaniaD1, []);
  } finally {
    globalThis.fetch = poprzedniFetch;
  }
});

test('odczyt D1 ponawia inicjalizację kanału, gdy KV ma już broadcaster ID', async () => {
  const { env, dane } = utworzEnv();
  env.D1_ENABLED = 'true';
  dane.set('config:broadcaster_username', 'testchannel');
  const zapytania = [];
  env.DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql, args,
            async run() { zapytania.push({ typ: 'run', sql, args }); return { success: true, meta: { changes: 1 } }; },
            async first() { zapytania.push({ typ: 'first', sql, args }); return null; },
          };
        },
      };
    },
    async batch() { return []; },
  };
  const response = await worker.fetch(new Request(
    'https://worker.test/api/check?username=testuser',
    { headers: { Authorization: `Bearer ${sekret}` } },
  ), env);
  assert.equal(response.status, 200);
  assert.match(zapytania[0].sql, /INSERT INTO channels/);
  assert.equal(zapytania[0].args[0], broadcasterId);
});


test('D1_ENABLED=true bez bindingu DB nie przełącza po cichu na KV', async () => {
  const { env, zapisyKv } = utworzEnv();
  env.D1_ENABLED = 'true';
  env.DB = undefined;
  const response = await worker.fetch(new Request(
    'https://worker.test/api/check?username=testuser',
    { headers: { Authorization: `Bearer ${sekret}` } },
  ), env);
  assert.equal(response.status, 500);
  assert.deepEqual(zapisyKv, []);
});

test('niepoprawna wartość D1_ENABLED jest odrzucana zamiast uruchamiać backend KV', async () => {
  const { env, zapisyKv } = utworzEnv();
  env.D1_ENABLED = 'TRUE';
  const response = await worker.fetch(new Request(
    'https://worker.test/api/check?username=testuser',
    { headers: { Authorization: `Bearer ${sekret}` } },
  ), env);
  assert.equal(response.status, 500);
  assert.deepEqual(zapisyKv, []);
});
