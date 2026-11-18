import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const verifier = 'a'.repeat(64);
const state = 'StateToken_123456789012345';
const code = 'authorization-code-test';

function utworzEnv({ freeze = 'false', awariaZapisu = false } = {}) {
  const wpisy = new Map();
  const zdarzenia = [];
  let tokeny = null;
  let licznik = 0;
  const magazyn = {
    async zapisz(token, typ, dane, wygasaAt) {
      if (wpisy.has(token)) throw new Error('duplicate token');
      wpisy.set(token, { typ, dane, wygasaAt, rezerwacja: null });
      zdarzenia.push({ operacja: 'zapisz-state', token });
      return true;
    },
    async zuzyj(token, typ) {
      const wpis = wpisy.get(token);
      if (!wpis || wpis.typ !== typ || wpis.wygasaAt <= Date.now() || wpis.rezerwacja) return null;
      wpisy.delete(token);
      return wpis.dane;
    },
    async zarezerwuj(token, typ) {
      const wpis = wpisy.get(token);
      if (!wpis || wpis.typ !== typ || wpis.wygasaAt <= Date.now() || wpis.rezerwacja) return null;
      const id = `lease-${++licznik}`;
      wpis.rezerwacja = id;
      return { id, dane: wpis.dane };
    },
    async zakoncz(token, typ, id) {
      const wpis = wpisy.get(token);
      if (!wpis || wpis.typ !== typ || wpis.rezerwacja !== id) return false;
      wpisy.delete(token);
      zdarzenia.push({ operacja: 'zuzyj-state', token });
      return true;
    },
    async zwolnij(token, typ, id) {
      const wpis = wpisy.get(token);
      if (!wpis || wpis.typ !== typ || wpis.rezerwacja !== id) return false;
      wpis.rezerwacja = null;
      return true;
    },
    async pobierzTokeny() { return tokeny; },
    async zainicjujTokeny(dane) { tokeny ??= dane; return tokeny; },
    async zapiszTokeny(dane) {
      if (awariaZapisu) throw new Error('durable object unavailable');
      tokeny = dane;
      zdarzenia.push({ operacja: 'zapisz-tokeny' });
      return true;
    },
    async zapiszOdswiezoneTokeny() { return false; },
    async zarezerwujBlokade() { return 'lock'; },
    async zwolnijBlokade() { return true; },
  };
  const kv = new Map();
  const stanyCutoveru = new Map();
  return {
    freeze,
    zdarzenia,
    wpisy,
    pobierzTokeny: () => tokeny,
    OAUTH_TOKENS: {
      getByName(nazwa) {
        if (nazwa.startsWith('cutover-')) {
          const broadcasterId = nazwa.slice('cutover-'.length);
          return {
            async pobierzStanCutoveru(id) {
              const stan = stanyCutoveru.get(broadcasterId);
              if (stan && stan.broadcaster_id !== id) throw new Error('broadcaster mismatch');
              return stan?.backend || null;
            },
            async oznaczCutoverD1(id) {
              if (id !== broadcasterId) throw new Error('broadcaster mismatch');
              const stan = stanyCutoveru.get(broadcasterId);
              if (stan && stan.broadcaster_id !== id) throw new Error('broadcaster mismatch');
              stanyCutoveru.set(broadcasterId, { broadcaster_id: id, backend: 'd1' });
              return true;
            },
          };
        }
        return magazyn;
      },
    },
    SUBS_KV: {
      async get(key, type) {
        const value = kv.get(key) ?? null;
        if (type === 'json' && typeof value === 'string') {
          try { return JSON.parse(value); } catch { return null; }
        }
        return value;
      },
      async put(key, value) { kv.set(key, value); zdarzenia.push({ operacja: 'kv-put', key }); },
      async delete(key) { kv.delete(key); },
    },
    MIGRATION_WRITE_FREEZE: freeze,
    KICK_CLIENT_ID: 'client-id',
    KICK_CLIENT_SECRET: 'client-secret',
    REDIRECT_URI: 'https://worker.test/callback',
  };
}

function request(path, method = 'GET') {
  return new Request(`https://worker.test${path}`, { method });
}

function odpowiedzKick(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function zMockowanymFetch(fn, callback) {
  const oryginalnyFetch = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await callback(); } finally { globalThis.fetch = oryginalnyFetch; }
}

function przygotujCallback(env, dane = {}) {
  env.OAUTH_TOKENS.getByName = () => env._magazyn;
}

