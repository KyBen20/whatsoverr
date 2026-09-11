'use strict';
const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const QRCode     = require('qrcode');
const pino       = require('pino');
const { Boom }   = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT         = process.env.PORT || 3000;
const APP_VERSION  = '2.0.4'; // ← Modifier ici pour chaque release
const DATA_DIR     = path.join(__dirname, 'data');
const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const AVATARS_FILE = path.join(DATA_DIR, 'avatars.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json');
const QUEUE_FILE   = path.join(DATA_DIR, 'queue.json');
const AUTH_PATH    = path.join(__dirname, 'auth_info');
const MAX_HISTORY  = 50;

const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
if (ADMIN_PASSWORD === 'changeme') console.warn('[admin] ATTENTION : mot de passe par défaut !');

const DEFAULT_TEMPLATES = {
  fr: "Salut *{username}* 👋\n\n{icon} *{title}* que tu as demandé est disponible !\nBon visionnage 🍿\n\n_— Message automatisé_",
  en: "Hi *{username}* 👋\n\n{icon} *{title}* you requested is now available!\nEnjoy 🍿\n\n_— Automated message_"
};

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) { console.error('[storage] Erreur écriture', file, err.message); }
}

// ---------------------------------------------------------------------------
// State & Migrations
// ---------------------------------------------------------------------------
let history = loadJson(HISTORY_FILE, []);
let queue   = loadJson(QUEUE_FILE, []);

let config  = loadJson(CONFIG_FILE, {
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  overseerrUrl:      process.env.OVERSEERR_URL        || '',
  overseerrApiKey:   process.env.OVERSEERR_API_KEY    || '',
  templates:         DEFAULT_TEMPLATES,
  dnd:               { enabled: false, start: "23:00", end: "08:00" },
  dashboardLang:     'fr'
});

// Migration v1 -> v2 for config
let configMigrated = false;
if (config.messageTemplate) {
  if (!config.templates) config.templates = { ...DEFAULT_TEMPLATES };
  config.templates.fr = config.messageTemplate;
  delete config.messageTemplate;
  configMigrated = true;
}
if (!config.dnd) { config.dnd = { enabled: false, start: "23:00", end: "08:00" }; configMigrated = true; }
if (!config.dashboardLang) { config.dashboardLang = 'fr'; configMigrated = true; }
if (configMigrated) saveJson(CONFIG_FILE, config);

// In-memory caches (reduces disk reads per request → lower RAM pressure from GC)
let usersCache   = null;
let avatarsCache = null;

function getUsers() {
  if (!usersCache) usersCache = loadJson(USERS_FILE, {});
  return usersCache;
}
function getAvatars() {
  if (!avatarsCache) avatarsCache = loadJson(AVATARS_FILE, {});
  return avatarsCache;
}
function saveUsers(data)   { usersCache = data;   saveJson(USERS_FILE, data); }
function saveAvatars(data) { avatarsCache = data; saveJson(AVATARS_FILE, data); }

// Migration v1 -> v2 for users (string -> object)
const usersRaw = getUsers();
let usersMigrated = false;
for (const [k, v] of Object.entries(usersRaw)) {
  if (typeof v === 'string') { usersRaw[k] = { phone: v, lang: 'fr' }; usersMigrated = true; }
}
if (usersMigrated) saveUsers(usersRaw);

if (!fs.existsSync(AVATARS_FILE)) saveAvatars({});
fs.mkdirSync(AUTH_PATH, { recursive: true });

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
function pushHistory(entry) {
  if (entry.status === 'unknown_user') return; // Silently ignore
  history.unshift({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  saveJson(HISTORY_FILE, history);
}

// ---------------------------------------------------------------------------
// DND (Do Not Disturb) Logic
// ---------------------------------------------------------------------------
function isDND() {
  if (!config.dnd || !config.dnd.enabled) return false;
  const now = new Date();
  const currentMins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = (config.dnd.start || "23:00").split(':').map(Number);
  const [eh, em] = (config.dnd.end || "08:00").split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins   = eh * 60 + em;

  if (startMins <= endMins) return currentMins >= startMins && currentMins < endMins;
  return currentMins >= startMins || currentMins < endMins;
}

// Process Queue
setInterval(async () => {
  if (!whatsappReady || !sock || queue.length === 0) return;
  if (isDND()) return; // Still in DND
  
  const entry = queue.shift();
  saveJson(QUEUE_FILE, queue);
  console.log(`[queue] Traitement du message en attente pour ${entry.requestedBy_username}`);
  await processSend(entry, true);
}, 60000); // Check every minute

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
async function notifyDiscord(content) {
  const url = config.discordWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '512kb' })); // Limite anti-DoS

