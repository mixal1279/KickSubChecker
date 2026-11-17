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
    const rezerwacja = await this.zarezerwuj(token, typ, teraz, 30_000);
    if (!rezerwacja) return null;
    await this.zakoncz(token, typ, rezerwacja.id);
    return rezerwacja.dane;
  }

  async zarezerwuj(token, typ, teraz = Date.now(), czasRezerwacji = 30_000) {
    this.#sprawdz(token, typ);
    if (!Number.isSafeInteger(teraz) || teraz < 0
      || !Number.isSafeInteger(czasRezerwacji) || czasRezerwacji < 1_000 || czasRezerwacji > 120_000) {
      throw new TypeError('Nieprawidłowe parametry rezerwacji tokena.');
    }

    const klucz = `jednorazowy:${token}`;
    return this.ctx.storage.transaction(async (tx) => {
      const wpis = await tx.get(klucz);
      if (!wpis || wpis.typ !== typ || !Number.isSafeInteger(wpis.wygasa_at) || wpis.wygasa_at <= teraz) {
        if (wpis) await tx.delete(klucz);
        return null;
      }
      if (wpis.rezerwacja_do > teraz) return null;
      const id = crypto.randomUUID();
      await tx.put(klucz, { ...wpis, rezerwacja_id: id, rezerwacja_do: teraz + czasRezerwacji });
      return { id, dane: wpis.dane };
    });
  }

  async zakoncz(token, typ, id) {
    this.#sprawdz(token, typ);
    if (typeof id !== 'string' || id.length > 64) return false;
    const klucz = `jednorazowy:${token}`;
    return this.ctx.storage.transaction(async (tx) => {
      const wpis = await tx.get(klucz);
      if (!wpis || wpis.typ !== typ || wpis.rezerwacja_id !== id) return false;
      await tx.delete(klucz);
      return true;
    });
  }

  async zwolnij(token, typ, id) {
    this.#sprawdz(token, typ);
    if (typeof id !== 'string' || id.length > 64) return false;
    const klucz = `jednorazowy:${token}`;
    return this.ctx.storage.transaction(async (tx) => {
      const wpis = await tx.get(klucz);
      if (!wpis || wpis.typ !== typ || wpis.rezerwacja_id !== id) return false;
      const { rezerwacja_id: _id, rezerwacja_do: _do, ...dostepny } = wpis;
      await tx.put(klucz, dostepny);
      return true;
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
