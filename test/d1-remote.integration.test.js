import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
const databaseId = process.env.D1_TEST_DATABASE_ID || '';
const productionDatabaseId = '8130d703-3197-41c4-b480-5dabdbf062a7';
const skonfigurowano = Boolean(accountId && apiToken && databaseId);

if (databaseId === productionDatabaseId) {
  throw new Error('Testy integracyjne odmawiają pracy na produkcyjnej bazie D1.');
}

async function zapytaj(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params: params.map(String) }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const opis = body?.errors?.map((blad) => blad.message).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(`Cloudflare D1: ${opis}`);
  }

  return body.result?.[0] || { results: [], meta: {} };
}

async function batchuj(polecenia) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        batch: polecenia.map(({ sql, params = [] }) => ({ sql, params: params.map(String) })),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const opis = body?.errors?.map((blad) => blad.message).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(`Cloudflare D1 batch: ${opis}`);
  }
  return body.result || [];
}

async function sprawdzBazeTestowa() {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    throw new Error('Nie można zweryfikować docelowej bazy D1.');
  }
  assert.equal(
    body.result?.name,
    'kick-sub-checker-test',
    'Testy mogą działać wyłącznie na bazie kick-sub-checker-test.',
  );
}

function noweId() {
  return (BigInt(Date.now()) * 1_000_000n
    + BigInt(Math.floor(Math.random() * 1_000_000))).toString();
}

