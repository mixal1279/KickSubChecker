/**
 * Kick Sub Checker — Discord bot (Node.js 18+)
 * OAuth account linking is handled by the Cloudflare Worker.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits
} = require('discord.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,25}$/;

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Brak wymaganych zmiennych środowiskowych: ${missing.join(', ')}`);
}
function loadConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { guildId: value.guildId || null, roleId: value.roleId || null };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Nie można odczytać config.json:', error.message);
    return { guildId: null, roleId: null };
  }
}
function saveConfig(config) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const commands = [
  new SlashCommandBuilder().setName('sprawdz-suba').setDescription('Sprawdza aktywną subskrypcję na kanale Kick')
    .addStringOption(o => o.setName('nick').setDescription('Nick użytkownika na Kicku').setRequired(true)),
  new SlashCommandBuilder().setName('polacz-konto').setDescription('Bezpiecznie połącz swoje konto Kick przez OAuth'),
  new SlashCommandBuilder().setName('moj-status').setDescription('Sprawdza status subskrypcji połączonego konta Kick'),
  new SlashCommandBuilder().setName('config-rola').setDescription('(Admin) Ustawia rolę aktywnych subskrybentów')
    .addRoleOption(o => o.setName('rola').setDescription('Rola nadawana subskrybentom').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder().setName('sprawdz-teraz').setDescription('(Admin) Uruchamia synchronizację ról')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
].map(c => c.toJSON());

async function workerRequest(route, options = {}) {
  const base = process.env.WORKER_URL?.trim()?.replace(/\/+$/, '');
  if (!base) throw new Error('Nie ustawiono WORKER_URL.');
  if (!process.env.BOT_API_SECRET) throw new Error('Nie ustawiono BOT_API_SECRET.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${base}${route}`, {
      ...options,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.BOT_API_SECRET}`, ...(options.headers || {}) },
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (!response.ok) throw new Error(body.error || body.message || `Worker zwrócił HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Przekroczono limit czasu połączenia z Workerem.');
    throw error;
  } finally { clearTimeout(timeout); }
}
async function checkSub(username, userId = null) {
  const nick = String(username || '').trim().replace(/^@/, '');
  const id = userId == null ? '' : String(userId).trim();
  if (id && !/^[0-9]{1,32}$/.test(id)) throw new Error('Nieprawidłowy ID użytkownika Kick.');
  if (!id && !USERNAME_RE.test(nick)) throw new Error('Nieprawidłowy nick Kick. Użyj 1–25 liter, cyfr, podkreśleń lub myślników.');
  if (nick && !USERNAME_RE.test(nick)) throw new Error('Nieprawidłowy nick Kick.');
  const params = new URLSearchParams();
  if (id) params.set('user_id', id);
  if (nick) params.set('username', nick);
  return workerRequest(`/api/check?${params.toString()}`);
}
async function getLinkedAccounts() { return workerRequest('/api/links'); }

let syncRunning = false;
async function syncRoles(logFn = console.log) {
  if (syncRunning) return { checked: 0, added: 0, removed: 0, errors: 0, skipped: true };
  syncRunning = true;
  const stats = { checked: 0, added: 0, removed: 0, errors: 0 };
  try {
    const config = loadConfig();
    if (!config.guildId || !config.roleId) {
      logFn('Synchronizacja pominięta: skonfiguruj rolę komendą /config-rola.');
      return stats;
    }
    const guild = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) { logFn('Synchronizacja przerwana: bot nie widzi skonfigurowanego serwera.'); stats.errors++; return stats; }
    const role = await guild.roles.fetch(config.roleId).catch(() => null);
    if (!role) { logFn('Synchronizacja przerwana: skonfigurowana rola nie istnieje.'); stats.errors++; return stats; }
    const botMember = await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      logFn('Synchronizacja przerwana: bot nie ma uprawnienia Zarządzanie rolami (Manage Roles).');
      stats.errors++; return stats;
    }
    if (role.managed || role.position >= botMember.roles.highest.position) {
      logFn(`Synchronizacja przerwana: rola „${role.name}” jest zarządzana przez integrację albo znajduje się na równi/wyżej niż najwyższa rola bota „${botMember.roles.highest.name}”. Przenieś rolę bota wyżej w ustawieniach serwera.`);
      stats.errors++; return stats;
    }
    const linksResponse = await getLinkedAccounts();
    const links = Array.isArray(linksResponse.links) ? linksResponse.links : [];
    for (const link of links) {
      const discordId = String(link.discord_id || '');
      const username = String(link.username || '');
      const kickUserId = String(link.kick_user_id || '');
      if (!/^\d{17,20}$/.test(discordId) || (!USERNAME_RE.test(username) && !/^[0-9]{1,32}$/.test(kickUserId))) { stats.errors++; continue; }
      stats.checked++;
      try {
        const [data, member] = await Promise.all([
          checkSub(username, kickUserId || null), guild.members.fetch(discordId).catch(() => null)
        ]);
        if (!member) continue; // Użytkownik nie należy już do serwera.
        const hasRole = member.roles.cache.has(role.id);
        // Brak rekordu lub niepoprawne dane oznaczają status nieznany, a nie brak subskrypcji.
        // Dla starszej wersji Workera false nie wystarcza do odebrania roli.
        const status = data.status === 'active' || data.status === 'inactive'
          ? data.status
          : (data.subscribed === true ? 'active' : 'unknown');
        if (status === 'active' && !hasRole) {
          await member.roles.add(role, 'Aktywna subskrypcja Kick'); stats.added++;
        } else if (status === 'inactive' && hasRole) {
          await member.roles.remove(role, 'Potwierdzony brak aktywnej subskrypcji Kick'); stats.removed++;
        } else if (status === 'unknown') {
          logFn(`Pominięto zmianę roli dla ${username}: brak wiarygodnych danych o subskrypcji.`);
        }
      } catch (error) { stats.errors++; logFn(`Błąd synchronizacji ${username}: ${error.message}`); }
    }
    // Nie odbieramy ról użytkownikom bez połączenia konta.
    logFn(`Synchronizacja: sprawdzono ${stats.checked}, nadano ${stats.added}, zdjęto ${stats.removed}, błędów ${stats.errors}.`);
    return stats;
  } catch (error) {
    stats.errors++;
    logFn(`Synchronizacja przerwana: ${error.message}`);
    return stats;
  } finally { syncRunning = false; }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    const aktualnaKonfiguracja = loadConfig();
    if (aktualnaKonfiguracja.guildId && interaction.guildId !== aktualnaKonfiguracja.guildId) {
      await interaction.reply({ content: 'KickSubChecker jest skonfigurowany dla innego serwera Discord.', ephemeral: true });
      return;
    }
    if (interaction.commandName === 'sprawdz-suba') {
      await interaction.deferReply({ ephemeral: true });
      const nick = interaction.options.getString('nick', true);
      const data = await checkSub(nick);
      const status = data.status === 'active' || data.status === 'inactive'
        ? data.status
        : (data.subscribed === true ? 'active' : 'unknown');
      const expires = data.expires_at ? new Date(data.expires_at) : null;
      const validExpiry = expires && Number.isFinite(expires.getTime());
      const description = status === 'active'
        ? `Aktywna subskrypcja${validExpiry ? ` (wygasa <t:${Math.floor(expires.getTime() / 1000)}:R>)` : '.'}`
        : status === 'inactive'
          ? 'Potwierdzony brak aktywnej subskrypcji.'
          : 'Nieznany status — brak rekordu lub wiarygodnych danych z webhooków.';
      const embed = new EmbedBuilder().setTitle(`Status suba: ${data.username || nick}`)
        .setColor(status === 'active' ? 0x22c55e : status === 'inactive' ? 0xef4444 : 0x9ca3af)
        .setDescription(description);
      await interaction.editReply({ embeds: [embed] });
    } else if (interaction.commandName === 'polacz-konto') {
      await interaction.deferReply({ ephemeral: true });
      const result = await workerRequest('/api/link/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ discord_id: interaction.user.id }) });
      await interaction.editReply(`Aby potwierdzić własność konta Kick, otwórz ten link i zaloguj się na swoje konto:
${result.url}

Link wygaśnie po 10 minutach. Nick wpisany ręcznie nie wystarczy do uzyskania roli.`);
    } else if (interaction.commandName === 'moj-status') {
      await interaction.deferReply({ ephemeral: true });
      const linked = await workerRequest(`/api/link?discord_id=${encodeURIComponent(interaction.user.id)}`);
      if (!linked.username) { await interaction.editReply('Nie masz zweryfikowanego konta Kick. Użyj `/polacz-konto`.'); return; }
      const data = await checkSub(linked.username, linked.kick_user_id);
      const status = data.status === 'active' || data.status === 'inactive'
        ? data.status
        : (data.subscribed === true ? 'active' : 'unknown');
      await interaction.editReply(status === 'active'
        ? `Masz aktywnego suba jako **${data.username || linked.username}**${data.expires_at ? ` do <t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:R>` : ''}.`
        : status === 'inactive'
          ? `Konto **${linked.username}** jest połączone, ale potwierdzono brak aktywnej subskrypcji.`
          : `Konto **${linked.username}** jest połączone, ale bot nie ma jeszcze wiarygodnych danych o statusie subskrypcji. Rola nie zostanie zdjęta z tego powodu.`);
    } else if (interaction.commandName === 'config-rola') {
      if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({ content: 'Ta komenda wymaga uprawnienia Zarządzanie rolami.', ephemeral: true }); return;
      }
      const role = interaction.options.getRole('rola', true);
      const botMember = await interaction.guild.members.fetchMe();
      if (role.managed || role.position >= botMember.roles.highest.position) {
        await interaction.reply({ content: 'Nie mogę zarządzać tą rolą. Wybierz rolę niezarządzaną i niższą od najwyższej roli bota.', ephemeral: true }); return;
      }
      const obecna = loadConfig();
      if (obecna.guildId && obecna.guildId !== interaction.guildId) {
        await interaction.reply({ content: 'Bot jest już przypisany do innego serwera Discord.', ephemeral: true }); return;
      }
      saveConfig({ ...obecna, guildId: interaction.guildId, roleId: role.id });
      await interaction.reply({ content: `Rola **${role.name}** została ustawiona. Synchronizacja odbywa się co 10 minut.`, ephemeral: true });
    } else if (interaction.commandName === 'sprawdz-teraz') {
      if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({ content: 'Ta komenda wymaga uprawnienia Zarządzanie rolami.', ephemeral: true }); return;
      }
      await interaction.deferReply({ ephemeral: true });
      const stats = await syncRoles();
      await interaction.editReply(`Sprawdzono: ${stats.checked} | Nadano: ${stats.added} | Zdjęto: ${stats.removed} | Błędów: ${stats.errors}${stats.skipped ? ' | Synchronizacja już trwa.' : ''}`);
    }
  } catch (error) {
    console.error(`Błąd komendy ${interaction.commandName}:`, error);
    const message = `Nie udało się wykonać komendy: ${error.message}`.slice(0, 1900);
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

client.once('clientReady', () => {
  console.log(`Zalogowano jako ${client.user.tag}`);
  setTimeout(() => void syncRoles(), 15_000);
  setInterval(() => void syncRoles(), SYNC_INTERVAL_MS);
});

process.on('unhandledRejection', error => console.error('Nieobsłużony Promise rejection:', error));
process.on('uncaughtException', error => { console.error('Nieobsłużony wyjątek:', error); process.exit(1); });

(async () => {
  requireEnv(['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'WORKER_URL', 'BOT_API_SECRET']);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
  console.log('Zarejestrowano slash-komendy globalne.');
  await client.login(process.env.DISCORD_TOKEN);
})().catch(error => { console.error('Nie udało się uruchomić bota:', error.message); process.exit(1); });
