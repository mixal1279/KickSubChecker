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
      return polecenia.map(() => ({ success: true, meta: { changes: 1 } }));
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
  assert.equal(db.wywolania[0].typ, 'run');
  assert.equal(db.wywolania[0].args[5], 'gift');
  assert.equal(db.wywolania[0].args[3], 'Nick-Z-Myslnikiem');
});

test('retencja usuwa wyłącznie stare zakończone webhooki', async () => {
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
