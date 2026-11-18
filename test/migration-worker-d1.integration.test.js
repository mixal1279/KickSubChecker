import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const kontoId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const tokenApi = process.env.CLOUDFLARE_API_TOKEN || '';
const bazaId = process.env.D1_TEST_DATABASE_ID || '';
const oczekiwaneKontoId = '1bf7a2788e0a1d36e5aebc15ecf56f9f';
const oczekiwanaBazaId = '232c709f-b295-4b36-956a-dcbe4efd2029';
const produkcyjnaBazaId = '8130d703-3197-41c4-b480-5dabdbf062a7';
const konfiguracjaD1 = [kontoId, tokenApi, bazaId];
const skonfigurowano = konfiguracjaD1.every(Boolean);
const pobierzCloudflare = globalThis.fetch.bind(globalThis);

if (konfiguracjaD1.some(Boolean) && !skonfigurowano) {
  throw new Error('Test D1 wymaga jednoczesnej konfiguracji account ID, API tokenu i testowego database ID.');
}
if (bazaId === produkcyjnaBazaId) {
  throw new Error('Test handlera migracji odmawia pracy na produkcyjnej D1.');
}
if (skonfigurowano && (kontoId !== oczekiwaneKontoId || bazaId !== oczekiwanaBazaId)) {
  throw new Error('Test handlera migracji wymaga dokładnie wskazanej testowej D1.');
}

async function zapytajCloudflare(path, payload = null) {
  const response = await pobierzCloudflare(
    `https://api.cloudflare.com/client/v4/accounts/${kontoId}${path}`,
    {
      method: payload === null ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${tokenApi}`,
        'Content-Type': 'application/json',
      },
      ...(payload === null ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    throw new Error(`Cloudflare test API HTTP ${response.status}`);
  }
  return body.result;
}

class AdapterD1Rest {
  calls = 0;

  constructor() {
    this.path = `/d1/database/${bazaId}/query`;
  }

  async wykonaj(sql, params = []) {
    this.calls++;
    const result = await zapytajCloudflare(this.path, {
      sql,
      params: params.map((wartosc) => wartosc == null ? null : String(wartosc)),
    });
    const wynik = result?.[0] || { success: true, results: [], meta: {} };
    if (wynik.success === false) throw new Error('Cloudflare D1 query failed.');
    return wynik;
  }

  przygotuj(sql, params = []) {
    const adapter = this;
    return {
      sql,
      params,
      bind(...wartosci) {
        return adapter.przygotuj(sql, wartosci);
      },
      async first() {
        const wynik = await adapter.wykonaj(sql, params);
        return wynik.results?.[0] ?? null;
      },
      async run() {
        return adapter.wykonaj(sql, params);
      },
      async all() {
        return adapter.wykonaj(sql, params);
      },
    };
  }

  prepare(sql) {
    return this.przygotuj(sql);
  }

  async batch(statements) {
    this.calls++;
    return zapytajCloudflare(this.path, {
      batch: statements.map(({ sql, params = [] }) => ({
        sql,
        params: params.map((wartosc) => wartosc == null ? null : String(wartosc)),
      })),
    });
  }
}

function utworzKvFixture(broadcasterId, teraz) {
  const dane = new Map();
  const zapisy = [];
  dane.set('ljay:tokens', {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: teraz + 3_600_000,
  });
  dane.set('config:broadcaster_id', broadcasterId);

  for (let i = 0; i < 2; i++) {
    const discordId = String(BigInt(broadcasterId) + 100n + BigInt(i));
    const kickId = String(BigInt(broadcasterId) + 200n + BigInt(i));
    const subUsername = `subuser${i}`;
    const linkUsername = i === 0 ? subUsername : `linkuser${i}`;

    dane.set(`link:discord:${discordId}`, {
      discord_id: discordId,
      kick_user_id: kickId,
      username: linkUsername,
    });
    dane.set(`sub:${subUsername}`, {
      username: subUsername,
      user_id: i === 0 ? null : kickId,
      expires_at: new Date(teraz + 3_600_000 + i * 1000).toISOString(),
    });
  }

  return {
    zapisy,
    async get(key, type) {
      const value = dane.get(key);
      if (value === undefined) return null;
      if (type === 'json') return typeof value === 'string' ? JSON.parse(value) : value;
      if (type === 'text') return typeof value === 'string' ? value : JSON.stringify(value);
      return value;
    },
    async put(key, value) {
      zapisy.push({ key });
      dane.set(key, value);
    },
    async delete(key) {
      dane.delete(key);
    },
    async list({ prefix, cursor, limit = 1000 }) {
      const keys = [...dane.keys()].filter((key) => key.startsWith(prefix)).sort();
      const offset = cursor == null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new Error(`Nieprawidłowy cursor KV w fixture: cursor=${String(cursor)}, typ=${typeof cursor}, limit=${String(limit)}.`);
      }
      const page = keys.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const listComplete = nextOffset >= keys.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: listComplete,
        ...(listComplete ? {} : { cursor: String(nextOffset) }),
      };
    },
  };
}

function requestMigracji(dryRun) {
  return new Request(
    `https://worker.test/api/admin/migrate-kv?dry_run=${dryRun ? 'true' : 'false'}`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-secret' },
    },
  );
}

