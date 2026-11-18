import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { utworzRepozytoriumD1 } from '../d1-repository.js';

function utworzFakeD1({ zmiany = 1, pierwszy = null, wiersze = [] } = {}) {
  const wywolania = [];
  const db = {
    wywolania,
    prepare(sql) {
      return {
        sql,
        bind(...args) {
          return {
            sql, args,
            async run() {
              wywolania.push({ typ: 'run', sql, args });
              return { success: true, meta: { changes: zmiany } };
            },
            async first() {
              wywolania.push({ typ: 'first', sql, args });
              return pierwszy;
            },
            async all() {
              wywolania.push({ typ: 'all', sql, args });
              return { success: true, results: wiersze };
            },
          };
        },
      };
    },
    async batch(polecenia) {
      wywolania.push({ typ: 'batch', polecenia });
      return polecenia.map((_, i) => ({
        success: true,
        meta: { changes: 1 },
        results: i === 2 && pierwszy ? [pierwszy] : [],
      }));
    },
  };
  return db;
}

test('repozytorium wymaga poprawnego bindingu D1', () => {
  assert.throws(() => utworzRepozytoriumD1(null), /binding D1/);
});

test('łączenie kont jest wykonywane w jednej paczce D1', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);

  await repo.polaczKonto({
    broadcasterId: '12345',
    discordUserId: '23456',
    kickUserId: '34567',
    kickUsername: 'PrzykladowyNick',
  });

  const paczka = db.wywolania.find((x) => x.typ === 'batch');
  assert.ok(paczka);
  assert.equal(paczka.polecenia.length, 3);
  assert.match(paczka.polecenia[0].sql, /DELETE FROM account_links/);
  assert.match(paczka.polecenia[1].sql, /INSERT INTO account_links/);
  assert.match(paczka.polecenia[2].sql, /INSERT INTO audit_log/);
});

test('odrzuca niepoprawne ID i nick przed wykonaniem SQL', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);

  await assert.rejects(
    repo.polaczKonto({
      broadcasterId: '123',
      discordUserId: 'abc',
      kickUserId: '345',
      kickUsername: 'nick',
    }),
    /ID użytkownika Discord/,
  );
  await assert.rejects(
    repo.zapiszSubskrypcje({
      broadcasterId: '123',
      kickUsername: 'nick ze spacją',
      expiresAtMs: Date.now() + 60_000,
      source: 'channel.subscription.new',
    }),
    /nick Kick/,
  );
  assert.equal(db.wywolania.length, 0);
});

test('brak rekordu subskrypcji zwraca unknown, a nie inactive', async () => {
  const db = utworzFakeD1({ pierwszy: null });
  const repo = utworzRepozytoriumD1(db);
  const status = await repo.sprawdzSubskrypcje({
    broadcasterId: '12345',
    kickUsername: 'Nick',
  });
  assert.deepEqual(status, { status: 'unknown', subscribed: null, expires_at_ms: null });
});

test('pobieranie roli jest ograniczone do kanału i serwera', async () => {
  const db = utworzFakeD1({ pierwszy: { subscriber_role_id: '98765' } });
  const repo = utworzRepozytoriumD1(db);
  assert.equal(await repo.pobierzRole({ broadcasterId: '12345', guildId: '23456' }), '98765');
  assert.deepEqual(db.wywolania[0].args, ['12345', '23456']);
});

test('duplikat webhooka nie jest ponownie przejmowany', async () => {
  const db = utworzFakeD1({ zmiany: 0 });
  const repo = utworzRepozytoriumD1(db);
  assert.equal(await repo.przejmijWebhook({
    broadcasterId: '12345',
    eventId: 'event-1',
    eventType: 'channel.subscription.new',
  }), false);
  assert.equal(db.wywolania.length, 2);
  assert.match(db.wywolania[1].sql, /status = 'failed'/);
});

test('wyszukiwanie subskrypcji po ID nie wymaga nicku', async () => {
  const db = utworzFakeD1({ pierwszy: {
    kick_username: 'Nick-Z-Myslnikiem',
    expires_at_ms: Date.now() + 60_000,
    source: 'gift',
  } });
  const repo = utworzRepozytoriumD1(db);
  const status = await repo.sprawdzSubskrypcje({
    broadcasterId: '12345',
    kickUserId: '34567',
  });
  assert.equal(status.status, 'active');
  assert.equal(status.username, 'Nick-Z-Myslnikiem');
  assert.deepEqual(db.wywolania[0].args, ['12345', '34567']);
  assert.match(db.wywolania[0].sql, /kick_user_id = \?/);
  assert.doesNotMatch(db.wywolania[0].sql, /\bOR\b/);
});

