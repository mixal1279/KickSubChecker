const ID_RE = /^[0-9]{1,32}$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,25}$/;
const SOURCE_TYPES = new Set([
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
  'gift',
  'new',
  'renewal',
  'admin',
]);

function wymagajD1(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new TypeError('Nieprawidłowe binding D1.');
  }
}

function wymagajId(value, label) {
  const id = String(value ?? '');
  if (!ID_RE.test(id)) throw new TypeError(`Nieprawidłowy ${label}.`);
  return id;
}

function normalizujNick(value) {
  if (typeof value !== 'string') throw new TypeError('Nieprawidłowy nick Kick.');
  const nick = value.trim();
  if (!USERNAME_RE.test(nick)) throw new TypeError('Nieprawidłowy nick Kick.');
  return nick;
}

function sprawdzWynik(result, label) {
  if (result?.success === false) throw new Error(`${label}: ${result.error || 'błąd D1'}`);
  return result;
}

function przygotujAudyt(db, dane) {
  return db.prepare(`
    INSERT INTO audit_log
      (broadcaster_id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    dane.broadcasterId,
    dane.actorType || 'system',
    dane.actorId || null,
    dane.action,
    dane.targetType || null,
    dane.targetId || null,
    JSON.stringify(dane.metadata || {}),
    Date.now(),
  );
}

export function utworzRepozytoriumD1(db) {
  wymagajD1(db);

  return {
    async zapiszKanal({ broadcasterId, username }) {
      const id = wymagajId(broadcasterId, 'ID kanału Kick');
      const nick = normalizujNick(username);
      const teraz = Date.now();
      const wynik = await db.prepare(`
        INSERT INTO channels (broadcaster_id, broadcaster_username, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(broadcaster_id) DO UPDATE SET
          broadcaster_username = excluded.broadcaster_username,
          updated_at_ms = excluded.updated_at_ms
      `).bind(id, nick, teraz, teraz).run();
      sprawdzWynik(wynik, 'Zapis kanału');
    },

    async ustawRole({ broadcasterId, guildId, roleId, actorId }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const guild = wymagajId(guildId, 'ID serwera Discord');
      const role = wymagajId(roleId, 'ID roli Discord');
      const actor = actorId == null ? null : wymagajId(actorId, 'ID administratora');
      const teraz = Date.now();
      const wynik = await db.prepare(`
        INSERT INTO guild_configs
          (broadcaster_id, guild_id, subscriber_role_id, configured_by_discord_id, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(broadcaster_id, guild_id) DO UPDATE SET
          subscriber_role_id = excluded.subscriber_role_id,
          configured_by_discord_id = excluded.configured_by_discord_id,
          updated_at_ms = excluded.updated_at_ms
      `).bind(kanal, guild, role, actor, teraz, teraz).run();
      sprawdzWynik(wynik, 'Zapis konfiguracji roli');
    },

    async pobierzRole({ broadcasterId, guildId }) {
      const wynik = await db.prepare(`
        SELECT subscriber_role_id FROM guild_configs
        WHERE broadcaster_id = ? AND guild_id = ?
      `).bind(wymagajId(broadcasterId, 'ID kanału Kick'), wymagajId(guildId, 'ID serwera Discord')).first();
      return wynik?.subscriber_role_id || null;
    },

    async polaczKonto({ broadcasterId, discordUserId, kickUserId, kickUsername, actorId }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const discord = wymagajId(discordUserId, 'ID użytkownika Discord');
      const kick = wymagajId(kickUserId, 'ID użytkownika Kick');
      const nick = normalizujNick(kickUsername);
      const teraz = Date.now();
      const polecenia = [
        db.prepare('DELETE FROM account_links WHERE broadcaster_id = ? AND discord_user_id = ?').bind(kanal, discord),
        db.prepare(`
          INSERT INTO account_links
            (broadcaster_id, discord_user_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(kanal, discord, kick, nick, teraz, teraz),
        przygotujAudyt(db, {
          broadcasterId: kanal, actorType: actorId ? 'admin' : 'discord_user',
          actorId: actorId || discord, action: 'account.linked',
          targetType: 'discord_user', targetId: discord,
          metadata: { kick_user_id: kick, kick_username: nick },
        }),
      ];
      // D1 batch wykonuje zestaw atomowo. Konflikt unikalnego kick_user_id wycofa także DELETE.
      const wyniki = await db.batch(polecenia);
      wyniki.forEach((wynik, i) => sprawdzWynik(wynik, `Łączenie kont (operacja ${i + 1})`));
    },

    async uzupelnijIdSubskrypcjiPoNicku({ broadcasterId, kickUserId, kickUsername }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const kick = wymagajId(kickUserId, 'ID użytkownika Kick');
      const nick = normalizujNick(kickUsername);
      const wynik = await db.prepare(`
        UPDATE subscriptions
        SET kick_user_id = ?
        WHERE broadcaster_id = ? AND kick_username = ? COLLATE NOCASE
          AND kick_user_id IS NULL
      `).bind(kick, kanal, nick).run();
      sprawdzWynik(wynik, 'Uzupełnienie ID historycznych subskrypcji');
      return Number(wynik.meta?.changes || 0);
    },

    async odlaczKonto({ broadcasterId, discordUserId, actorId }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const discord = wymagajId(discordUserId, 'ID użytkownika Discord');
      const wynik = await db.batch([
        db.prepare('DELETE FROM account_links WHERE broadcaster_id = ? AND discord_user_id = ?').bind(kanal, discord),
        przygotujAudyt(db, {
          broadcasterId: kanal, actorType: actorId ? 'admin' : 'discord_user',
          actorId: actorId || discord, action: 'account.unlinked',
          targetType: 'discord_user', targetId: discord,
        }),
      ]);
      wynik.forEach((element, i) => sprawdzWynik(element, `Odłączanie kont (operacja ${i + 1})`));
    },

    async pobierzPowiazanie({ broadcasterId, discordUserId }) {
      return db.prepare(`
        SELECT discord_user_id, kick_user_id, kick_username, linked_at_ms
        FROM account_links WHERE broadcaster_id = ? AND discord_user_id = ?
      `).bind(wymagajId(broadcasterId, 'ID kanału Kick'), wymagajId(discordUserId, 'ID użytkownika Discord')).first();
    },

    async pobierzPowiazania({ broadcasterId, limit = 1000, offset = 0 }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const bezpiecznyLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 1000));
      const bezpiecznyOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
      const wynik = await db.prepare(`
        SELECT discord_user_id, kick_user_id, kick_username
        FROM account_links WHERE broadcaster_id = ?
        ORDER BY discord_user_id LIMIT ? OFFSET ?
      `).bind(kanal, bezpiecznyLimit, bezpiecznyOffset).all();
      return wynik?.results || [];
    },

    async zapiszSubskrypcje({ broadcasterId, kickUserId, kickUsername, expiresAtMs, source }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const nick = normalizujNick(kickUsername);
      const kickId = kickUserId == null ? null : wymagajId(kickUserId, 'ID użytkownika Kick');
      const expiry = Number(expiresAtMs);
      if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new TypeError('Nieprawidłowa data wygaśnięcia subskrypcji.');
      if (!SOURCE_TYPES.has(source)) throw new TypeError('Nieobsługiwane źródło subskrypcji.');
      const klucz = kickId ? `id:${kickId}` : `name:${nick.toLowerCase()}`;
      const wynik = await db.prepare(`
        INSERT INTO subscriptions
          (broadcaster_id, subscriber_key, kick_user_id, kick_username, expires_at_ms, source, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(broadcaster_id, subscriber_key) DO UPDATE SET
          kick_user_id = CASE
            WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms
            THEN COALESCE(excluded.kick_user_id, subscriptions.kick_user_id)
            ELSE subscriptions.kick_user_id
          END,
          kick_username = CASE
            WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms
            THEN excluded.kick_username ELSE subscriptions.kick_username
          END,
          expires_at_ms = MAX(subscriptions.expires_at_ms, excluded.expires_at_ms),
          source = CASE
            WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms
            THEN excluded.source ELSE subscriptions.source
          END,
          updated_at_ms = CASE
            WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms
            THEN excluded.updated_at_ms ELSE subscriptions.updated_at_ms
          END
      `).bind(kanal, klucz, kickId, nick, expiry, source, Date.now()).run();
      sprawdzWynik(wynik, 'Zapis subskrypcji');
    },

    async sprawdzSubskrypcje({ broadcasterId, kickUserId, kickUsername }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const kickId = kickUserId == null || kickUserId === '' ? null : wymagajId(kickUserId, 'ID użytkownika Kick');
      const nick = kickUsername == null || kickUsername === '' ? null : normalizujNick(kickUsername);
      if (!kickId && !nick) throw new TypeError('Podaj ID lub nick użytkownika Kick.');
      // ID Kick jest identyfikatorem nadrzędnym. Nie wolno przechodzić na nick,
      // jeśli ID podano, ale nie znaleziono po nim rekordu.
      const zapytanie = kickId
        ? db.prepare(`
            SELECT kick_username, expires_at_ms, source
            FROM subscriptions
            WHERE broadcaster_id = ? AND kick_user_id = ?
            ORDER BY expires_at_ms DESC
            LIMIT 1
          `).bind(kanal, kickId)
        : db.prepare(`
            SELECT kick_username, expires_at_ms, source
            FROM subscriptions
            WHERE broadcaster_id = ? AND kick_username = ? COLLATE NOCASE
            ORDER BY expires_at_ms DESC
            LIMIT 1
          `).bind(kanal, nick);
      const rekord = await zapytanie.first();
      if (!rekord || !Number.isSafeInteger(Number(rekord.expires_at_ms))) {
        return { status: 'unknown', subscribed: null, expires_at_ms: null };
      }
      const active = Number(rekord.expires_at_ms) > Date.now();
      return { status: active ? 'active' : 'inactive', subscribed: active, expires_at_ms: Number(rekord.expires_at_ms), username: rekord.kick_username };
    },

    async przejmijWebhook({ broadcasterId, eventId, eventType }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      if (typeof eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(eventId)) throw new TypeError('Nieprawidłowe ID webhooka.');
      if (typeof eventType !== 'string' || eventType.length > 100) throw new TypeError('Nieprawidłowy typ webhooka.');
      const wynik = await db.prepare(`
        INSERT OR IGNORE INTO webhook_events
          (broadcaster_id, event_id, event_type, status, received_at_ms)
        VALUES (?, ?, ?, 'processing', ?)
      `).bind(kanal, eventId, eventType, Date.now()).run();
      sprawdzWynik(wynik, 'Rejestracja webhooka');
      if (Number(wynik.meta?.changes || 0) === 1) return true;

      // Ponawiamy błędne lub porzucone (starsze niż 5 min) przetwarzanie; aktywne i gotowe eventy są chronione.
      const ponowienie = await db.prepare(`
        UPDATE webhook_events
        SET status = 'processing', received_at_ms = ?, processed_at_ms = NULL
        WHERE broadcaster_id = ? AND event_id = ?
          AND (
            status = 'failed'
            OR (status = 'processing' AND received_at_ms < ?)
          )
      `).bind(Date.now(), kanal, eventId, Date.now() - 5 * 60 * 1000).run();
      sprawdzWynik(ponowienie, 'Ponowne przejęcie webhooka');
      return Number(ponowienie.meta?.changes || 0) === 1;
    },

    async zakonczWebhook({ broadcasterId, eventId, subscriptions }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      if (!Array.isArray(subscriptions) || subscriptions.length > 500) {
        throw new TypeError('Nieprawidłowa lista subskrypcji z webhooka.');
      }
      const teraz = Date.now();
      const polecenia = subscriptions.map((sub) => {
        const nick = normalizujNick(sub.kickUsername);
        const kickId = sub.kickUserId == null ? null : wymagajId(sub.kickUserId, 'ID użytkownika Kick');
        const expiry = Number(sub.expiresAtMs);
        if (!Number.isSafeInteger(expiry) || expiry <= 0 || !SOURCE_TYPES.has(sub.source)) throw new TypeError('Nieprawidłowe dane subskrypcji.');
        const klucz = kickId ? `id:${kickId}` : `name:${nick.toLowerCase()}`;
        return db.prepare(`
          INSERT INTO subscriptions
            (broadcaster_id, subscriber_key, kick_user_id, kick_username, expires_at_ms, source, updated_at_ms)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM webhook_events
            WHERE broadcaster_id = ? AND event_id = ? AND status = 'processing'
          )
          ON CONFLICT(broadcaster_id, subscriber_key) DO UPDATE SET
            kick_user_id = CASE
              WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms
              THEN COALESCE(excluded.kick_user_id, subscriptions.kick_user_id)
              ELSE subscriptions.kick_user_id
            END,
            kick_username = CASE
              WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms
              THEN excluded.kick_username ELSE subscriptions.kick_username
            END,
            expires_at_ms = MAX(subscriptions.expires_at_ms, excluded.expires_at_ms),
            source = CASE
              WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms
              THEN excluded.source ELSE subscriptions.source
            END,
            updated_at_ms = CASE
              WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms
              THEN excluded.updated_at_ms ELSE subscriptions.updated_at_ms
            END
        `).bind(kanal, klucz, kickId, nick, expiry, sub.source, teraz, kanal, eventId);
      });
      // D1 batch ma limit liczby instrukcji; porcje są idempotentne.
      // Event pozostaje processing do czasu zapisania wszystkich odbiorców.
      for (let i = 0; i < polecenia.length; i += 90) {
        const wyniki = await db.batch(polecenia.slice(i, i + 90));
        wyniki.forEach((wynik, j) => sprawdzWynik(wynik, `Zapis webhooka (operacja ${i + j + 1})`));
      }
      const finalizacja = await db.prepare(`
        UPDATE webhook_events SET status = 'processed', processed_at_ms = ?
        WHERE broadcaster_id = ? AND event_id = ? AND status = 'processing'
      `).bind(teraz, kanal, eventId).run();
      sprawdzWynik(finalizacja, 'Finalizacja webhooka');
    },

    async oznaczWebhookNieudany({ broadcasterId, eventId }) {
      const wynik = await db.prepare(`
        UPDATE webhook_events SET status = 'failed'
        WHERE broadcaster_id = ? AND event_id = ? AND status = 'processing'
      `).bind(wymagajId(broadcasterId, 'ID kanału Kick'), eventId).run();
      sprawdzWynik(wynik, 'Oznaczenie błędnego webhooka');
    },



    async importujPowiazanieMigracja({ broadcasterId, sourceKey, discordUserId, kickUserId, kickUsername }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const discord = wymagajId(discordUserId, 'ID użytkownika Discord');
      const kick = wymagajId(kickUserId, 'ID użytkownika Kick');
      const nick = normalizujNick(kickUsername);
      if (typeof sourceKey !== 'string' || !sourceKey.startsWith('link:discord:') || sourceKey.length > 256) throw new TypeError('Nieprawidłowy klucz źródłowy powiązania.');
      const teraz = Date.now();
      const wyniki = await db.batch([
        db.prepare(`
          INSERT INTO account_links (broadcaster_id, discord_user_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING
        `).bind(kanal, discord, kick, nick, teraz, teraz),
        db.prepare(`
          INSERT OR IGNORE INTO migration_items (broadcaster_id, phase, source_key, imported_at_ms)
          SELECT ?, 'links', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM account_links
            WHERE broadcaster_id = ? AND discord_user_id = ? AND kick_user_id = ?
          )
        `).bind(kanal, sourceKey, teraz, kanal, discord, kick),
        db.prepare(`
          SELECT 1 AS imported FROM migration_items
          WHERE broadcaster_id = ? AND phase = 'links' AND source_key = ?
          LIMIT 1
        `).bind(kanal, sourceKey),
      ]);
      wyniki.forEach((wynik, i) => sprawdzWynik(wynik, `Idempotentny import powiązania (operacja ${i + 1})`));
      return Boolean(wyniki[2]?.results?.[0]?.imported);
    },

    async importujSubskrypcjeMigracja({ broadcasterId, sourceKey, kickUserId, kickUsername, expiresAtMs, source }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const nick = normalizujNick(kickUsername);
      const kickId = kickUserId == null ? null : wymagajId(kickUserId, 'ID użytkownika Kick');
      const expiry = Number(expiresAtMs);
      if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new TypeError('Nieprawidłowa data wygaśnięcia subskrypcji.');
      if (!SOURCE_TYPES.has(source)) throw new TypeError('Nieobsługiwane źródło subskrypcji.');
      if (typeof sourceKey !== 'string' || !sourceKey.startsWith('sub:') || sourceKey.length > 256) throw new TypeError('Nieprawidłowy klucz źródłowy subskrypcji.');
      const teraz = Date.now();
      const klucz = kickId ? `id:${kickId}` : `name:${nick.toLowerCase()}`;
      const wyniki = await db.batch([
        db.prepare(`INSERT OR IGNORE INTO migration_items (broadcaster_id, phase, source_key, imported_at_ms) VALUES (?, 'subscriptions', ?, ?)`).bind(kanal, sourceKey, teraz),
        db.prepare(`
          INSERT INTO subscriptions (broadcaster_id, subscriber_key, kick_user_id, kick_username, expires_at_ms, source, updated_at_ms)
          SELECT ?, ?, COALESCE(?, (
            SELECT kick_user_id FROM account_links
            WHERE broadcaster_id = ? AND kick_username = ? COLLATE NOCASE
            LIMIT 1
          )), ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM migration_items WHERE broadcaster_id = ? AND phase = 'subscriptions' AND source_key = ?)
          ON CONFLICT(broadcaster_id, subscriber_key) DO UPDATE SET
            kick_user_id = CASE WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms THEN COALESCE(excluded.kick_user_id, subscriptions.kick_user_id) ELSE subscriptions.kick_user_id END,
            kick_username = CASE WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms THEN excluded.kick_username ELSE subscriptions.kick_username END,
            expires_at_ms = MAX(subscriptions.expires_at_ms, excluded.expires_at_ms),
            source = CASE WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms THEN excluded.source ELSE subscriptions.source END,
            updated_at_ms = CASE WHEN excluded.expires_at_ms >= subscriptions.expires_at_ms THEN excluded.updated_at_ms ELSE subscriptions.updated_at_ms END
        `).bind(kanal, klucz, kickId, kanal, nick, nick, expiry, source, teraz, kanal, sourceKey),
        db.prepare(`
          SELECT 1 AS imported FROM migration_items
          WHERE broadcaster_id = ? AND phase = 'subscriptions' AND source_key = ?
          LIMIT 1
        `).bind(kanal, sourceKey),
      ]);
      wyniki.forEach((wynik, i) => sprawdzWynik(wynik, `Idempotentny import subskrypcji (operacja ${i + 1})`));
      return Boolean(wyniki[2]?.results?.[0]?.imported);
    },


    async policzElementyMigracji({ broadcasterId }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const wynik = await db.prepare(`
        SELECT
          SUM(CASE WHEN phase = 'links' THEN 1 ELSE 0 END) AS links,
          SUM(CASE WHEN phase = 'subscriptions' THEN 1 ELSE 0 END) AS subscriptions,
          COUNT(*) AS total
        FROM migration_items WHERE broadcaster_id = ?
      `).bind(kanal).first();
      return {
        links: Number(wynik?.links || 0),
        subscriptions: Number(wynik?.subscriptions || 0),
        total: Number(wynik?.total || 0),
      };
    },

    async zapewnijKanalIPrzejmijMigracje({ broadcasterId, username, leaseToken, teraz = Date.now(), leaseMs = 60_000 }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const nick = normalizujNick(username);
      if (typeof leaseToken !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(leaseToken)) {
        throw new TypeError('Nieprawidłowy token blokady migracji.');
      }
      if (!Number.isSafeInteger(teraz) || teraz <= 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 300_000) {
        throw new TypeError('Nieprawidłowy czas blokady migracji.');
      }
      // Utworzenie kanału i przejęcie lease są jedną transakcją D1.
      const wyniki = await db.batch([
        db.prepare(`
          INSERT INTO channels (broadcaster_id, broadcaster_username, created_at_ms, updated_at_ms)
          SELECT ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM migration_runs
            WHERE broadcaster_id = ? AND status = 'running'
              AND lease_expires_at_ms > ? AND lease_token != ?
          )
          ON CONFLICT(broadcaster_id) DO UPDATE SET
            broadcaster_username = excluded.broadcaster_username,
            updated_at_ms = excluded.updated_at_ms
        `).bind(kanal, nick, teraz, teraz, kanal, teraz, leaseToken),
        db.prepare(`
          INSERT INTO migration_runs
            (broadcaster_id, status, phase, counts_json, lease_token, lease_expires_at_ms, started_at_ms, updated_at_ms)
          VALUES (?, 'running', 'links', '{}', ?, ?, ?, ?)
          ON CONFLICT(broadcaster_id) DO UPDATE SET
            status = CASE WHEN migration_runs.status = 'completed' THEN 'completed' ELSE 'running' END,
            lease_token = excluded.lease_token,
            lease_expires_at_ms = excluded.lease_expires_at_ms,
            updated_at_ms = excluded.updated_at_ms
          WHERE migration_runs.status != 'completed'
            AND (migration_runs.lease_expires_at_ms IS NULL
              OR migration_runs.lease_expires_at_ms <= ?
              OR migration_runs.lease_token = ?)
        `).bind(kanal, leaseToken, teraz + leaseMs, teraz, teraz, teraz, leaseToken),
      ]);
      wyniki.forEach((wynik, i) => sprawdzWynik(wynik, `Przygotowanie migracji (operacja ${i + 1})`));
      return Number(wyniki[1]?.meta?.changes || 0) === 1;
    },

    async przejmijMigracje({ broadcasterId, leaseToken, teraz = Date.now(), leaseMs = 60_000 }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      if (typeof leaseToken !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(leaseToken)) {
        throw new TypeError('Nieprawidłowy token blokady migracji.');
      }
      if (!Number.isSafeInteger(teraz) || teraz <= 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 300_000) {
        throw new TypeError('Nieprawidłowy czas blokady migracji.');
      }
      const wynik = await db.prepare(`
        INSERT INTO migration_runs
          (broadcaster_id, status, phase, counts_json, lease_token, lease_expires_at_ms, started_at_ms, updated_at_ms)
        VALUES (?, 'running', 'links', '{}', ?, ?, ?, ?)
        ON CONFLICT(broadcaster_id) DO UPDATE SET
          status = CASE WHEN migration_runs.status = 'completed' THEN 'completed' ELSE 'running' END,
          lease_token = excluded.lease_token,
          lease_expires_at_ms = excluded.lease_expires_at_ms,
          updated_at_ms = excluded.updated_at_ms
        WHERE migration_runs.status != 'completed'
          AND (migration_runs.lease_expires_at_ms IS NULL
            OR migration_runs.lease_expires_at_ms <= ?
            OR migration_runs.lease_token = ?)
      `).bind(kanal, leaseToken, teraz + leaseMs, teraz, teraz, teraz, leaseToken).run();
      sprawdzWynik(wynik, 'Przejęcie blokady migracji');
      return Number(wynik.meta?.changes || 0) === 1;
    },

    async pobierzStanMigracji({ broadcasterId }) {
      return db.prepare(`
        SELECT broadcaster_id, status, phase, cursor, counts_json,
          lease_token, lease_expires_at_ms, started_at_ms, updated_at_ms, completed_at_ms
        FROM migration_runs WHERE broadcaster_id = ?
      `).bind(wymagajId(broadcasterId, 'ID kanału Kick')).first();
    },

    async zapiszPostepMigracji({ broadcasterId, leaseToken, phase, cursor = null, counts, teraz = Date.now(), leaseMs = 60_000 }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      if (typeof leaseToken !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(leaseToken)) throw new TypeError('Nieprawidłowy token blokady migracji.');
      if (!['links', 'subscriptions', 'completed'].includes(phase)) throw new TypeError('Nieprawidłowy etap migracji.');
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 2048)) throw new TypeError('Nieprawidłowy kursor migracji.');
      if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new TypeError('Nieprawidłowe liczniki migracji.');
      const wynik = await db.prepare(`
        UPDATE migration_runs SET phase = ?, cursor = ?, counts_json = ?,
          lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE broadcaster_id = ? AND status = 'running'
          AND lease_token = ? AND lease_expires_at_ms > ?
      `).bind(phase, cursor, JSON.stringify(counts), teraz + leaseMs, teraz, kanal, leaseToken, teraz).run();
      sprawdzWynik(wynik, 'Zapis checkpointu migracji');
      return Number(wynik.meta?.changes || 0) === 1;
    },

    async zakonczMigracje({ broadcasterId, leaseToken, teraz = Date.now() }) {
      const wynik = await db.prepare(`
        UPDATE migration_runs SET status = 'completed', phase = 'completed',
          cursor = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
          completed_at_ms = ?, updated_at_ms = ?
        WHERE broadcaster_id = ? AND status = 'running' AND lease_token = ?
          AND lease_expires_at_ms > ?
      `).bind(teraz, teraz, wymagajId(broadcasterId, 'ID kanału Kick'), leaseToken, teraz).run();
      sprawdzWynik(wynik, 'Zakończenie migracji');
      return Number(wynik.meta?.changes || 0) === 1;
    },

    async zwolnijMigracje({ broadcasterId, leaseToken, teraz = Date.now() }) {
      const wynik = await db.prepare(`
        UPDATE migration_runs SET lease_token = NULL, lease_expires_at_ms = NULL,
          updated_at_ms = ?
        WHERE broadcaster_id = ? AND status = 'running' AND lease_token = ?
      `).bind(teraz, wymagajId(broadcasterId, 'ID kanału Kick'), leaseToken).run();
      sprawdzWynik(wynik, 'Zwolnienie blokady migracji');
      return Number(wynik.meta?.changes || 0) === 1;
    },

    async oczyscWebhooki({ retentionBeforeMs }) {
      const granica = Number(retentionBeforeMs);
      if (!Number.isSafeInteger(granica) || granica <= 0) {
        throw new TypeError('Nieprawidłowa granica retencji webhooków.');
      }
      const wyniki = await db.batch([
        db.prepare(`
          DELETE FROM webhook_events
          WHERE COALESCE(processed_at_ms, received_at_ms) < ?
        `).bind(granica),
      ]);
      wyniki.forEach((wynik, i) => sprawdzWynik(wynik, `Czyszczenie webhooków (operacja ${i + 1})`));
      return Number(wyniki[0]?.meta?.changes || 0);
    },
  };
}
