const ID_RE = /^[0-9]{1,32}$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{1,25}$/;
const SOURCE_TYPES = new Set([
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
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
          kick_user_id = COALESCE(excluded.kick_user_id, subscriptions.kick_user_id),
          kick_username = excluded.kick_username,
          expires_at_ms = MAX(subscriptions.expires_at_ms, excluded.expires_at_ms),
          source = excluded.source,
          updated_at_ms = excluded.updated_at_ms
      `).bind(kanal, klucz, kickId, nick, expiry, source, Date.now()).run();
      sprawdzWynik(wynik, 'Zapis subskrypcji');
    },

    async sprawdzSubskrypcje({ broadcasterId, kickUserId, kickUsername }) {
      const kanal = wymagajId(broadcasterId, 'ID kanału Kick');
      const kickId = kickUserId == null ? null : wymagajId(kickUserId, 'ID użytkownika Kick');
      const nick = normalizujNick(kickUsername);
      const rekord = await db.prepare(`
        SELECT kick_username, expires_at_ms, source
        FROM subscriptions
        WHERE broadcaster_id = ?
          AND ((? IS NOT NULL AND kick_user_id = ?) OR kick_username = ? COLLATE NOCASE)
        ORDER BY CASE WHEN ? IS NOT NULL AND kick_user_id = ? THEN 0 ELSE 1 END,
                 expires_at_ms DESC
        LIMIT 1
      `).bind(kanal, kickId, kickId, nick, kickId, kickId).first();
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
            kick_user_id = COALESCE(excluded.kick_user_id, subscriptions.kick_user_id),
            kick_username = excluded.kick_username,
            expires_at_ms = MAX(subscriptions.expires_at_ms, excluded.expires_at_ms),
            source = excluded.source,
            updated_at_ms = excluded.updated_at_ms
        `).bind(kanal, klucz, kickId, nick, expiry, sub.source, teraz, kanal, eventId);
      });
      polecenia.push(db.prepare(`
        UPDATE webhook_events SET status = 'processed', processed_at_ms = ?
        WHERE broadcaster_id = ? AND event_id = ? AND status = 'processing'
      `).bind(teraz, kanal, eventId));
      const wyniki = await db.batch(polecenia);
      wyniki.forEach((wynik, i) => sprawdzWynik(wynik, `Zapis webhooka (operacja ${i + 1})`));
    },

    async oznaczWebhookNieudany({ broadcasterId, eventId }) {
      const wynik = await db.prepare(`
        UPDATE webhook_events SET status = 'failed'
        WHERE broadcaster_id = ? AND event_id = ? AND status = 'processing'
      `).bind(wymagajId(broadcasterId, 'ID kanału Kick'), eventId).run();
      sprawdzWynik(wynik, 'Oznaczenie błędnego webhooka');
    },
  };
}