function dodajState(env, { owner = true, discord_id = null, expected_username = null } = {}) {
  const magazyn = env.OAUTH_TOKENS.getByName('token-S');
  // Fixture wystawia metodę zapisu przez ten sam interfejs DO co Worker.
  return magazyn.zapisz(state, 'oauth-state', {
    verifier, owner, discord_id, expected_username, created_at: Date.now(),
  }, Date.now() + 600_000);
}

test('freeze blokuje /ljay-live i /ljay-live/start bez tworzenia stanu OAuth', async () => {
  for (const path of ['/ljay-live', '/ljay-live/start']) {
    const env = utworzEnv({ freeze: 'true' });
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '120');
    assert.equal(env.zdarzenia.length, 0);
  }
});

test('freeze blokuje /authorize i /callback bez zużywania tokenów OAuth', async () => {
  const env = utworzEnv({ freeze: 'true' });
  const linkToken = 'LinkToken_123456789012345';
  const magazyn = env.OAUTH_TOKENS.getByName('token-S');
  await magazyn.zapisz(linkToken, 'link-start', {
    discord_id: '123456789012345678',
    created_at: Date.now(),
  }, Date.now() + 600_000);
  await dodajState(env);
  const zdarzeniaPrzed = [...env.zdarzenia];

  const authorize = await worker.fetch(
    request(`/authorize?link_token=${linkToken}`), env,
  );
  const callback = await worker.fetch(
    request(`/callback?code=${code}&state=${state}`), env,
  );

  assert.equal(authorize.status, 503);
  assert.equal(callback.status, 503);
  assert.ok(env.wpisy.has(linkToken));
  assert.ok(env.wpisy.has(state));
  assert.deepEqual(env.zdarzenia, zdarzeniaPrzed);
});

test('/ljay-live i /ljay-live/start działają bez freeze i nie żądają channel:read', async () => {
  for (const path of ['/ljay-live', '/ljay-live/start']) {
    const env = utworzEnv();
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get('Location'));
    assert.equal(url.searchParams.get('scope'), 'user:read events:subscribe');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('state'));
  }
});

test('OAuth widza żąda wyłącznie user:read', async () => {
  const env = utworzEnv();
  await env.OAUTH_TOKENS.getByName('token-L').zapisz(
    'LinkToken_123456789012345', 'link-start',
    { discord_id: '123456789012345678', created_at: Date.now() },
    Date.now() + 600_000,
  );
  const response = await worker.fetch(request('/authorize?link_token=LinkToken_123456789012345'), env);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('Location'));
  assert.equal(url.searchParams.get('scope'), 'user:read');
});

test('OAuth właściciela żąda user:read i events:subscribe', async () => {
  const env = utworzEnv();
  await env.OAUTH_TOKENS.getByName('token-O').zapisz(
    'OwnerToken_123456789012345', 'owner-start',
    { created_at: Date.now() }, Date.now() + 600_000,
  );
  const response = await worker.fetch(request('/authorize?owner_token=OwnerToken_123456789012345'), env);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('Location'));
  assert.equal(url.searchParams.get('scope'), 'user:read events:subscribe');
});

test('callback wymienia kod z poprawnym PKCE i zapisuje tokeny dopiero po weryfikacji właściciela', async () => {
  const env = utworzEnv();
  await dodajState(env);
  const wywolania = [];
  await zMockowanymFetch(async (url, options = {}) => {
    wywolania.push({ url: String(url), options });
    if (String(url).includes('/oauth/token')) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), code);
      assert.equal(body.get('code_verifier'), verifier);
      assert.equal(body.get('redirect_uri'), env.REDIRECT_URI);
      return odpowiedzKick({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
    }
    if (String(url).includes('/public/v1/users')) {
      assert.equal(options.headers.Authorization, 'Bearer access-secret');
      return odpowiedzKick({ data: [{ user_id: '123456789', username: 'testowner' }] });
    }
    throw new Error('Nieoczekiwany endpoint');
  }, async () => {
    const response = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    assert.equal(response.status, 200);
  });
  assert.equal(wywolania.length, 2);
  assert.equal(env.pobierzTokeny().access_token, 'access-secret');
  assert.equal(env.pobierzTokeny().refresh_token, 'refresh-secret');
  assert.ok(env.zdarzenia.some((x) => x.key === 'config:broadcaster_id'));
  assert.ok(env.zdarzenia.some((x) => x.key === 'config:broadcaster_username'));
});

test('callback odrzuca brakujący i nieprawidłowy state przed wywołaniem Kick', async () => {
  const env = utworzEnv();
  for (const path of ['/callback?code=abc', '/callback?code=abc&state=bad']) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 400);
  }
  assert.equal(env.zdarzenia.length, 0);
  assert.equal(env.pobierzTokeny(), null);
});