// ---------------------------------------------------------------------------
// WhatsApp / Baileys
// ---------------------------------------------------------------------------
let sock            = null;
let whatsappReady   = false;
let lastQrDataUrl   = null;
const startedAt     = Date.now();
const waLogger      = pino({ level: 'silent' });

// Tracks connection state to avoid Discord notification spam on Baileys auto-reconnect.
// Baileys reconnects silently every ~30-90 min (normal WebSocket keepalive). We only
// notify Discord on the very first connection and after a real outage (>2 min gap).
let firstConnectionDone = false;
let disconnectedAt      = null; // ms timestamp of last 'close' event
const REAL_OUTAGE_MS    = 2 * 60 * 1000; // 2 min threshold to consider a real outage

async function connectWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    let version = [2, 3000, 1015920];
    try { ({ version } = await fetchLatestBaileysVersion()); } catch {}

    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
      printQRInTerminal: false,
      logger: waLogger,
      browser: ['Whatsoverr', 'Desktop', '2.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,   // Prevents blocking push notifications on phone
      getMessage: async () => undefined, // Disable internal message store → saves RAM
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) try { lastQrDataUrl = await QRCode.toDataURL(qr); } catch {}

      if (connection === 'close') {
        whatsappReady  = false;
        lastQrDataUrl  = null;
        disconnectedAt = Date.now();
        const code      = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          notifyDiscord('⚠️ **Session WhatsApp expirée.** Rescan QR requis depuis le dashboard.');
        } else {
          setTimeout(connectWhatsApp, 5000);
        }
      }

      if (connection === 'open') {
        whatsappReady = true;
        lastQrDataUrl = null;
        const wasRealOutage = disconnectedAt && (Date.now() - disconnectedAt > REAL_OUTAGE_MS);
        // Notify only on first boot OR after a real outage (not on silent Baileys reconnects)
        if (!firstConnectionDone || wasRealOutage) {
          notifyDiscord('✅ **Bot WhatsApp connecté et prêt.**');
          firstConnectionDone = true;
        }
        disconnectedAt = null;
      }
    });
  } catch (err) { setTimeout(connectWhatsApp, 5000); }
}

// ---------------------------------------------------------------------------
// Message Sender Logic
// ---------------------------------------------------------------------------
function toChatJid(phone) { return String(phone).replace(/\D/g, '') + '@s.whatsapp.net'; }

function buildMessage(entry, lang = 'fr') {
  const icon = entry.media_type === 'movie' ? '🎬' : '📺';
  const tmpl = (config.templates && config.templates[lang]) ? config.templates[lang] : DEFAULT_TEMPLATES['fr'];
  return tmpl
    .replace(/{username}/g, entry.requestedBy_username || 'Unknown')
    .replace(/{title}/g,    entry.media_title || '')
    .replace(/{icon}/g,     icon)
    .replace(/{type}/g,     entry.media_type === 'movie' ? 'Film' : 'Série');
}

