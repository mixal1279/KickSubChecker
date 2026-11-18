import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const cryptoApi = globalThis.crypto;
const klucz = await cryptoApi.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
}, true, ['sign', 'verify']);
const spki = new Uint8Array(await cryptoApi.subtle.exportKey('spki', klucz.publicKey));
const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;

const broadcasterId = '123456789';
const subscriptionId = '01JABCDEF0123456789ABCDE01';
const identyfikatory = {
  'channel.subscription.new': subscriptionId,
  'channel.subscription.renewal': '01JABCDEF0123456789ABCDE02',
  'channel.subscription.gifts': '01JABCDEF0123456789ABCDE03',
};

function utworzEnv() {
  const dane = new Map([
    ['kick:public_key', pem],
    ['config:broadcaster_id', broadcasterId],
    ['kick:webhook:subscription_ids', JSON.stringify(identyfikatory)],
  ]);
  const zapisy = [];
  return {
    zapisy,
    SUBS_KV: {
      async get(klucz, typ) {
        const wartosc = dane.get(klucz) ?? null;
        if (typ === 'json' && typeof wartosc === 'string') {
          try { return JSON.parse(wartosc); } catch { return null; }
        }
        return wartosc;
      },
      async put(klucz, wartosc) {
        dane.set(klucz, wartosc);
        zapisy.push({ klucz, wartosc });
      },
    },
  };
}

async function utworzZadanie(env, {
  payload = null,
  eventType = 'channel.subscription.new',
  eventVersion = '1',
  eventId = '01TESTEVENT0000000000000001',
  subscription = subscriptionId,
  timestamp = new Date().toISOString(),
  podpisZmieniony = false,
} = {}) {
  const dane = payload || {
    broadcaster: { user_id: broadcasterId, username: 'testchannel' },
    subscriber: { user_id: '987654321', username: 'TestSubscriber' },
    expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  const body = JSON.stringify(dane);
  const podpisanyTekst = `${eventId}.${timestamp}.${body}`;
  const podpis = new Uint8Array(await cryptoApi.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    klucz.privateKey,
    new TextEncoder().encode(podpisanyTekst),
  ));
  if (podpisZmieniony) podpis[0] ^= 0xff;
  return new Request('https://worker.test/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Kick-Event-Message-Id': eventId,
      'Kick-Event-Message-Timestamp': timestamp,
      'Kick-Event-Signature': Buffer.from(podpis).toString('base64'),
      'Kick-Event-Type': eventType,
      'Kick-Event-Version': eventVersion,
      'Kick-Event-Subscription-Id': subscription,
    },
    body,
  });
}

test('przetwarza poprawnie podpisany event dla zarejestrowanej subskrypcji kanału', async () => {
  const env = utworzEnv();
  const request = await utworzZadanie(env);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const zapis = env.zapisy.find((x) => x.klucz === 'sub:testsubscriber');
  assert.ok(zapis);
  assert.equal(JSON.parse(zapis.wartosc).user_id, '987654321');
  assert.ok(env.zapisy.some((x) => x.klucz.startsWith('webhook:seen:')));
});

test('odrzuca poprawnie podpisany event z innego kanału', async () => {
  const env = utworzEnv();
  const payload = {
    broadcaster: { user_id: '987654321' },
    subscriber: { user_id: '111', username: 'WrongChannelUser' },
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
  };
  const response = await worker.fetch(await utworzZadanie(env, { payload }), env);
  assert.equal(response.status, 403);
  assert.equal(env.zapisy.length, 0);
});

test('odrzuca event z nieznanym ID subskrypcji webhooka', async () => {
  const env = utworzEnv();
  const response = await worker.fetch(await utworzZadanie(env, { subscription: '01JABCDEF0123456789ABCDE99' }), env);
  assert.equal(response.status, 403);
  assert.equal(env.zapisy.length, 0);
});

test('odrzuca nieobsługiwaną wersję eventu mimo poprawnego podpisu', async () => {
  const env = utworzEnv();
  const response = await worker.fetch(await utworzZadanie(env, { eventVersion: '2' }), env);
  assert.equal(response.status, 400);
  assert.equal(env.zapisy.length, 0);
});

test('odrzuca zmieniony podpis i stary timestamp', async () => {
  const env = utworzEnv();
  const zlyPodpis = await worker.fetch(await utworzZadanie(env, { podpisZmieniony: true }), env);
  assert.equal(zlyPodpis.status, 401);

  const staryCzas = new Date(Date.now() - 6 * 60_000).toISOString();
  const staryEvent = await worker.fetch(await utworzZadanie(env, { timestamp: staryCzas }), env);
  assert.equal(staryEvent.status, 401);
  assert.equal(env.zapisy.length, 0);
});