test('rzeczywisty D1: ograniczenia, źródła, deduplikacja i CASCADE', {
  skip: !skonfigurowano && 'Ustaw CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN i D1_TEST_DATABASE_ID.',
}, async () => {
  await sprawdzBazeTestowa();

  const indeksId = await zapytaj(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ['idx_subscriptions_broadcaster_user_expiry'],
  );
  assert.equal(indeksId.results?.length, 1, 'Migracja 0006 musi utworzyć indeks wyszukiwania subskrypcji po Kick User ID.');
  assert.match(
    indeksId.results[0].sql,
    /ON subscriptions\\s*\\(broadcaster_id,\\s*kick_user_id,\\s*expires_at_ms DESC\\)\\s*WHERE kick_user_id IS NOT NULL/i,
  );

  const broadcasterId = noweId();
  const discordId = noweId();
  const kickId = noweId();
  const teraz = Date.now();

  try {
    await zapytaj(
      'INSERT INTO channels (broadcaster_id, broadcaster_username, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
      [broadcasterId, 'd1-integration-test', teraz, teraz],
    );

    await assert.rejects(
      zapytaj(
        "INSERT INTO channels (broadcaster_id, broadcaster_username, created_at_ms, updated_at_ms) VALUES (NULL, 'null-test', 1, 1)",
      ),
      /broadcaster_id is required/i,
    );

    await assert.rejects(
      zapytaj('UPDATE channels SET broadcaster_id = NULL WHERE broadcaster_id = ?', [broadcasterId]),
      /broadcaster_id is required/i,
    );

    const zrodla = [
      'channel.subscription.new',
      'channel.subscription.renewal',
      'channel.subscription.gifts',
      'gift',
      'new',
      'renewal',
      'admin',
    ];

    for (let i = 0; i < zrodla.length; i++) {
      await zapytaj(
        'INSERT INTO subscriptions (broadcaster_id, subscriber_key, kick_user_id, kick_username, expires_at_ms, source, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [broadcasterId, `id:${kickId}${i}`, `${kickId}${i}`, `subscriber-${i}`, teraz + 60_000, zrodla[i], teraz],
      );
    }

    await assert.rejects(
      zapytaj(
        'INSERT INTO subscriptions (broadcaster_id, subscriber_key, kick_username, expires_at_ms, source, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        [broadcasterId, 'invalid-source', 'invalid-source', teraz + 60_000, 'invalid', teraz],
      ),
      /CHECK constraint failed/i,
    );

    const link = await zapytaj(
      'INSERT INTO account_links (broadcaster_id, discord_user_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [broadcasterId, discordId, kickId, 'integration-user', teraz, teraz],
    );
    assert.equal(link.meta?.changes, 1);

    await assert.rejects(
      zapytaj(
        'INSERT INTO account_links (broadcaster_id, discord_user_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        [broadcasterId, `${discordId}1`, kickId, 'duplicate-user', teraz, teraz],
      ),
      /UNIQUE constraint failed/i,
    );

    const event = await zapytaj(
      "INSERT OR IGNORE INTO webhook_events (broadcaster_id, event_id, event_type, status, received_at_ms) VALUES (?, ?, ?, 'processing', ?)",
      [broadcasterId, 'integration-event', 'channel.subscription.new', teraz],
    );
    const duplicate = await zapytaj(
      "INSERT OR IGNORE INTO webhook_events (broadcaster_id, event_id, event_type, status, received_at_ms) VALUES (?, ?, ?, 'processing', ?)",
      [broadcasterId, 'integration-event', 'channel.subscription.new', teraz + 1],
    );
    assert.equal(event.meta?.changes, 1);
    assert.equal(duplicate.meta?.changes, 0);

    await zapytaj(
      'INSERT INTO audit_log (broadcaster_id, actor_type, actor_id, action, metadata_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [broadcasterId, 'system', 'integration-test', 'integration.test', '{}', teraz],
    );

    // Starszy webhook z ID musi uzupełnić historyczny rekord po nicku,
    // nie może jednak obniżyć jego nowszej daty wygaśnięcia.
    const historyKickId = noweId();
    const historyExpiry = teraz + 120_000;
    await zapytaj(
      'INSERT INTO subscriptions (broadcaster_id, subscriber_key, kick_user_id, kick_username, expires_at_ms, source, updated_at_ms) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      [broadcasterId, 'name:historic-user', 'historic-user', historyExpiry, 'channel.subscription.renewal', teraz],
    );
    await zapytaj(
      `UPDATE subscriptions SET kick_user_id = ?
        WHERE broadcaster_id = ? AND kick_username = ? COLLATE NOCASE
          AND kick_user_id IS NULL
          AND EXISTS (
            SELECT 1 FROM webhook_events
            WHERE broadcaster_id = ? AND event_id = ? AND status = 'processing'
          )`,
      [historyKickId, broadcasterId, 'historic-user', broadcasterId, 'integration-event'],
    );
    await zapytaj(
      'INSERT INTO subscriptions (broadcaster_id, subscriber_key, kick_user_id, kick_username, expires_at_ms, source, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [broadcasterId, `id:${historyKickId}`, historyKickId, 'historic-user', teraz + 60_000, 'channel.subscription.new', teraz + 1],
    );
    const historyById = await zapytaj(
      'SELECT kick_username, expires_at_ms, source FROM subscriptions WHERE broadcaster_id = ? AND kick_user_id = ? ORDER BY expires_at_ms DESC LIMIT 1',
      [broadcasterId, historyKickId],
    );
    assert.equal(historyById.results?.[0]?.kick_username, 'historic-user');
    assert.equal(Number(historyById.results?.[0]?.expires_at_ms), historyExpiry);
    assert.equal(historyById.results?.[0]?.source, 'channel.subscription.renewal');

    const linkSourceKey = `link:discord:${discordId}`;
    const linkBatch = [
      {
        sql: 'INSERT INTO account_links (broadcaster_id, discord_user_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        params: [broadcasterId, discordId, kickId, 'integration-user', teraz, teraz],
      },
      {
        sql: `INSERT OR IGNORE INTO migration_items (broadcaster_id, phase, source_key, imported_at_ms)
          SELECT ?, 'links', ?, ? WHERE EXISTS (
            SELECT 1 FROM account_links
            WHERE broadcaster_id = ? AND discord_user_id = ? AND kick_user_id = ?
          )`,
        params: [broadcasterId, linkSourceKey, teraz, broadcasterId, discordId, kickId],
      },
      {
        sql: "SELECT 1 AS imported FROM migration_items WHERE broadcaster_id = ? AND phase = 'links' AND source_key = ? LIMIT 1",
        params: [broadcasterId, linkSourceKey],
      },
    ];
    const linkFirst = await batchuj(linkBatch);
    const linkRetry = await batchuj(linkBatch);
    assert.equal(linkFirst[2]?.results?.[0]?.imported, 1);
    assert.equal(linkRetry[2]?.results?.[0]?.imported, 1);

    const subSourceKey = 'sub:integration-user';
    const subBatch = (expiry, username, source) => [
      {
        sql: "INSERT OR IGNORE INTO migration_items (broadcaster_id, phase, source_key, imported_at_ms) VALUES (?, 'subscriptions', ?, ?)",
        params: [broadcasterId, subSourceKey, teraz],
      },
      {
        sql: `INSERT INTO subscriptions (broadcaster_id, subscriber_key, kick_user_id, kick_username, expires_at_ms, source, updated_at_ms)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM migration_items WHERE broadcaster_id = ? AND phase = 'subscriptions' AND source_key = ?)
          ON CONFLICT(broadcaster_id, subscriber_key) DO UPDATE SET
            kick_user_id = CASE WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms THEN COALESCE(excluded.kick_user_id, subscriptions.kick_user_id) ELSE subscriptions.kick_user_id END,
            kick_username = CASE WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms THEN excluded.kick_username ELSE subscriptions.kick_username END,
            expires_at_ms = MAX(subscriptions.expires_at_ms, excluded.expires_at_ms),
            source = CASE WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms THEN excluded.source ELSE subscriptions.source END,
            updated_at_ms = CASE WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms THEN excluded.updated_at_ms ELSE subscriptions.updated_at_ms END`,
        params: [broadcasterId, `id:${kickId}`, kickId, username, expiry, source, teraz, broadcasterId, subSourceKey],
      },
      {
        sql: "SELECT 1 AS imported FROM migration_items WHERE broadcaster_id = ? AND phase = 'subscriptions' AND source_key = ? LIMIT 1",
        params: [broadcasterId, subSourceKey],
      },
    ];
    const expiryNowa = teraz + 120_000;
    const subFirst = await batchuj(subBatch(expiryNowa, 'newer-user', 'renewal'));
    const subRetry = await batchuj(subBatch(teraz + 1, 'older-user', 'new'));
    assert.equal(subFirst[2]?.results?.[0]?.imported, 1);
    assert.equal(subRetry[2]?.results?.[0]?.imported, 1);
    const subState = await zapytaj(
      'SELECT kick_username, expires_at_ms, source FROM subscriptions WHERE broadcaster_id = ? AND subscriber_key = ?',
      [broadcasterId, `id:${kickId}`],
    );
    assert.equal(subState.results?.[0]?.kick_username, 'newer-user');
    assert.equal(Number(subState.results?.[0]?.expires_at_ms), expiryNowa);
    assert.equal(subState.results?.[0]?.source, 'renewal');

    const fk = await zapytaj('PRAGMA foreign_key_check');
    assert.deepEqual(fk.results, [], 'Baza nie może zawierać naruszeń kluczy obcych.');

  } finally {
    // Zawsze wykonujemy DELETE: timeout odpowiedzi INSERT nie dowodzi, że zapis nie doszedł do D1.
    await zapytaj('DELETE FROM channels WHERE broadcaster_id = ?', [broadcasterId]);

    // Weryfikacja CASCADE jest wykonywana również po nieudanym asercie testu.
    for (const tabela of [
      'guild_configs', 'account_links', 'subscriptions', 'webhook_events',
      'audit_log', 'migration_runs', 'migration_items',
    ]) {
      const wynik = await zapytaj(`SELECT COUNT(*) AS liczba FROM ${tabela} WHERE broadcaster_id = ?`, [broadcasterId]);
      assert.equal(Number(wynik.results?.[0]?.liczba || 0), 0, `CASCADE nie wyczyścił tabeli ${tabela}.`);
    }
    const kanal = await zapytaj(
      'SELECT COUNT(*) AS liczba FROM channels WHERE broadcaster_id = ?',
      [broadcasterId],
    );
    assert.equal(Number(kanal.results?.[0]?.liczba || 0), 0, 'Rekord kanału testowego pozostał w D1.');
  }
});