test('pełny handler migracji używa KV fixture i rzeczywistej testowej D1', { skip: !skonfigurowano }, async () => {
  const metadata = await zapytajCloudflare(`/d1/database/${bazaId}`);
  assert.equal(metadata.name, 'kick-sub-checker-test');
  assert.equal(metadata.jurisdiction, 'eu');

  const teraz = Date.now();
  const broadcasterId = (BigInt(teraz) * 1_000_000n + 876_543n).toString();
  const innyBroadcasterId = (BigInt(broadcasterId) + 999n).toString();
  const db = new AdapterD1Rest();
  const kv = utworzKvFixture(broadcasterId, teraz);
  let tokenyWlasciciela = null;
  let blokadaOdswiezania = false;
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
          async zapiszOdswiezoneTokeny(dane) { tokenyWlasciciela = { ...dane }; return true; },
          async zarezerwujBlokade() {
            if (blokadaOdswiezania) return null;
            blokadaOdswiezania = true;
            return 'test-lease';
          },
          async zwolnijBlokade(_nazwa, id) {
            if (id !== 'test-lease' || !blokadaOdswiezania) return false;
            blokadaOdswiezania = false;
            return true;
          },
        };
      },
    },
    ADMIN_API_SECRET: 'test-admin-secret',
    BOT_API_SECRET: 'test-bot-secret',
    D1_ENABLED: 'true',
    MIGRATION_WRITE_FREEZE: 'true',
    KICK_BROADCASTER_ID: broadcasterId,
    SUBS_KV: kv,
    DB: db,
  };

  const poprzedniFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), 'https://api.kick.com/public/v1/users');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({
      data: [{ user_id: broadcasterId, username: 'auditworker' }],
    }), { status: 200 });
  };

  try {
    const zapytaniaPrzedDryRun = db.calls;
    const dryRun = await worker.fetch(requestMigracji(true), env);
    assert.equal(dryRun.status, 200);
    const raportDryRun = await dryRun.json();
    assert.equal(raportDryRun.links_valid, 2);
    assert.equal(raportDryRun.subscriptions_valid, 2);
    assert.equal(raportDryRun.has_more, false);
    assert.equal(db.calls, zapytaniaPrzedDryRun);
    assert.deepEqual(kv.zapisy, []);

    const pierwszaStrona = await worker.fetch(requestMigracji(false), env);
    assert.equal(pierwszaStrona.status, 200);
    const raportLinkow = await pierwszaStrona.json();
    assert.equal(raportLinkow.phase, 'subscriptions');
    assert.equal(raportLinkow.has_more, true);
    assert.equal(raportLinkow.links_imported, 2);

    const drugaStrona = await worker.fetch(requestMigracji(false), env);
    assert.equal(drugaStrona.status, 200);
    const raportSubskrypcji = await drugaStrona.json();
    assert.equal(raportSubskrypcji.complete, true);
    assert.equal(raportSubskrypcji.phase, 'completed');
    assert.equal(raportSubskrypcji.links_imported, 2);
    assert.equal(raportSubskrypcji.subscriptions_imported, 2);

    const retry = await worker.fetch(requestMigracji(false), env);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).already_completed, true);

    const linki = await db.prepare(
      'SELECT COUNT(*) AS liczba FROM account_links WHERE broadcaster_id = ?',
    ).bind(broadcasterId).first();
    const subskrypcje = await db.prepare(
      'SELECT COUNT(*) AS liczba FROM subscriptions WHERE broadcaster_id = ?',
    ).bind(broadcasterId).first();
    const markery = await db.prepare(
      'SELECT COUNT(*) AS liczba FROM migration_items WHERE broadcaster_id = ?',
    ).bind(broadcasterId).first();
    const stan = await db.prepare(
      'SELECT status, phase FROM migration_runs WHERE broadcaster_id = ?',
    ).bind(broadcasterId).first();
    const obcyZakres = await db.prepare(
      'SELECT COUNT(*) AS liczba FROM account_links WHERE broadcaster_id = ?',
    ).bind(innyBroadcasterId).first();

    assert.equal(Number(linki.liczba), 2);
    assert.equal(Number(subskrypcje.liczba), 2);
    const powiazanaHistorycznaSubskrypcja = await db.prepare(
      'SELECT kick_user_id FROM subscriptions WHERE broadcaster_id = ? AND kick_username = ?',
    ).bind(broadcasterId, 'subuser0').first();
    assert.equal(powiazanaHistorycznaSubskrypcja.kick_user_id, String(BigInt(broadcasterId) + 200n));
    assert.equal(Number(markery.liczba), 4);
    assert.deepEqual(stan, { status: 'completed', phase: 'completed' });
    assert.equal(Number(obcyZakres.liczba), 0);
    assert.equal(await kv.get('config:d1_cutover_complete'), broadcasterId);
    assert.deepEqual(kv.zapisy, [{ key: 'config:d1_cutover_complete' }]);
  } finally {
    globalThis.fetch = poprzedniFetch;
    await db.prepare('DELETE FROM channels WHERE broadcaster_id = ?').bind(broadcasterId).run();

    const zapytaniaSprzatania = [
      ['guild_configs', 'SELECT COUNT(*) AS liczba FROM guild_configs WHERE broadcaster_id = ?'],
      ['account_links', 'SELECT COUNT(*) AS liczba FROM account_links WHERE broadcaster_id = ?'],
      ['subscriptions', 'SELECT COUNT(*) AS liczba FROM subscriptions WHERE broadcaster_id = ?'],
      ['webhook_events', 'SELECT COUNT(*) AS liczba FROM webhook_events WHERE broadcaster_id = ?'],
      ['audit_log', 'SELECT COUNT(*) AS liczba FROM audit_log WHERE broadcaster_id = ?'],
      ['migration_runs', 'SELECT COUNT(*) AS liczba FROM migration_runs WHERE broadcaster_id = ?'],
      ['migration_items', 'SELECT COUNT(*) AS liczba FROM migration_items WHERE broadcaster_id = ?'],
      ['channels', 'SELECT COUNT(*) AS liczba FROM channels WHERE broadcaster_id = ?'],
    ];
    for (const [tabela, sql] of zapytaniaSprzatania) {
      const wynik = await db.prepare(sql).bind(broadcasterId).first();
      assert.equal(Number(wynik?.liczba || 0), 0, `Pozostały rekordy w tabeli ${tabela}.`);
    }
  }
});
