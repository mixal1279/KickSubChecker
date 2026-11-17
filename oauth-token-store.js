/**
 * Shardowany magazyn jednorazowych tokenów OAuth.
 * Każdy shard obsługuje część tokenów; odczyt i usunięcie są jedną transakcją DO.
 */
export class OAuthTokenStore {
  constructor(ctx, _env) {
    this.ctx = ctx;
  }

  async zapisz(token, typ, dane, wygasaAt) {
    this.#sprawdz(token, typ);
    if (!dane || typeof dane !== 'object' || Array.isArray(dane)) {
      throw new TypeError('Dane tokena muszą być obiektem.');
    }
    if (!Number.isSafeInteger(wygasaAt) || wygasaAt <= Date.now()) {
      throw new TypeError('Nieprawidłowy termin wygaśnięcia tokena.');
    }

    const klucz = `jednorazowy:${token}`;
    await this.ctx.storage.transaction(async (tx) => {
      const istniejacy = await tx.get(klucz);
      if (istniejacy) throw new Error('Token jednorazowy już istnieje.');
      await tx.put(klucz, { typ, dane, wygasa_at: wygasaAt });
    });
    return true;
  }

  async zuzyj(token, typ, teraz = Date.now()) {
    this.#sprawdz(token, typ);
    if (!Number.isSafeInteger(teraz) || teraz < 0) {
      throw new TypeError('Nieprawidłowy czas zużycia tokena.');
    }

    const klucz = `jednorazowy:${token}`;
    return this.ctx.storage.transaction(async (tx) => {
      const wpis = await tx.get(klucz);
      if (!wpis) return null;
      await tx.delete(klucz);
      if (wpis.typ !== typ || !Number.isSafeInteger(wpis.wygasa_at) || wpis.wygasa_at <= teraz) {
        return null;
      }
      return wpis.dane;
    });
  }

  #sprawdz(token, typ) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
      throw new TypeError('Nieprawidłowy token jednorazowy.');
    }
    if (!['oauth-state', 'owner-start', 'link-start'].includes(typ)) {
      throw new TypeError('Nieobsługiwany typ tokena jednorazowego.');
    }
  }
}
