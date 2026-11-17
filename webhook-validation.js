export const OBSLUGIWANE_EVENTY_KICK = Object.freeze([
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
]);

export function walidujTypIWersjeWebhooka(typ, wersja) {
  return OBSLUGIWANE_EVENTY_KICK.includes(typ) && wersja === '1';
}

export function walidujBroadcasteraWebhooka(payload, oczekiwanyId) {
  if (typeof oczekiwanyId !== 'string' || !/^[0-9]{1,32}$/.test(oczekiwanyId)) return false;
  const otrzymanyId = payload?.broadcaster?.user_id;
  if (typeof otrzymanyId !== 'number' && typeof otrzymanyId !== 'string') return false;
  const id = String(otrzymanyId);
  return /^[0-9]{1,32}$/.test(id) && id === oczekiwanyId;
}

export function walidujWynikRejestracjiWebhookow(data) {
  const wyniki = data?.data;
  if (!Array.isArray(wyniki)) {
    return { ok: false, powod: 'missing_results', niepoprawne: [], brakujace: [...OBSLUGIWANE_EVENTY_KICK] };
  }

  const niepoprawne = [];
  const zaakceptowane = new Set();
  for (const wynik of wyniki) {
    const nazwa = wynik?.name;
    const wersja = wynik?.version;
    if (
      !OBSLUGIWANE_EVENTY_KICK.includes(nazwa)
      || wersja !== 1
      || typeof wynik.error === 'string' && wynik.error.length > 0
      || typeof wynik.subscription_id !== 'string'
      || wynik.subscription_id.length < 10
      || wynik.subscription_id.length > 128
      || zaakceptowane.has(nazwa)
    ) {
      niepoprawne.push({
        name: typeof nazwa === 'string' ? nazwa : null,
        version: Number.isInteger(wersja) ? wersja : null,
        error: typeof wynik?.error === 'string' ? wynik.error.slice(0, 200) : null,
      });
      continue;
    }
    zaakceptowane.add(nazwa);
  }

  const brakujace = OBSLUGIWANE_EVENTY_KICK.filter((nazwa) => !zaakceptowane.has(nazwa));
  return {
    ok: niepoprawne.length === 0 && brakujace.length === 0 && wyniki.length === OBSLUGIWANE_EVENTY_KICK.length,
    powod: null,
    niepoprawne,
    brakujace,
  };
}

export function walidujIdSubskrypcjiWebhooka(idNaglowka, typ, zapisaneId) {
  if (typeof idNaglowka !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(idNaglowka)) return false;
  if (!OBSLUGIWANE_EVENTY_KICK.includes(typ) || !zapisaneId || typeof zapisaneId !== 'object') return false;
  return zapisaneId[typ] === idNaglowka;
}