async function fetchImageBuffer(url) {
  let safeUrl = url;
  if (url.includes('tmdb.org')) {
    safeUrl = url.replace(/w\d+_and_h\d+_bestv2/, 'w500').replace(/\/(original|w342|w600|w300|w200|w92)\//g, '/w500/');
  }
  const response = await fetch(safeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get('content-type') || 'image/jpeg' };
}

async function processSend(entry, isFromQueue = false) {
  const base = {
    requestedBy_username: entry.requestedBy_username,
    requestedBy_email:    entry.requestedBy_email,
    media_title:          entry.media_title,
    media_type:           entry.media_type,
    media_poster:         entry.media_poster,
  };
  
  if (entry.retriedFrom) base.retriedFrom = entry.retriedFrom;

  const currentUsers = getUsers();
  const emailKey  = String(entry.requestedBy_email).toLowerCase();
  const userEntry = Object.keys(currentUsers).find(k => k.toLowerCase() === emailKey);
  const userData  = userEntry ? currentUsers[userEntry] : null;

  if (!userData || !userData.phone) {
    if (!isFromQueue) pushHistory({ ...base, status: 'unknown_user' });
    return { error: 'Aucun numéro', status: 404 };
  }

  // DND Check (unless explicitly retrying manually)
  if (!entry.retriedFrom && !isFromQueue && isDND()) {
    queue.push(entry);
    saveJson(QUEUE_FILE, queue);
    pushHistory({ ...base, status: 'queued_dnd' });
    return { sent: false, queued: true };
  }

  const jid  = toChatJid(userData.phone);
  const text = buildMessage(base, userData.lang || 'fr');

  try {
    if (base.media_poster && base.media_poster.startsWith('http')) {
      try {
        const { buffer, mimeType } = await fetchImageBuffer(base.media_poster);
        await sock.sendMessage(jid, { image: buffer, caption: text, mimetype: mimeType });
        pushHistory({ ...base, status: 'sent_with_poster' });
        return { sent: true, withPoster: true };
      } catch (imgErr) {
        await sock.sendMessage(jid, { text });
        pushHistory({ ...base, status: 'sent_text_only', error: 'Poster: ' + imgErr.message });
        return { sent: true, withPoster: false };
      }
    } else {
      await sock.sendMessage(jid, { text });
      pushHistory({ ...base, status: 'sent_text_only' });
      return { sent: true, withPoster: false };
    }
  } catch (err) {
    pushHistory({ ...base, status: 'error', error: err.message });
    notifyDiscord(`❌ Échec WhatsApp pour **${base.requestedBy_username}** : ${err.message}`);
    return { error: err.message, status: 500 };
  }
}

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp_ready: whatsappReady }));

app.post('/webhook', async (req, res) => {
  const { notification_type, message, subject, image, media_type, requestedBy_username, requestedBy_email } = req.body || {};

  // Overseerr Test Webhook
  if (notification_type === 'TEST_NOTIFICATION') {
    if (!whatsappReady || !sock) return res.status(503).json({ error: 'WhatsApp non prêt' });
    // Find first registered user to send test to
    const allUsers = getUsers();
    const adminPhone = Object.values(allUsers)[0]?.phone;
    if (!adminPhone) return res.status(404).json({ error: 'Aucun utilisateur enregistré pour le test' });
    
    try {
      await sock.sendMessage(toChatJid(adminPhone), { text: '🔔 *Test Overseerr*\nLa connexion Webhook fonctionne parfaitement !' });
      return res.json({ sent: true, message: 'Test envoye au premier utilisateur' });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (notification_type && notification_type !== 'MEDIA_AVAILABLE') {
    return res.status(200).json({ ignored: true });
  }

  if (!requestedBy_email || !subject) {
    pushHistory({ requestedBy_username, requestedBy_email, media_title: subject, status: 'error', error: 'Payload incomplet' });
    return res.status(400).json({ error: 'Payload incomplet' });
  }
  if (!whatsappReady || !sock) {
    pushHistory({ requestedBy_username, requestedBy_email, media_title: subject, status: 'error', error: 'WhatsApp non prêt' });
    return res.status(503).json({ error: 'WhatsApp non prêt' });
  }

  const result = await processSend({
    requestedBy_username,
    requestedBy_email,
    media_title: subject,
    media_type,
    media_poster: image
  });

  if (result.status) return res.status(result.status).json(result);
  return res.json(result);
});

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
function checkAdminAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  const sepIdx  = decoded.indexOf(':');
  return decoded.slice(0, sepIdx) === ADMIN_USER && decoded.slice(sepIdx + 1) === ADMIN_PASSWORD;
}

const adminRouter = express.Router();
adminRouter.use(express.static(path.join(__dirname, 'public')));
adminRouter.use('/api', (req, res, next) => checkAdminAuth(req) ? next() : res.status(401).json({ error: 'Auth requise' }));

// ---------------------------------------------------------------------------
// Admin Routes - Status & Config
// ---------------------------------------------------------------------------
adminRouter.get('/api/status', (req, res) => {
  res.json({
    whatsapp_ready: whatsappReady,
    qr: whatsappReady ? null : lastQrDataUrl,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    version: APP_VERSION,
  });
});

adminRouter.get('/api/history', (req, res) => res.json(history));

adminRouter.delete('/api/history/:id', (req, res) => {
  const before = history.length;
  history = history.filter(h => h.id !== req.params.id);
  if (history.length === before) return res.status(404).json({ error: 'Introuvable' });
  saveJson(HISTORY_FILE, history);
  res.json({ deleted: true });
});

adminRouter.delete('/api/history', (req, res) => {
  history = [];
  saveJson(HISTORY_FILE, history);
  res.json({ cleared: true });
});

adminRouter.get('/api/config', (req, res) => {
  const discUrl = config.discordWebhookUrl || '';
  const apiKey  = config.overseerrApiKey   || process.env.OVERSEERR_API_KEY || '';
  res.json({
    hasWebhook:        !!discUrl,
    maskedUrl:         discUrl  ? '••••••••' + discUrl.slice(-8)  : '',
    overseerrUrl:      config.overseerrUrl || process.env.OVERSEERR_URL || '',
    hasOverseerrApiKey: !!apiKey,
    maskedApiKey:      apiKey   ? '••••••••' + apiKey.slice(-4)  : '',
    templates:         config.templates || DEFAULT_TEMPLATES,
    dnd:               config.dnd || { enabled: false, start: "23:00", end: "08:00" },
    dashboardLang:     config.dashboardLang || 'fr'
  });
});

adminRouter.post('/api/config', (req, res) => {
  const body = req.body || {};
  if (body.discordWebhookUrl !== undefined) config.discordWebhookUrl = String(body.discordWebhookUrl).trim();
  if (body.dashboardLang !== undefined) config.dashboardLang = String(body.dashboardLang).trim();
  if (body.dnd !== undefined) config.dnd = body.dnd;
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true });
});