test('duplikat eventu jest potwierdzany bez ponownego zapisu', async () => {
  const env = utworzEnv();
  const pierwsze = await worker.fetch(await utworzZadanie(env), env);
  const liczbaZapisow = env.zapisy.length;
  const drugie = await worker.fetch(await utworzZadanie(env), env);
  assert.equal(pierwsze.status, 200);
  assert.equal(drugie.status, 200);
  assert.equal(await drugie.text(), 'Duplicate event');
  assert.equal(env.zapisy.length, liczbaZapisow);
});

test('starszy webhook nie cofa indeksu subskrypcji po Kick user ID', async () => {
  const env = utworzEnv();
  const nowszeWygasniecie = new Date(Date.now() + 30 * 86400_000).toISOString();
  const starszeWygasniecie = new Date(Date.now() + 10 * 86400_000).toISOString();
  const nowszy = await worker.fetch(await utworzZadanie(env, {
    eventId: '01TESTEVENT0000000000000002',
    payload: {
      broadcaster: { user_id: broadcasterId, username: 'testchannel' },
      subscriber: { user_id: '987654321', username: 'NewName' },
      expires_at: nowszeWygasniecie,
    },
  }), env);
  const starszy = await worker.fetch(await utworzZadanie(env, {
    eventId: '01TESTEVENT0000000000000003',
    payload: {
      broadcaster: { user_id: broadcasterId, username: 'testchannel' },
      subscriber: { user_id: '987654321', username: 'OldName' },
      expires_at: starszeWygasniecie,
    },
  }), env);
  assert.equal(nowszy.status, 200);
  assert.equal(starszy.status, 200);
  const indeks = env.zapisy.filter((x) => x.klucz === 'sub:user_id:987654321').at(-1);
  assert.equal(JSON.parse(indeks.wartosc).username, 'NewName');
  assert.equal(JSON.parse(indeks.wartosc).expires_at, nowszeWygasniecie);
});

test('starszy webhook uzupełnia brakujące Kick User ID bez cofania daty subskrypcji', async () => {
  const env = utworzEnv();
  const nowszeWygasniecie = new Date(Date.now() + 30 * 86400_000).toISOString();
  const starszeWygasniecie = new Date(Date.now() + 10 * 86400_000).toISOString();
  await env.SUBS_KV.put('sub:historicuser', JSON.stringify({
    user_id: '',
    username: 'HistoricUser',
    expires_at: nowszeWygasniecie,
    source: 'channel.subscription.renewal',
    updated_at: new Date().toISOString(),
  }));

  const response = await worker.fetch(await utworzZadanie(env, {
    eventId: '01TESTEVENT0000000000000005',
    payload: {
      broadcaster: { user_id: broadcasterId, username: 'testchannel' },
      subscriber: { user_id: '987654322', username: 'HistoricUser' },
      expires_at: starszeWygasniecie,
    },
  }), env);

  assert.equal(response.status, 200);
  const poNicku = await env.SUBS_KV.get('sub:historicuser', 'json');
  const poId = await env.SUBS_KV.get('sub:user_id:987654322', 'json');
  assert.equal(poNicku.user_id, '987654322');
  assert.equal(poNicku.expires_at, nowszeWygasniecie);
  assert.equal(poNicku.source, 'channel.subscription.renewal');
  assert.equal(poId.user_id, '987654322');
  assert.equal(poId.expires_at, nowszeWygasniecie);
});

test('KV webhook odrzuca prezent zbyt duży dla budżetu operacji przed zapisami', async () => {
  const env = utworzEnv();
  const giftees = Array.from({ length: 201 }, (_, i) => ({
    user_id: String(900000000 + i),
    username: `GiftUser${i}`,
  }));
  const response = await worker.fetch(await utworzZadanie(env, {
    eventId: '01TESTEVENT0000000000000004',
    eventType: 'channel.subscription.gifts',
    subscription: identyfikatory['channel.subscription.gifts'],
    payload: {
      broadcaster: { user_id: broadcasterId, username: 'testchannel' },
      giftees,
      expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    },
  }), env);
  assert.equal(response.status, 413);
  assert.equal(env.zapisy.length, 0);
});

test('odrzuca zbyt duże body strumieniowe bez Content-Length przed buforowaniem całości', async () => {
  const env = utworzEnv();
  const request = new Request('https://worker.test/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(256_001));
        controller.close();
      },
    }),
    duplex: 'half',
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 413);
  assert.equal(env.zapisy.length, 0);
});