test('brak rekordu po ID nie powoduje fallbacku na nick', async () => {
  const db = utworzFakeD1({ pierwszy: null });
  const repo = utworzRepozytoriumD1(db);
  const status = await repo.sprawdzSubskrypcje({
    broadcasterId: '12345',
    kickUserId: '34567',
    kickUsername: 'Nick-Z-Myslnikiem',
  });
  assert.equal(status.status, 'unknown');
  assert.deepEqual(db.wywolania[0].args, ['12345', '34567']);
  assert.doesNotMatch(db.wywolania[0].sql, /\bOR\b/);
});

test('wyszukiwanie po nicku jest używane tylko bez ID', async () => {
  const db = utworzFakeD1({ pierwszy: null });
  const repo = utworzRepozytoriumD1(db);
  await repo.sprawdzSubskrypcje({
    broadcasterId: '12345',
    kickUsername: 'Nick-Z-Myslnikiem',
  });
  assert.deepEqual(db.wywolania[0].args, ['12345', 'Nick-Z-Myslnikiem']);
  assert.match(db.wywolania[0].sql, /kick_username = \?/);
  assert.doesNotMatch(db.wywolania[0].sql, /kick_user_id = \?/);
});

test('zachowuje historyczne źródło gift i akceptuje myślnik w nicku', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await repo.zapiszSubskrypcje({
    broadcasterId: '12345',
    kickUserId: '34567',
    kickUsername: 'Nick-Z-Myslnikiem',
    expiresAtMs: Date.now() + 60_000,
    source: 'gift',
  });
  assert.equal(db.wywolania[0].typ, 'batch');
  assert.equal(db.wywolania[0].polecenia.length, 2);
  assert.match(db.wywolania[0].polecenia[0].sql, /UPDATE subscriptions SET kick_user_id/);
  assert.equal(db.wywolania[0].polecenia[1].args[5], 'gift');
  assert.equal(db.wywolania[0].polecenia[1].args[3], 'Nick-Z-Myslnikiem');
});

test('retencja usuwa stare webhooki niezależnie od statusu', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  const usuniete = await repo.oczyscWebhooki({ retentionBeforeMs: Date.now() - 30 * 24 * 60 * 60 * 1000 });
  assert.equal(usuniete, 1);
  assert.equal(db.wywolania[0].typ, 'batch');
  assert.match(db.wywolania[0].polecenia[0].sql, /DELETE FROM webhook_events/);
  assert.ok(db.wywolania[0].polecenia[0].sql.includes("COALESCE(processed_at_ms, received_at_ms)"));
});

test('retencja odrzuca nieprawidłową granicę czasu', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await assert.rejects(repo.oczyscWebhooki({ retentionBeforeMs: -1 }), /granica retencji/);
  assert.equal(db.wywolania.length, 0);
});

test('odrzuca zapytanie o subskrypcję bez nicku i ID', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await assert.rejects(
    repo.sprawdzSubskrypcje({ broadcasterId: '12345' }),
    /Podaj ID lub nick/,
  );
  assert.equal(db.wywolania.length, 0);
});


test('starszy event nie nadpisuje metadanych nowszej subskrypcji', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await repo.zapiszSubskrypcje({
    broadcasterId: '12345',
    kickUserId: '34567',
    kickUsername: 'Nick',
    expiresAtMs: Date.now() + 60_000,
    source: 'channel.subscription.renewal',
  });
  const batch = db.wywolania[0];
  assert.equal(batch.typ, 'batch');
  const sql = batch.polecenia[2].sql;
  assert.match(batch.polecenia[1].sql, /UPDATE subscriptions SET kick_user_id/);
  assert.match(sql, /WHEN excluded\.expires_at_ms >= subscriptions\.expires_at_ms/);
  assert.match(sql, /ELSE subscriptions\.source/);
  assert.match(sql, /ELSE subscriptions\.kick_username/);
});


