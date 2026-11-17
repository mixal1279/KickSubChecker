import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const sekret = 'test-secret';
const kanal = '123456789';
const token = 'test-access-token';
const teraz = Date.now();

function utworzSrodowisko({ bladCheckpoint = false, bladFinalizacji = false, blokujPierwszyOdczyt = false, fazaPoczatkowa = 'links', subskrypcje = 0 } = {}) {
  const rekordy = new Map();
  const subskrypcjeD1 = new Map();
  const markery = new Set();
  if (fazaPoczatkowa === 'subscriptions') markery.add('links|link:discord:10000000000000000');
  let stan = null;
  let bladCheckpointRaz = bladCheckpoint;
  let bladFinalizacjiRaz = bladFinalizacji;
  let zwolnijOdczyt;
  let sygnalOdczytu;
  const odczytRozpoczety = new Promise((resolve) => { sygnalOdczytu = resolve; });
  const bramkaOdczytu = new Promise((resolve) => { zwolnijOdczyt = resolve; });
  let zablokowano = false;
  const wywolania = [];

  const db = {
    prepare(sql) {
      return {
        sql,
        bind(...args) {
          return {
            sql, args,
            async run() {
              wywolania.push({ typ: 'run', sql, args });
              if (sql.includes('INSERT INTO channels')) return { success: true, meta: { changes: 1 } };
              if (sql.includes('INSERT INTO migration_runs')) {
                const [broadcasterId, leaseToken, expiry, started, updated, current, tokenPowtorzony] = args;
                if (!stan) {
                  stan = { broadcaster_id: broadcasterId, status: 'running', phase: fazaPoczatkowa, cursor: null, counts_json: fazaPoczatkowa === 'subscriptions' ? JSON.stringify({ links_seen: 1, links_valid: 1, links_imported: 1, links_skipped: 0, links_conflicts: 0 }) : '{}', lease_token: leaseToken, lease_expires_at_ms: expiry, started_at_ms: started, updated_at_ms: updated };
                  return { success: true, meta: { changes: 1 } };
                }
                if (stan.status !== 'completed' && (
                  stan.lease_expires_at_ms == null
                  || stan.lease_expires_at_ms <= current
                  || stan.lease_token === tokenPowtorzony
                )) {
                  stan.lease_token = leaseToken;
                  stan.lease_expires_at_ms = expiry;
                  stan.updated_at_ms = updated;
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              if (sql.includes('UPDATE migration_runs SET phase')) {
                if (bladCheckpointRaz) {
                  bladCheckpointRaz = false;
                  throw new Error('symulowana awaria checkpointu');
                }
                const [phase, cursor, counts, expiry, updated, broadcasterId, leaseToken, current] = args;
                if (!stan || stan.broadcaster_id !== broadcasterId || stan.status !== 'running' || stan.lease_token !== leaseToken || stan.lease_expires_at_ms <= current) return { success: true, meta: { changes: 0 } };
                Object.assign(stan, { phase, cursor, counts_json: counts, lease_expires_at_ms: expiry, updated_at_ms: updated });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE migration_runs SET status = \'completed\'')) {
                if (bladFinalizacjiRaz) {
                  bladFinalizacjiRaz = false;
                  throw new Error('symulowana awaria finalizacji');
                }
                const [completed, updated, broadcasterId, leaseToken, current] = args;
                if (!stan || stan.broadcaster_id !== broadcasterId || stan.lease_token !== leaseToken || stan.lease_expires_at_ms <= current) return { success: true, meta: { changes: 0 } };
                Object.assign(stan, { status: 'completed', phase: 'completed', cursor: null, lease_token: null, lease_expires_at_ms: null, completed_at_ms: completed, updated_at_ms: updated });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE migration_runs SET lease_token = NULL')) {
                const [updated, broadcasterId, leaseToken] = args;
                if (stan?.broadcaster_id === broadcasterId && stan.status === 'running' && stan.lease_token === leaseToken) {
                  Object.assign(stan, { lease_token: null, lease_expires_at_ms: null, updated_at_ms: updated });
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              throw new Error('Nieobsługiwane SQL run: ' + sql);
            },
            async first() {
              wywolania.push({ typ: 'first', sql, args });
              if (sql.includes('FROM migration_runs')) return stan ? { ...stan } : null;
              if (sql.includes('FROM migration_items')) {
                if (sql.includes('SUM(CASE')) {
                  const links = [...markery].filter(x => x.startsWith('links|')).length;
                  const subscriptions = [...markery].filter(x => x.startsWith('subscriptions|')).length;
                  return { links, subscriptions, total: links + subscriptions };
                }
                if (sql.includes("phase = 'links'")) return markery.has('links|' + args[1]) ? { imported: 1 } : null;
                if (sql.includes("phase = 'subscriptions'")) return markery.has('subscriptions|' + args[1]) ? { imported: 1 } : null;
              }
              throw new Error('Nieobsługiwane SQL first: ' + sql);
            },
          };
        },
      };
    },
    async batch(polecenia) {
      wywolania.push({ typ: 'batch', liczba: polecenia.length });
      if (polecenia.length === 2 && polecenia[0].sql.includes('INSERT INTO channels') && polecenia[1].sql.includes('INSERT INTO migration_runs')) {
        const [kanalId, nick, created, updated, sprawdzKanal, current, tokenNowy] = polecenia[0].args;
        const aktywny = stan && stan.status === 'running' && stan.lease_expires_at_ms > current && stan.lease_token !== tokenNowy;
        if (!aktywny) wywolania.push({ typ: 'channel_upsert', kanalId, nick });
        const [broadcasterId, leaseToken, expiry, started, changed, now, tokenAgain] = polecenia[1].args;
        let zmiany = 0;
        if (!aktywny && (!stan || stan.status !== 'completed') && (!stan || stan.lease_expires_at_ms == null || stan.lease_expires_at_ms <= now || stan.lease_token === tokenAgain)) {
          if (!stan) stan = { broadcaster_id: broadcasterId, status: 'running', phase: fazaPoczatkowa, cursor: null, counts_json: fazaPoczatkowa === 'subscriptions' ? JSON.stringify({ links_seen: 1, links_valid: 1, links_imported: 1, links_skipped: 0, links_conflicts: 0 }) : '{}', lease_token: leaseToken, lease_expires_at_ms: expiry, started_at_ms: started, updated_at_ms: changed };
          else Object.assign(stan, { lease_token: leaseToken, lease_expires_at_ms: expiry, updated_at_ms: changed });
          zmiany = 1;
        }
        return [{ success: true, meta: { changes: aktywny ? 0 : 1 } }, { success: true, meta: { changes: zmiany } }];
      }
      for (const polecenie of polecenia) {
        if (polecenie.sql.includes('INSERT INTO account_links')) {
          const [broadcasterId, discordId, kickId, username, linkedAt, updatedAt] = polecenie.args;
          const key = broadcasterId + '|' + discordId;
          if (!rekordy.has(key)) rekordy.set(key, { kickId, username, linkedAt, updatedAt });
        } else if (polecenie.sql.includes('INSERT OR IGNORE INTO migration_items') && polecenie.sql.includes("'links'")) {
          const [broadcasterId, sourceKey, importedAt, checkBroadcaster, discordId, kickId] = polecenie.args;
          const link = rekordy.get(checkBroadcaster + '|' + discordId);
          if (link?.kickId === kickId) markery.add('links|' + sourceKey);
        } else if (polecenie.sql.includes('INSERT OR IGNORE INTO migration_items') && polecenie.sql.includes("'subscriptions'")) {
          const [broadcasterId, sourceKey] = polecenie.args;
          markery.add('subscriptions|' + sourceKey);
        } else if (polecenie.sql.includes('INSERT INTO subscriptions')) {
          const [broadcasterId, subscriberKey, kickId, username, expiry, source] = polecenie.args;
          subskrypcjeD1.set(broadcasterId + '|' + subscriberKey, { kickId, username, expiry, source });
        } else {
          throw new Error('Nieobsługiwane SQL batch: ' + polecenie.sql);
        }
      }
      return polecenia.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };

  const wpisy = new Map();
  for (let i = 0; i < subskrypcje; i++) {
    const username = 'Sub' + i;
    wpisy.set('sub:' + username.toLowerCase(), { username, user_id: String(300000000 + i), expires_at: new Date(Date.now() + 86400000).toISOString(), source: 'admin' });
  }
  for (let i = 0; i < (fazaPoczatkowa === 'subscriptions' ? 0 : 50); i++) {
    const discordId = String(10000000000000000n + BigInt(i));
    const kickId = String(200000000 + i);
    const key = 'link:discord:' + discordId;
    wpisy.set(key, { discord_id: discordId, kick_user_id: kickId, username: 'Widz' + i });
  }

  const env = {
    BOT_API_SECRET: sekret,
    KICK_BROADCASTER_ID: kanal,
    D1_ENABLED: 'false',
    DB: db,
    SUBS_KV: {
      async get(key, type) {
        if (key === 'ljay:tokens') return { access_token: token, refresh_token: 'refresh', expires_at: Date.now() + 300000 };
        if (key === 'config:broadcaster_id') return kanal;
        if (key.startsWith('link:discord:')) {
          if (blokujPierwszyOdczyt && !zablokowano) {
            zablokowano = true;
            sygnalOdczytu();
            await bramkaOdczytu;
          }
          const value = wpisy.get(key) ?? null;
          return type === 'json' ? value : value;
        }
        if (key.startsWith('sub:')) {
          const value = wpisy.get(key) ?? null;
          return type === 'json' ? value : value;
        }
        return null;
      },
      async list({ prefix }) {
        const keys = [...wpisy.keys()].filter(key => key.startsWith(prefix)).sort();
        return { keys: keys.map(name => ({ name })), list_complete: true };
      },
      async put() { throw new Error('Migracja nie powinna zapisywać KV.'); },
      async delete() { throw new Error('Migracja nie powinna usuwać KV.'); },
    },
  };

  return {
    env, stan: () => stan, rekordy, subskrypcjeD1, markery, wywolania,
    odczytRozpoczety, odblokujOdczyt: zwolnijOdczyt,
  };
}

function requestMigracji() {
  return new Request('https://worker.test/api/admin/migrate-kv?dry_run=false', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + sekret },
  });
}

async function zFetchiemKick(fn) {
  const poprzedniFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.kick.com/public/v1/users');
    return new Response(JSON.stringify({ data: [{ user_id: kanal, username: 'testchannel' }] }), { status: 200 });
  };
  try { return await fn(); } finally { globalThis.fetch = poprzedniFetch; }
}

test('handler wznowi import 50 linków po awarii checkpointu bez duplikatów', async () => {
  const srodowisko = utworzSrodowisko({ bladCheckpoint: true });
  await zFetchiemKick(async () => {
    const pierwsza = await worker.fetch(requestMigracji(), srodowisko.env);
    assert.equal(pierwsza.status, 500);
    assert.equal(srodowisko.rekordy.size, 50);
    assert.equal(srodowisko.markery.size, 50);
    assert.equal(srodowisko.stan().phase, 'links');
    assert.equal(srodowisko.stan().cursor, null);
    assert.equal(JSON.parse(srodowisko.stan().counts_json).links_seen ?? 0, 0);

    const wznowiona = await worker.fetch(requestMigracji(), srodowisko.env);
    assert.equal(wznowiona.status, 200);
    const raport = await wznowiona.json();
    assert.equal(raport.processed_this_request, 50);
    assert.equal(raport.links_imported, 50);
    assert.equal(srodowisko.rekordy.size, 50);
    assert.equal(srodowisko.markery.size, 50);
    assert.equal(srodowisko.stan().phase, 'subscriptions');
    assert.equal(JSON.parse(srodowisko.stan().counts_json).links_seen, 50);
  });
});

test('drugi request handlera dostaje 409, gdy pierwszy utrzymuje lease', async () => {
  const srodowisko = utworzSrodowisko({ blokujPierwszyOdczyt: true });
  await zFetchiemKick(async () => {
    const pierwszyPromise = worker.fetch(requestMigracji(), srodowisko.env);
    await srodowisko.odczytRozpoczety;
    const drugi = await worker.fetch(requestMigracji(), srodowisko.env);
    assert.equal(drugi.status, 409);
    assert.equal((await drugi.json()).error, 'migration_locked');
    srodowisko.odblokujOdczyt();
    const pierwszy = await pierwszyPromise;
    assert.equal(pierwszy.status, 200);
    assert.equal(srodowisko.rekordy.size, 50);
  });
});


test('handler wznowi import subskrypcji po awarii checkpointu bez duplikatów', async () => {
  const srodowisko = utworzSrodowisko({ bladCheckpoint: true, fazaPoczatkowa: 'subscriptions', subskrypcje: 3 });
  await zFetchiemKick(async () => {
    const pierwsza = await worker.fetch(requestMigracji(), srodowisko.env);
    assert.equal(pierwsza.status, 500);
    assert.equal(srodowisko.subskrypcjeD1.size, 3);
    assert.equal([...srodowisko.markery].filter((x) => x.startsWith('subscriptions|')).length, 3);
    assert.equal(srodowisko.stan().phase, 'subscriptions');
    assert.equal(srodowisko.stan().cursor, null);

    const wznowiona = await worker.fetch(requestMigracji(), srodowisko.env);
    assert.equal(wznowiona.status, 200);
    const raport = await wznowiona.json();
    assert.equal(raport.complete, true);
    assert.equal(raport.subscriptions_imported, 3);
    assert.equal(srodowisko.subskrypcjeD1.size, 3);
    assert.equal([...srodowisko.markery].filter((x) => x.startsWith('subscriptions|')).length, 3);
  });
});

test('zablokowane żądanie nie wykonuje upsertu kanału', async () => {
  const srodowisko = utworzSrodowisko({ blokujPierwszyOdczyt: true });
  await zFetchiemKick(async () => {
    const pierwszyPromise = worker.fetch(requestMigracji(), srodowisko.env);
    await srodowisko.odczytRozpoczety;
    const liczbaUpsertowPrzed = srodowisko.wywolania.filter((x) => x.typ === 'channel_upsert').length;
    const drugi = await worker.fetch(requestMigracji(), srodowisko.env);
    assert.equal(drugi.status, 409);
    assert.equal(srodowisko.wywolania.filter((x) => x.typ === 'channel_upsert').length, liczbaUpsertowPrzed);
    srodowisko.odblokujOdczyt();
    await pierwszyPromise;
  });
});


test('wznowienie po awarii finalizacji nie przetwarza ponownie stron KV', async () => {
  const srodowisko = utworzSrodowisko({
    bladFinalizacji: true, fazaPoczatkowa: 'subscriptions', subskrypcje: 3,
  });
  await zFetchiemKick(async () => {
    const pierwsza = await worker.fetch(requestMigracji(), srodowisko.env);
    assert.equal(pierwsza.status, 500);
    assert.equal(srodowisko.stan().status, 'running');
    assert.equal(srodowisko.stan().phase, 'completed');
    assert.equal(srodowisko.subskrypcjeD1.size, 3);
    const licznikiPoPierwszej = JSON.parse(srodowisko.stan().counts_json);

    const wznowiona = await worker.fetch(requestMigracji(), srodowisko.env);
    assert.equal(wznowiona.status, 200);
    const raport = await wznowiona.json();
    assert.equal(raport.complete, true);
    assert.equal(raport.processed_this_request, 0);
    assert.equal(raport.subscriptions_seen, 3);
    assert.equal(raport.subscriptions_valid, 3);
    assert.equal(raport.subscriptions_imported, 3);
    assert.deepEqual(JSON.parse(srodowisko.stan().counts_json), licznikiPoPierwszej);
    assert.equal(srodowisko.subskrypcjeD1.size, 3);
    assert.equal(srodowisko.stan().status, 'completed');
  });
});