test('callback odrzuca ponowne wykorzystanie zużytego state', async () => {
  const env = utworzEnv();
  await dodajState(env);
  await zMockowanymFetch(async (url) => String(url).includes('/oauth/token')
    ? odpowiedzKick({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
    : odpowiedzKick({ data: [{ user_id: '123456789', username: 'testowner' }] }), async () => {
    const first = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    const second = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    assert.equal(first.status, 200);
    assert.equal(second.status, 400);
  });
});

test('callback odrzuca niezgodność oczekiwanej tożsamości i nie zapisuje tokenów ani konfiguracji', async () => {
  const env = utworzEnv();
  await dodajState(env, { expected_username: 'expectedowner' });
  await zMockowanymFetch(async (url) => String(url).includes('/oauth/token')
    ? odpowiedzKick({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
    : odpowiedzKick({ data: [{ user_id: '123456789', username: 'differentowner' }] }), async () => {
    const response = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    assert.equal(response.status, 403);
  });
  assert.equal(env.pobierzTokeny(), null);
  assert.equal(env.zdarzenia.some((x) => x.key?.startsWith('config:')), false);
});

test('callback odrzuca broadcaster ID niezgodny z konfiguracją', async () => {
  const env = utworzEnv();
  await env.SUBS_KV.put('config:broadcaster_id', '999999999');
  await dodajState(env);
  await zMockowanymFetch(async (url) => String(url).includes('/oauth/token')
    ? odpowiedzKick({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
    : odpowiedzKick({ data: [{ user_id: '123456789', username: 'testowner' }] }), async () => {
    const response = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    assert.equal(response.status, 403);
  });
  assert.equal(env.pobierzTokeny(), null);
  assert.equal(env.zdarzenia.some((x) => x.key === 'config:broadcaster_username'), false);
});

test('callback mapuje błąd token endpointu na 502 i zwalnia rezerwację state', async () => {
  const env = utworzEnv();
  await dodajState(env);
  await zMockowanymFetch(async () => odpowiedzKick({ error: 'invalid_grant' }, 400), async () => {
    const response = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    assert.equal(response.status, 502);
  });
  assert.equal(env.pobierzTokeny(), null);
  assert.equal(env.zdarzenia.some((x) => x.operacja === 'zapisz-tokeny'), false);
  assert.ok(env.wpisy.has(state), 'state powinien być możliwy do ponowienia po błędzie wymiany');
});

test('callback nie zapisuje niekompletnej odpowiedzi token endpointu', async () => {
  const env = utworzEnv();
  await dodajState(env);
  await zMockowanymFetch(async (url) => String(url).includes('/oauth/token')
    ? odpowiedzKick({ access_token: 'access', expires_in: 3600 })
    : odpowiedzKick({ data: [{ user_id: '123456789', username: 'testowner' }] }), async () => {
    const response = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    assert.equal(response.status, 500);
  });
  assert.equal(env.pobierzTokeny(), null);
  assert.equal(env.zdarzenia.some((x) => x.key?.startsWith('config:')), false);
});

test('callback nie zapisuje konfiguracji po przerwaniu po wymianie kodu, przed potwierdzeniem tożsamości', async () => {
  const env = utworzEnv();
  await dodajState(env);
  await zMockowanymFetch(async (url) => {
    if (String(url).includes('/oauth/token')) {
      return odpowiedzKick({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
    throw new Error('timeout');
  }, async () => {
    const response = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    assert.equal(response.status, 500);
  });
  assert.equal(env.pobierzTokeny(), null);
  assert.equal(env.zdarzenia.some((x) => x.key?.startsWith('config:')), false);
});

test('callback nie zapisuje konfiguracji ani tokenów po awarii Durable Object', async () => {
  const env = utworzEnv({ awariaZapisu: true });
  await dodajState(env);
  await zMockowanymFetch(async (url) => String(url).includes('/oauth/token')
    ? odpowiedzKick({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
    : odpowiedzKick({ data: [{ user_id: '123456789', username: 'testowner' }] }), async () => {
    const response = await worker.fetch(request(`/callback?code=${code}&state=${state}`), env);
    assert.equal(response.status, 500);
  });
  assert.equal(env.pobierzTokeny(), null);
  assert.equal(env.zdarzenia.some((x) => x.key?.startsWith('config:')), false);
});

test('callback akceptuje wyłącznie GET', async () => {
  const env = utworzEnv();
  const response = await worker.fetch(request(`/callback?code=${code}&state=${state}`, 'POST'), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET');
  assert.equal(env.zdarzenia.length, 0);
});
