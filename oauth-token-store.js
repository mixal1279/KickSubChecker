/**
 * Shardowany magazyn jednorazowych tokenów OAuth.
 * SQLite DO zapewnia atomowy read-modify-write w transactionSync.
 */
import { DurableObject } from 'cloudflare:workers';

export class OAuthTokenStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = this.ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token TEXT PRIMARY KEY,
        typ TEXT NOT NULL,
        dane TEXT NOT NULL,
        wygasa_at INTEGER NOT NULL,
        rezerwacja_id TEXT,
        rezerwacja_do INTEGER
      )
    `);
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(wygasa_at)');
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_locks (
        lock_name TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL
      )
    `);
  }

  async zapisz(token, typ, dane, wygasaAt) {
    this.#sprawdz(token, typ);
    if (!dane || typeof dane !== 'object' || Array.isArray(dane)) {
      throw new TypeError('Dane tokena muszą być obiektem.');
    }
    if (!Number.isSafeInteger(wygasaAt) || wygasaAt <= Date.now()) {
      throw new TypeError('Nieprawidłowy termin wygaśnięcia tokena.');
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO oauth_tokens (token, typ, dane, wygasa_at) VALUES (?, ?, ?, ?)',
        token, typ, JSON.stringify(dane), wygasaAt,
      );
    });
    const proponowanyAlarm = Math.min(wygasaAt, Date.now() + 60_000);
    const obecnyAlarm = await this.ctx.storage.getAlarm();
    if (obecnyAlarm == null || proponowanyAlarm < obecnyAlarm) {
      await this.ctx.storage.setAlarm(proponowanyAlarm);
    }
    return true;
  }

  async alarm() {
    const teraz = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM oauth_tokens WHERE wygasa_at <= ?', teraz);
    });
    const wynik = this.sql.exec('SELECT MIN(wygasa_at) AS najblizsze FROM oauth_tokens').toArray()[0];
    if (Number.isSafeInteger(wynik?.najblizsze)) {
      await this.ctx.storage.setAlarm(wynik.najblizsze);
    }
  }

  async zuzyj(token, typ) {
    const rezerwacja = await this.zarezerwuj(token, typ, 30_000);
    if (!rezerwacja) return null;
    if (!await this.zakoncz(token, typ, rezerwacja.id)) return null;
    return rezerwacja.dane;
  }

  async zarezerwuj(token, typ, czasRezerwacji = 30_000) {
    const teraz = Date.now();
    this.#sprawdz(token, typ);
    if (!Number.isSafeInteger(teraz) || teraz < 0
      || !Number.isSafeInteger(czasRezerwacji) || czasRezerwacji < 1_000 || czasRezerwacji > 120_000) {
      throw new TypeError('Nieprawidłowe parametry rezerwacji tokena.');
    }

    return this.ctx.storage.transactionSync(() => {
      const wpis = this.sql.exec(
        'SELECT typ, dane, wygasa_at, rezerwacja_do FROM oauth_tokens WHERE token = ?',
        token,
      ).toArray()[0];
      if (!wpis || wpis.typ !== typ || wpis.wygasa_at <= teraz) {
        if (wpis) this.sql.exec('DELETE FROM oauth_tokens WHERE token = ?', token);
        return null;
      }
      if (wpis.rezerwacja_do != null && wpis.rezerwacja_do > teraz) return null;
      const id = crypto.randomUUID();
      this.sql.exec(
        'UPDATE oauth_tokens SET rezerwacja_id = ?, rezerwacja_do = ? WHERE token = ?',
        id, teraz + czasRezerwacji, token,
      );
      return { id, dane: JSON.parse(wpis.dane) };
    });
  }

  async zakoncz(token, typ, id) {
    this.#sprawdz(token, typ);
    if (typeof id !== 'string' || id.length > 64) return false;
    return this.ctx.storage.transactionSync(() => {
      const usuniete = this.sql.exec(
        'DELETE FROM oauth_tokens WHERE token = ? AND typ = ? AND rezerwacja_id = ? AND rezerwacja_do > ? RETURNING token',
        token, typ, id, Date.now(),
      ).toArray();
      return usuniete.length === 1;
    });
  }

  async zwolnij(token, typ, id) {
    this.#sprawdz(token, typ);
    if (typeof id !== 'string' || id.length > 64) return false;
    return this.ctx.storage.transactionSync(() => {
      const zmienione = this.sql.exec(
        'UPDATE oauth_tokens SET rezerwacja_id = NULL, rezerwacja_do = NULL WHERE token = ? AND typ = ? AND rezerwacja_id = ? RETURNING token',
        token, typ, id,
      ).toArray();
      return zmienione.length === 1;
    });
  }

  async zarezerwujBlokade(nazwa, czasRezerwacji = 30_000) {
    if (typeof nazwa !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(nazwa)) {
      throw new TypeError('Nieprawidłowa nazwa blokady.');
    }
    const teraz = Date.now();
    if (!Number.isSafeInteger(czasRezerwacji) || czasRezerwacji < 1_000 || czasRezerwacji > 120_000) {
      throw new TypeError('Nieprawidłowy czas blokady.');
    }
    const id = crypto.randomUUID();
    const wynik = this.ctx.storage.transactionSync(() => this.sql.exec(
      `INSERT INTO oauth_locks (lock_name, reservation_id, lease_until)
       VALUES (?, ?, ?)
       ON CONFLICT(lock_name) DO UPDATE SET
         reservation_id = excluded.reservation_id,
         lease_until = excluded.lease_until
       WHERE oauth_locks.lease_until <= ?
       RETURNING lock_name`,
      nazwa, id, teraz + czasRezerwacji, teraz,
    ).toArray());
    return wynik.length === 1 ? id : null;
  }

  async zwolnijBlokade(nazwa, id) {
    if (typeof nazwa !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(nazwa)
      || typeof id !== 'string' || id.length > 64) return false;
    return this.ctx.storage.transactionSync(() => this.sql.exec(
      'DELETE FROM oauth_locks WHERE lock_name = ? AND reservation_id = ? RETURNING lock_name',
      nazwa, id,
    ).toArray().length === 1);
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
