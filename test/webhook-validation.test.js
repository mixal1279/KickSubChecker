import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSLUGIWANE_EVENTY_KICK,
  walidujBroadcasteraWebhooka,
  walidujIdSubskrypcjiWebhooka,
  walidujTypIWersjeWebhooka,
  walidujWynikRejestracjiWebhookow,
} from '../webhook-validation.js';

const idKanalu = '123456789';
const pelneWyniki = () => OBSLUGIWANE_EVENTY_KICK.map((name, index) => ({
  name,
  version: 1,
  subscription_id: `01JABCDEF0123456789ABCDE${index}`,
}));

test('akceptuje tylko trzy obsługiwane eventy i wersję nagłówka 1', () => {
  for (const typ of OBSLUGIWANE_EVENTY_KICK) {
    assert.equal(walidujTypIWersjeWebhooka(typ, '1'), true);
    assert.equal(walidujTypIWersjeWebhooka(typ, '2'), false);
    assert.equal(walidujTypIWersjeWebhooka(typ, 1), false);
  }
  assert.equal(walidujTypIWersjeWebhooka('chat.message.sent', '1'), false);
  assert.equal(walidujTypIWersjeWebhooka('', '1'), false);
});

test('akceptuje wyłącznie broadcaster ID zgodny z konfiguracją', () => {
  assert.equal(walidujBroadcasteraWebhooka({ broadcaster: { user_id: 123456789 } }, idKanalu), true);
  assert.equal(walidujBroadcasteraWebhooka({ broadcaster: { user_id: idKanalu } }, idKanalu), true);
  assert.equal(walidujBroadcasteraWebhooka({ broadcaster: { user_id: '987654321' } }, idKanalu), false);
  assert.equal(walidujBroadcasteraWebhooka({ broadcaster: { user_id: '123x' } }, idKanalu), false);
  assert.equal(walidujBroadcasteraWebhooka({ broadcaster: {} }, idKanalu), false);
  assert.equal(walidujBroadcasteraWebhooka({}, idKanalu), false);
  assert.equal(walidujBroadcasteraWebhooka({ broadcaster: { user_id: idKanalu } }, ''), false);
});

test('potwierdza rejestrację tylko gdy Kick zwrócił wszystkie trzy eventy', () => {
  const wynik = walidujWynikRejestracjiWebhookow({ data: pelneWyniki() });
  assert.equal(wynik.ok, true);
  assert.deepEqual(wynik.brakujace, []);
  assert.deepEqual(wynik.niepoprawne, []);
});

test('odrzuca HTTP 200 z brakującą listą wyników', () => {
  const wynik = walidujWynikRejestracjiWebhookow({ message: 'ok' });
  assert.equal(wynik.ok, false);
  assert.equal(wynik.powod, 'missing_results');
  assert.equal(wynik.brakujace.length, 3);
});

test('wykrywa niepełną rejestrację, błędy API i brak subscription_id', () => {
  const wyniki = pelneWyniki();
  wyniki[1] = { name: wyniki[1].name, version: 1, error: 'scope denied' };
  const wynik = walidujWynikRejestracjiWebhookow({ data: wyniki });
  assert.equal(wynik.ok, false);
  assert.ok(wynik.brakujace.includes('channel.subscription.renewal'));
  assert.ok(wynik.niepoprawne.some((x) => x.error === 'scope denied'));
});

test('odrzuca duplikaty, nieznane eventy, błędną wersję i wadliwe ID', () => {
  const wyniki = pelneWyniki();
  wyniki[1] = { ...wyniki[0] };
  wyniki[2] = { name: 'unknown.event', version: 1, subscription_id: '01JABCDEF0123456789ABCDE0' };
  const wynik = walidujWynikRejestracjiWebhookow({ data: wyniki });
  assert.equal(wynik.ok, false);
  assert.ok(wynik.niepoprawne.length >= 2);
  assert.ok(wynik.brakujace.includes('channel.subscription.renewal'));
});

test('odrzuca pusty, nadmiernie długi i nieprawidłowy identyfikator subskrypcji', () => {
  for (const subscription_id of ['', 'short', 'x'.repeat(129), null]) {
    const wyniki = pelneWyniki();
    wyniki[0] = { ...wyniki[0], subscription_id };
    assert.equal(walidujWynikRejestracjiWebhookow({ data: wyniki }).ok, false);
  }
});

test('wiąże event z ID subskrypcji zarejestrowanym dla tego typu', () => {
  const identyfikatory = Object.fromEntries(
    OBSLUGIWANE_EVENTY_KICK.map((typ, index) => [typ, `01JABCDEF0123456789ABCDE${index}`]),
  );
  for (const typ of OBSLUGIWANE_EVENTY_KICK) {
    assert.equal(walidujIdSubskrypcjiWebhooka(identyfikatory[typ], typ, identyfikatory), true);
    assert.equal(walidujIdSubskrypcjiWebhooka(identyfikatory[typ], 'channel.subscription.new', identyfikatory),
      typ === 'channel.subscription.new');
  }
  assert.equal(walidujIdSubskrypcjiWebhooka('01JABCDEF0123456789ABCDE0', 'unknown', identyfikatory), false);
  assert.equal(walidujIdSubskrypcjiWebhooka('', OBSLUGIWANE_EVENTY_KICK[0], identyfikatory), false);
  assert.equal(walidujIdSubskrypcjiWebhooka('not-a-ulid', OBSLUGIWANE_EVENTY_KICK[0], identyfikatory), false);
  assert.equal(walidujIdSubskrypcjiWebhooka('01JABCDEF0123456789ABCDE0', OBSLUGIWANE_EVENTY_KICK[0], null), false);
});