adminRouter.post('/api/config/overseerr', (req, res) => {
  const { overseerrUrl, overseerrApiKey } = req.body || {};
  if (overseerrUrl    !== undefined) config.overseerrUrl    = String(overseerrUrl).trim();
  if (overseerrApiKey !== undefined) config.overseerrApiKey = String(overseerrApiKey).trim();
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true });
});

adminRouter.post('/api/config/templates', (req, res) => {
  if (req.body.templates) {
    config.templates = req.body.templates;
    saveJson(CONFIG_FILE, config);
    res.json({ saved: true });
  } else res.status(400).json({ error: 'Mauvais format' });
});

adminRouter.post('/api/config/templates/reset', (req, res) => {
  config.templates = { ...DEFAULT_TEMPLATES };
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true, templates: config.templates });
});

adminRouter.post('/api/config/test-discord', async (req, res) => {
  if (!config.discordWebhookUrl) return res.status(400).json({ error: 'Aucun webhook' });
  await notifyDiscord('✅ Test Discord Whatsoverr v2.');
  res.json({ sent: true });
});

// Export / Import API
adminRouter.get('/api/config/export', (req, res) => {
  const payload = {
    version: 2,
    config: config,
    users: getUsers(),
    avatars: getAvatars()
  };
  res.json(payload);
});

adminRouter.post('/api/config/import', (req, res) => {
  const payload = req.body || {};
  if (payload.config) { config = payload.config; saveJson(CONFIG_FILE, config); }
  if (payload.users)  saveJson(USERS_FILE, payload.users);
  if (payload.avatars) saveJson(AVATARS_FILE, payload.avatars);
  res.json({ imported: true });
});

// Direct WhatsApp Test
adminRouter.post('/api/whatsapp/test', async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ error: 'phone/message requis' });
  if (!whatsappReady || !sock) return res.status(503).json({ error: 'WhatsApp non prêt' });
  try {
    await sock.sendMessage(toChatJid(phone), { text: message });
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/api/restart', (req, res) => {
  res.json({ restarting: true }); setTimeout(() => process.exit(1), 500);
});
adminRouter.post('/api/restart-wipe', async (req, res) => {
  res.json({ restarting: true });
  try { sock.end(); } catch {}
  try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); fs.mkdirSync(AUTH_PATH, { recursive: true }); } catch {}
  setTimeout(() => process.exit(1), 500);
});

// ---------------------------------------------------------------------------
// Admin Routes - Users CRUD
// ---------------------------------------------------------------------------
adminRouter.get('/api/users', (req, res) => {
  const users   = getUsers();
  const avatars = getAvatars();
  res.json(
    Object.entries(users).map(([email, data]) => ({
      email,
      phone:  typeof data === 'string' ? data : data.phone,
      lang:   typeof data === 'string' ? 'fr' : (data.lang || 'fr'),
      avatar: avatars[email.toLowerCase()] || '',
    }))
  );
});