test('blokada migracji jest przypisana do kanału i ma wygasający lease', async () => {
  const db = utworzFakeD1({ zmiany: 1 });
  const repo = utworzRepozytoriumD1(db);
  const token = 'abcdefghijklmnopqrstuvwx123456';
  assert.equal(await repo.przejmijMigracje({
    broadcasterId: '12345', leaseToken: token, teraz: 1_000_000, leaseMs: 60_000,
  }), true);
  const sql = db.wywolania[0].sql;
  assert.match(sql, /ON CONFLICT\(broadcaster_id\) DO UPDATE/);
  assert.match(sql, /lease_expires_at_ms <= \?/);
  assert.match(sql, /status != 'completed'/);
  assert.deepEqual(db.wywolania[0].args, [
    '12345', token, 1_060_000, 1_000_000, 1_000_000, 1_000_000, token,
  ]);
});

test('checkpoint wymaga aktualnego tokena lease i zapisuje kursor oraz liczniki', async () => {
  const db = utworzFakeD1({ zmiany: 1 });
  const repo = utworzRepozytoriumD1(db);
  const token = 'abcdefghijklmnopqrstuvwx123456';
  assert.equal(await repo.zapiszPostepMigracji({
    broadcasterId: '12345', leaseToken: token, phase: 'subscriptions',
    cursor: 'kv-cursor-1', counts: { links_imported: 12 }, teraz: 2_000_000,
  }), true);
  assert.match(db.wywolania[0].sql, /lease_token = \?/);
  assert.match(db.wywolania[0].sql, /lease_expires_at_ms > \?/);
  assert.deepEqual(db.wywolania[0].args, [
    'subscriptions', 'kv-cursor-1', '{"links_imported":12}',
    2_060_000, 2_000_000, '12345', token, 2_000_000,
  ]);
});

test('migracja nie może zostać zakończona bez ważnego lease', async () => {
  const db = utworzFakeD1({ zmiany: 0 });
  const repo = utworzRepozytoriumD1(db);
  assert.equal(await repo.zakonczMigracje({
    broadcasterId: '12345', leaseToken: 'abcdefghijklmnopqrstuvwx123456', teraz: 3_000_000,
  }), false);
  assert.match(db.wywolania[0].sql, /status = 'running'/);
  assert.match(db.wywolania[0].sql, /lease_expires_at_ms > \?/);
});

test('checkpoint odrzuca niepoprawny etap i kursor przed SQL', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await assert.rejects(repo.zapiszPostepMigracji({
    broadcasterId: '12345', leaseToken: 'abcdefghijklmnopqrstuvwx123456',
    phase: 'unknown', counts: {},
  }), /etap migracji/);
  await assert.rejects(repo.zapiszPostepMigracji({
    broadcasterId: '12345', leaseToken: 'abcdefghijklmnopqrstuvwx123456',
    phase: 'links', cursor: 'x'.repeat(2049), counts: {},
  }), /kursor migracji/);
  assert.equal(db.wywolania.length, 0);
});


test('import powiązania z KV używa markera idempotencji i nie tworzy audytu przy ponowieniu', async () => {
  const db = utworzFakeD1({ pierwszy: { imported: 1 } });
  const repo = utworzRepozytoriumD1(db);
  const nowy = await repo.importujPowiazanieMigracja({
    broadcasterId: '12345', sourceKey: 'link:discord:23456789012345678',
    discordUserId: '23456789012345678', kickUserId: '34567', kickUsername: 'Nick',
  });
  assert.equal(nowy, true);
  const batch = db.wywolania[0];
  assert.equal(batch.typ, 'batch');
  assert.equal(batch.polecenia.length, 3);
  assert.match(batch.polecenia[0].sql, /INSERT INTO account_links/);
  assert.match(batch.polecenia[0].sql, /ON CONFLICT DO NOTHING/);
  assert.match(batch.polecenia[1].sql, /INSERT OR IGNORE INTO migration_items/);
  assert.match(batch.polecenia[1].sql, /WHERE EXISTS/);
  assert.match(batch.polecenia[2].sql, /SELECT 1 AS imported FROM migration_items/);
  assert.equal(db.wywolania.length, 1, 'Odczyt markera musi być częścią tego samego batcha.');
  assert.doesNotMatch(batch.polecenia.map(x => x.sql).join(' '), /audit_log/);
});

