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
      CREATE TABLE IF NOT EXISTS oauth_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        issued_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    const kolumnyTokenow = this.sql.exec('PRAGMA table_info(oauth_credentials)').toArray();
    if (!kolumnyTokenow.some((kolumna) => kolumna.name === 'issued_at')) {
      this.sql.exec('ALTER TABLE oauth_credentials ADD COLUMN issued_at INTEGER NOT NULL DEFAULT 0');
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS cutover_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        broadcaster_id TEXT NOT NULL,
        backend TEXT NOT NULL CHECK (backend = 'd1')
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS cutover_registry (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        broadcaster_id TEXT NOT NULL,
        backend TEXT NOT NULL CHECK (backend = 'd1')
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_locks (
        lock_name TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL
      )
    `);
  }


  #sprawdzDaneTokenow(dane) {
    if (!dane || typeof dane !== 'object' || Array.isArray(dane)
      || typeof dane.access_token !== 'string' || !dane.access_token
      || typeof dane.refresh_token !== 'string' || !dane.refresh_token
      || !Number.isSafeInteger(dane.expires_at) || dane.expires_at <= 0) {
      throw new TypeError('Nieprawidłowe dane tokenów właściciela.');
    }
  }

  async pobierzTokeny() {
    return this.sql.exec(
      'SELECT access_token, refresh_token, expires_at FROM oauth_credentials WHERE id = 1',
    ).toArray()[0] || null;
  }

  async zainicjujTokeny(dane) {
    this.#sprawdzDaneTokenow(dane);
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO oauth_credentials (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        dane.access_token, dane.refresh_token, dane.expires_at,
      );
      return this.sql.exec(
        'SELECT access_token, refresh_token, expires_at FROM oauth_credentials WHERE id = 1',
      ).toArray()[0] || null;
    });
  }

  async zapiszTokeny(dane, rozpoczecieAt = Date.now()) {
    this.#sprawdzDaneTokenow(dane);
    if (!Number.isSafeInteger(rozpoczecieAt) || rozpoczecieAt < 0) {
      throw new TypeError('Nieprawidłowy czas rozpoczęcia autoryzacji OAuth.');
    }
    return this.ctx.storage.transactionSync(() => {
      const wynik = this.sql.exec(
        `INSERT INTO oauth_credentials (id, access_token, refresh_token, expires_at, issued_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           issued_at = excluded.issued_at
         WHERE oauth_credentials.issued_at < excluded.issued_at
         RETURNING id`,
        dane.access_token, dane.refresh_token, dane.expires_at, rozpoczecieAt,
      ).toArray();
      return wynik.length === 1;
    });
  }

  async zapiszOdswiezoneTokeny(dane, idBlokady, poprzedniRefreshToken) {
    this.#sprawdzDaneTokenow(dane);
    if (typeof idBlokady !== 'string' || idBlokady.length > 64
      || typeof poprzedniRefreshToken !== 'string' || !poprzedniRefreshToken) return false;
    return this.ctx.storage.transactionSync(() => {
      const blokada = this.sql.exec(
        'SELECT reservation_id FROM oauth_locks WHERE lock_name = ? AND reservation_id = ? AND lease_until > ?',
        'broadcaster', idBlokady, Date.now(),
      ).toArray()[0];
      if (!blokada) return false;
      const wynik = this.sql.exec(
        `UPDATE oauth_credentials
         SET access_token = ?, refresh_token = ?, expires_at = ?,
             issued_at = MAX(issued_at + 1, ?)
         WHERE id = 1 AND refresh_token = ?
         RETURNING id`,
        dane.access_token, dane.refresh_token, dane.expires_at, Date.now(), poprzedniRefreshToken,
      ).toArray();
      return wynik.length === 1;
    });
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

  async pobierzStanCutoveru(broadcasterId) {
    if (typeof broadcasterId !== 'string' || !/^[0-9]{1,32}$/.test(broadcasterId)) {
      throw new TypeError('Nieprawidłowy broadcaster ID dla latcha cutoveru.');
    }
    const wpis = this.sql.exec(
      'SELECT broadcaster_id, backend FROM cutover_state WHERE id = 1',
    ).toArray()[0];
    if (!wpis) return null;
    if (wpis.broadcaster_id !== broadcasterId) {
      throw new Error('Durable Object cutoveru jest przypisany do innego kanału Kick.');
    }
    return wpis.backend;
  }

  async pobierzGlobalnyStanCutoveru() {
    const wpis = this.sql.exec(
      'SELECT broadcaster_id, backend FROM cutover_registry WHERE id = 1',
    ).toArray()[0];
    return wpis ? { broadcaster_id: wpis.broadcaster_id, backend: wpis.backend } : null;
  }

  async oznaczGlobalnyCutoverD1(broadcasterId) {
    if (typeof broadcasterId !== 'string' || !/^[0-9]{1,32}$/.test(broadcasterId)) {
      throw new TypeError('Nieprawidłowy broadcaster ID dla rejestru cutoveru.');
    }
    return this.ctx.storage.transactionSync(() => {
      const obecny = this.sql.exec(
        'SELECT broadcaster_id, backend FROM cutover_registry WHERE id = 1',
      ).toArray()[0];
      if (obecny && obecny.broadcaster_id !== broadcasterId) {
        throw new Error('Rejestr cutoveru jest trwale przypisany do innego kanału Kick.');
      }
      if (obecny?.backend === 'd1') return true;
      this.sql.exec(
        `INSERT INTO cutover_registry (id, broadcaster_id, backend)
         VALUES (1, ?, 'd1')
         ON CONFLICT(id) DO UPDATE SET backend = 'd1'`,
        broadcasterId,
      );
      return true;
    });
  }

  async oznaczCutoverD1(broadcasterId) {
    if (typeof broadcasterId !== 'string' || !/^[0-9]{1,32}$/.test(broadcasterId)) {
      throw new TypeError('Nieprawidłowy broadcaster ID dla latcha cutoveru.');
    }
    return this.ctx.storage.transactionSync(() => {
      const obecny = this.sql.exec(
        'SELECT broadcaster_id, backend FROM cutover_state WHERE id = 1',
      ).toArray()[0];
      if (obecny && obecny.broadcaster_id !== broadcasterId) {
        throw new Error('Nie można zmienić broadcaster ID przypisanego do latcha cutoveru.');
      }
      if (obecny?.backend === 'd1') return true;
      this.sql.exec(
        `INSERT INTO cutover_state (id, broadcaster_id, backend)
         VALUES (1, ?, 'd1')
         ON CONFLICT(id) DO UPDATE SET backend = 'd1'`,
        broadcasterId,
      );
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