adminRouter.post('/api/users', (req, res) => {
  const { email, phone, avatar, lang } = req.body || {};
  if (!email || !phone) return res.status(400).json({ error: 'email/phone requis' });
  const cleanEmail = String(email).trim().toLowerCase();
  const users = getUsers();
  users[cleanEmail] = { phone: String(phone).replace(/\D/g, ''), lang: lang || 'fr' };
  saveUsers(users);
  if (avatar) {
    const avatars = getAvatars();
    avatars[cleanEmail] = avatar;
    saveAvatars(avatars);
  }
  res.json({ saved: true });
});

adminRouter.put('/api/users/:email', (req, res) => {
  const oldEmail = decodeURIComponent(req.params.email).toLowerCase();
  const { email: newEmail, phone, avatar, lang } = req.body || {};
  const users    = getUsers();
  const avatars  = getAvatars();
  if (!users[oldEmail]) return res.status(404).json({ error: 'Introuvable' });
  
  const finalEmail = newEmail ? String(newEmail).trim().toLowerCase() : oldEmail;
  const oldData    = typeof users[oldEmail] === 'string' ? { phone: users[oldEmail], lang: 'fr' } : users[oldEmail];
  
  delete users[oldEmail];
  users[finalEmail] = {
    phone: phone ? String(phone).replace(/\D/g, '') : oldData.phone,
    lang:  lang || oldData.lang
  };
  saveUsers(users);

  if (avatar !== undefined) {
    if (oldEmail !== finalEmail) delete avatars[oldEmail];
    if (avatar) avatars[finalEmail] = avatar;
    saveAvatars(avatars);
  }
  res.json({ saved: true });
});

adminRouter.delete('/api/users/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const users = getUsers();
  delete users[email];
  saveUsers(users);
  const avatars = getAvatars();
  delete avatars[email];
  saveAvatars(avatars);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Overseerr Integration
// ---------------------------------------------------------------------------
function getOverseerrBase() {
  let url = config.overseerrUrl || process.env.OVERSEERR_URL || '';
  url = url.replace(/\/$/, '');
  if (url && !url.startsWith('http')) url = 'http://' + url;
  return url;
}

adminRouter.post('/api/overseerr/test', async (req, res) => {
  const baseUrl = getOverseerrBase();
  const apiKey  = config.overseerrApiKey || process.env.OVERSEERR_API_KEY || '';
  if (!baseUrl || !apiKey) return res.status(400).json({ error: 'URL/Clé manquante' });
  try {
    const response = await fetch(baseUrl + '/api/v1/user?take=1', { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    res.json({ ok: true, userCount: data.pageInfo?.results ?? '?' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/api/overseerr/users', async (req, res) => {
  const baseUrl = getOverseerrBase();
  const apiKey  = config.overseerrApiKey || process.env.OVERSEERR_API_KEY || '';
  if (!baseUrl || !apiKey) return res.status(400).json({ error: 'URL/Clé manquante' });
  try {
    const response = await fetch(baseUrl + '/api/v1/user?take=1000', { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data       = await response.json();
    const registered = getUsers();
    const avatars    = getAvatars();

    const result = (data.results || []).filter(u => u.email).map(u => {
      const email = u.email.toLowerCase();
      const key   = Object.keys(registered).find(k => k.toLowerCase() === email);
      let avatar  = u.avatar || '';
      if (avatar && avatar.startsWith('/')) avatar = baseUrl + avatar;
      if (avatar) avatars[email] = avatar;
      
      let phone = '';
      let lang = 'fr';
      if (key) {
        phone = typeof registered[key] === 'string' ? registered[key] : registered[key].phone;
        lang  = typeof registered[key] === 'string' ? 'fr' : registered[key].lang;
      }

      return {
        id:         u.id,
        title:      u.displayName || u.plexUsername || 'Inconnu',
        email:      u.email,
        thumb:      avatar,
        registered: !!key,
        phone,
        lang
      };
    });

    saveAvatars(avatars);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Retry
adminRouter.post('/api/retry/:id', async (req, res) => {
  const entry = history.find(h => h.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entrée introuvable' });
  if (!whatsappReady || !sock) return res.status(503).json({ error: 'WhatsApp non prêt' });
  
  const result = await processSend({ ...entry, retriedFrom: entry.id });
  if (result.status) return res.status(result.status).json(result);
  res.json(result);
});

app.use('/dashboard', adminRouter);
app.use((req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.listen(PORT, () => console.log(`[server] Port ${PORT} | POST /webhook | Admin: /dashboard`));
connectWhatsApp();