test('import subskrypcji z KV zapisuje marker i rekord w jednej paczce', async () => {
  const db = utworzFakeD1({ pierwszy: { imported: 1 } });
  const repo = utworzRepozytoriumD1(db);
  const nowa = await repo.importujSubskrypcjeMigracja({
    broadcasterId: '12345', sourceKey: 'sub:testuser',
    kickUserId: '34567', kickUsername: 'TestUser',
    expiresAtMs: Date.now() + 60_000, source: 'admin',
  });
  assert.equal(nowa, true);
  const batch = db.wywolania[0];
  assert.equal(batch.typ, 'batch');
  assert.equal(batch.polecenia.length, 3);
  assert.match(batch.polecenia[0].sql, /INSERT OR IGNORE INTO migration_items/);
  assert.match(batch.polecenia[1].sql, /INSERT INTO subscriptions/);
  assert.match(batch.polecenia[1].sql, /ON CONFLICT\(broadcaster_id, subscriber_key\) DO UPDATE/);
  assert.match(batch.polecenia[2].sql, /SELECT 1 AS imported FROM migration_items/);
  assert.equal(db.wywolania.length, 1, 'Odczyt markera musi być częścią tego samego batcha.');
});

test('import migracyjny odrzuca klucz spoza właściwego prefiksu przed SQL', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await assert.rejects(repo.importujPowiazanieMigracja({
    broadcasterId: '12345', sourceKey: 'sub:wrong',
    discordUserId: '23456789012345678', kickUserId: '34567', kickUsername: 'Nick',
  }), /klucz źródłowy/);
  await assert.rejects(repo.importujSubskrypcjeMigracja({
    broadcasterId: '12345', sourceKey: 'link:wrong',
    kickUserId: '34567', kickUsername: 'Nick',
    expiresAtMs: Date.now() + 60_000, source: 'admin',
  }), /klucz źródłowy/);
  assert.equal(db.wywolania.length, 0);
});


test('liczniki migracji są pobierane z trwałych markerów D1', async () => {
  const db = utworzFakeD1({ pierwszy: { links: 3, subscriptions: 7, total: 10 } });
  const repo = utworzRepozytoriumD1(db);
  assert.deepEqual(await repo.policzElementyMigracji({ broadcasterId: '12345' }), {
    links: 3, subscriptions: 7, total: 10,
  });
  assert.equal(db.wywolania[0].typ, 'first');
  assert.match(db.wywolania[0].sql, /FROM migration_items/);
  assert.deepEqual(db.wywolania[0].args, ['12345']);
});


test('równoległe żądania nie mogą jednocześnie przejąć lease tego samego kanału', async () => {
  let stan = null;
  let kolejka = Promise.resolve();
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              let zwolnij;
              const poprzedni = kolejka;
              kolejka = new Promise((resolve) => { zwolnij = resolve; });
              await poprzedni;
              try {
                const [kanal, token, expiry, started, updated, teraz, tokenPowtorzony] = args;
                if (!stan) {
                  stan = { broadcaster_id: kanal, status: 'running', lease_token: token, lease_expires_at_ms: expiry, started_at_ms: started, updated_at_ms: updated };
                  return { success: true, meta: { changes: 1 } };
                }
                if (stan.status !== 'completed' && (
                  stan.lease_expires_at_ms == null
                  || stan.lease_expires_at_ms <= teraz
                  || stan.lease_token === tokenPowtorzony
                )) {
                  stan.lease_token = token;
                  stan.lease_expires_at_ms = expiry;
                  stan.updated_at_ms = updated;
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              } finally {
                zwolnij();
              }
            },
          };
        },
      };
    },
    async batch() { throw new Error('Nieoczekiwany batch'); },
  };
  const repo = utworzRepozytoriumD1(db);
  const [pierwszy, drugi] = await Promise.all([
    repo.przejmijMigracje({ broadcasterId: '12345', leaseToken: 'token-pierwszy-abcdefghijkl', teraz: 1_000_000, leaseMs: 60_000 }),
    repo.przejmijMigracje({ broadcasterId: '12345', leaseToken: 'token-drugi-abcdefghijkl', teraz: 1_000_000, leaseMs: 60_000 }),
  ]);
  assert.deepEqual([pierwszy, drugi].sort(), [false, true]);
  assert.ok(['token-pierwszy-abcdefghijkl', 'token-drugi-abcdefghijkl'].includes(stan.lease_token));
});

