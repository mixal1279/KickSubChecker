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

  const broadcasterId = noweId();
  const discordId = noweId();
  const kickId = noweId();
  const teraz = Date.now();
  let kanalUtworzony = false;

  try {
    await zapytaj(
      'INSERT INTO channels (broadcaster_id, broadcaster_username, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
      [broadcasterId, 'd1-integration-test', teraz, teraz],
    );
    kanalUtworzony = true;

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

    const fk = await zapytaj('PRAGMA foreign_key_check');
    assert.deepEqual(fk.results, [], 'Baza nie może zawierać naruszeń kluczy obcych.');

  } finally {
    if (kanalUtworzony) {
      await zapytaj('DELETE FROM channels WHERE broadcaster_id = ?', [broadcasterId]);
      kanalUtworzony = false;
    }

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