test('wygasły lease może zostać odzyskany, ale aktywny lease pozostaje chroniony', async () => {
  let stan = null;
  const db = {
    prepare() {
      return { bind(...args) { return { async run() {
        const [kanal, token, expiry, started, updated, teraz, tokenPowtorzony] = args;
        if (!stan) {
          stan = { broadcaster_id: kanal, status: 'running', lease_token: token, lease_expires_at_ms: expiry, started_at_ms: started, updated_at_ms: updated };
          return { success: true, meta: { changes: 1 } };
        }
        if (stan.status !== 'completed' && (
          stan.lease_expires_at_ms == null || stan.lease_expires_at_ms <= teraz || stan.lease_token === tokenPowtorzony
        )) {
          stan.lease_token = token; stan.lease_expires_at_ms = expiry;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      } }; } };
    },
    async batch() { throw new Error('Nieoczekiwany batch'); },
  };
  const repo = utworzRepozytoriumD1(db);
  assert.equal(await repo.przejmijMigracje({ broadcasterId: '12345', leaseToken: 'token-pierwszy-abcdefghijkl', teraz: 1_000_000, leaseMs: 10_000 }), true);
  assert.equal(await repo.przejmijMigracje({ broadcasterId: '12345', leaseToken: 'token-drugi-abcdefghijkl', teraz: 1_005_000, leaseMs: 10_000 }), false);
  assert.equal(await repo.przejmijMigracje({ broadcasterId: '12345', leaseToken: 'token-drugi-abcdefghijkl', teraz: 1_011_000, leaseMs: 10_000 }), true);
  assert.equal(stan.lease_token, 'token-drugi-abcdefghijkl');
});


test('kanał jest przygotowywany i lease przejmowany atomowo', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  assert.equal(await repo.zapewnijKanalIPrzejmijMigracje({
    broadcasterId: '12345',
    username: 'TestChannel',
    leaseToken: 'abcdefghijklmnopqrstuvwx123456',
    teraz: 1_000_000,
    leaseMs: 60_000,
  }), true);
  const batch = db.wywolania.find((x) => x.typ === 'batch');
  assert.ok(batch);
  assert.equal(batch.polecenia.length, 2);
  assert.match(batch.polecenia[0].sql, /INSERT INTO channels/);
  assert.match(batch.polecenia[0].sql, /NOT EXISTS/);
  assert.match(batch.polecenia[0].sql, /lease_expires_at_ms > \?/);
  assert.match(batch.polecenia[1].sql, /INSERT INTO migration_runs/);
  assert.match(batch.polecenia[1].sql, /lease_token = \?/);
});

test('atomowe przejęcie migracji odrzuca nieprawidłowy nick i nie wykonuje SQL', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await assert.rejects(repo.zapewnijKanalIPrzejmijMigracje({
    broadcasterId: '12345',
    username: 'zly nick',
    leaseToken: 'abcdefghijklmnopqrstuvwx123456',
  }), /nick Kick/);
  assert.equal(db.wywolania.length, 0);
});

test('webhook nie cofa nicku ani źródła po starszym evencie', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await repo.zakonczWebhook({
    broadcasterId: '12345',
    eventId: 'event-metadata-1',
    leaseToken: '123e4567-e89b-12d3-a456-426614174000',
    subscriptions: [{
      kickUserId: '34567',
      kickUsername: 'OldName',
      expiresAtMs: Date.now() + 60_000,
      source: 'channel.subscription.renewal',
    }],
  });
  const batch = db.wywolania.find((x) => x.typ === 'batch');
  assert.equal(batch.polecenia.length, 3);
  assert.match(batch.polecenia[0].sql, /UPDATE webhook_events SET lease_expires_at_ms/);
  assert.match(batch.polecenia[1].sql, /UPDATE subscriptions SET kick_user_id/);
  assert.match(batch.polecenia[1].sql, /status = 'processing'/);
  assert.match(batch.polecenia[1].sql, /lease_token = \?/);
  const sql = batch.polecenia[2].sql;
  assert.match(sql, /WHEN excluded\.expires_at_ms >= subscriptions\.expires_at_ms/);
  assert.match(sql, /THEN excluded\.kick_username ELSE subscriptions\.kick_username/);
  assert.match(sql, /THEN excluded\.source ELSE subscriptions\.source/);
});

test('zweryfikowane powiązanie uzupełnia ID historycznej subskrypcji po nicku', async () => {
  const db = utworzFakeD1();
  const repo = utworzRepozytoriumD1(db);
  await repo.uzupelnijIdSubskrypcjiPoNicku({
    broadcasterId: '12345',
    kickUserId: '34567',
    kickUsername: 'OldName',
  });
  const call = db.wywolania.find((x) => x.typ === 'run');
  assert.match(call.sql, /UPDATE subscriptions/);
  assert.match(call.sql, /kick_user_id IS NULL/);
  assert.ok(call.sql.includes('COUNT(DISTINCT kick_user_id)'));
  assert.deepEqual(call.args, ['34567', '12345', 'OldName', '12345', 'OldName']);
});
