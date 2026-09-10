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
const USERS_FILE   = process.env.USERS_FILE || path.join(__dirname, 'data', 'users.json');
const AVATARS_FILE = path.join(__dirname, 'data', 'avatars.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');
const CONFIG_FILE  = path.join(__dirname, 'data', 'config.json');
const AUTH_PATH    = path.join(__dirname, 'auth_info');
const MAX_HISTORY  = 50;

const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
if (ADMIN_PASSWORD === 'changeme') console.warn('[admin] ATTENTION : mot de passe par defaut !');

const DEFAULT_TEMPLATE = "Salut *{username}*\n\n{icon} *{title}* que tu as demande est disponible !\nBon visionnage\n\n_- Message automatise_";

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
  } catch (err) { console.error('[storage] Erreur ecriture', file, err.message); }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let history = loadJson(HISTORY_FILE, []);
let config  = loadJson(CONFIG_FILE, {
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  overseerrUrl:      process.env.OVERSEERR_URL        || '',
  overseerrApiKey:   process.env.OVERSEERR_API_KEY    || '',
  messageTemplate:   DEFAULT_TEMPLATE,
});
if (!config.messageTemplate) config.messageTemplate = DEFAULT_TEMPLATE;
if (!fs.existsSync(USERS_FILE)) { saveJson(USERS_FILE, {}); console.log('[startup] users.json cree.'); }
if (!fs.existsSync(AVATARS_FILE)) saveJson(AVATARS_FILE, {});
fs.mkdirSync(AUTH_PATH, { recursive: true });

// History - only actionable entries (no unknown_user spam)
function pushHistory(entry) {
  if (entry.status === 'unknown_user') return;
  history.unshift({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  saveJson(HISTORY_FILE, history);
}

// Discord - 30 min cooldown on ready notifications to avoid spam
let lastDiscordReadyNotif = 0;
async function notifyDiscord(content, isReadyMsg = false) {
  const url = config.discordWebhookUrl;
  if (!url) return;
  if (isReadyMsg) {
    const now = Date.now();
    if (now - lastDiscordReadyNotif < 30 * 60 * 1000) return;
    lastDiscordReadyNotif = now;
  }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) { console.error('[discord] Erreur:', err.message); }
}

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// WhatsApp / Baileys
// ---------------------------------------------------------------------------
let sock          = null;
let whatsappReady = false;
let lastQrDataUrl = null;
const startedAt   = Date.now();
const waLogger    = pino({ level: 'silent' });

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
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) { try { lastQrDataUrl = await QRCode.toDataURL(qr); } catch {} }
      if (connection === 'close') {
        whatsappReady = false;
        lastQrDataUrl = null;
        const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (!loggedOut) setTimeout(connectWhatsApp, 5000);
        else notifyDiscord('Session WhatsApp expiree. Rescan QR requis depuis le dashboard.');
      }
      if (connection === 'open') {
        whatsappReady = true;
        lastQrDataUrl = null;
        console.log('[whatsapp] Connecte et pret.');
        notifyDiscord('Bot WhatsApp connecte et pret.', true);
      }
    });
  } catch (err) { setTimeout(connectWhatsApp, 5000); }
}

function toChatJid(phone) { return String(phone).replace(/\D/g, '') + '@s.whatsapp.net'; }

function buildMessage({ requestedBy_username, media_title, media_type }) {
  const icon = media_type === 'movie' ? '🎬' : '📺';
  const template = config.messageTemplate || DEFAULT_TEMPLATE;
  return template
    .replace(/{username}/g, requestedBy_username || 'Inconnu')
    .replace(/{title}/g, media_title || '')
    .replace(/{icon}/g, icon)
    .replace(/{type}/g, media_type === 'movie' ? 'Film' : 'Serie');
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

app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp_ready: whatsappReady }));

app.post('/webhook', async (req, res) => {
  const { notification_type, subject: media_title, image: media_poster, media_type, requestedBy_username, requestedBy_email } = req.body || {};
  if (notification_type && notification_type !== 'MEDIA_AVAILABLE') return res.status(200).json({ ignored: true });
  const base = { requestedBy_username, requestedBy_email, media_title, media_type, media_poster };
  if (!requestedBy_email || !media_title) { pushHistory({ ...base, status: 'error', error: 'Payload incomplet' }); return res.status(400).json({ error: 'Payload incomplet' }); }
  if (!whatsappReady || !sock) { pushHistory({ ...base, status: 'error', error: 'WhatsApp non pret' }); return res.status(503).json({ error: 'WhatsApp non pret' }); }
  const users = loadJson(USERS_FILE, null);
  if (!users) return res.status(500).json({ error: 'users.json inaccessible' });
  const emailKey = String(requestedBy_email).toLowerCase();
  const userEntry = Object.keys(users).find(k => k.toLowerCase() === emailKey);
  const phone = userEntry ? users[userEntry] : null;
  if (!phone) { pushHistory({ ...base, status: 'unknown_user' }); return res.status(404).json({ error: 'Aucun numero' }); }
  const jid = toChatJid(phone);
  const text = buildMessage({ requestedBy_username, media_title, media_type });
  try {
    if (media_poster && media_poster.startsWith('http')) {
      try {
        const { buffer, mimeType } = await fetchImageBuffer(media_poster);
        await sock.sendMessage(jid, { image: buffer, caption: text, mimetype: mimeType });
        pushHistory({ ...base, status: 'sent_with_poster' });
        return res.json({ sent: true, withPoster: true });
      } catch (imgErr) {
        await sock.sendMessage(jid, { text });
        pushHistory({ ...base, status: 'sent_text_only', error: 'Poster: ' + imgErr.message });
        return res.json({ sent: true, withPoster: false });
      }
    } else {
      await sock.sendMessage(jid, { text });
      pushHistory({ ...base, status: 'sent_text_only' });
      return res.json({ sent: true, withPoster: false });
    }
  } catch (err) {
    pushHistory({ ...base, status: 'error', error: err.message });
    notifyDiscord('Echec envoi WhatsApp pour ' + requestedBy_username + ' : ' + err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Auth
function checkAdminAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  const sepIdx = decoded.indexOf(':');
  return decoded.slice(0, sepIdx) === ADMIN_USER && decoded.slice(sepIdx + 1) === ADMIN_PASSWORD;
}

const adminRouter = express.Router();
adminRouter.use(express.static(path.join(__dirname, 'public')));
adminRouter.use('/api', (req, res, next) => checkAdminAuth(req) ? next() : res.status(401).json({ error: 'Auth requise' }));

adminRouter.get('/api/status', (req, res) => res.json({ whatsapp_ready: whatsappReady, qr: whatsappReady ? null : lastQrDataUrl, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) }));
adminRouter.get('/api/history', (req, res) => res.json(history));

adminRouter.get('/api/config', (req, res) => {
  const discUrl = config.discordWebhookUrl || '';
  const apiKey = config.overseerrApiKey || process.env.OVERSEERR_API_KEY || '';
  res.json({
    hasWebhook: !!discUrl, maskedUrl: discUrl ? '........' + discUrl.slice(-8) : '',
    overseerrUrl: config.overseerrUrl || process.env.OVERSEERR_URL || '',
    hasOverseerrApiKey: !!apiKey, maskedApiKey: apiKey ? '........' + apiKey.slice(-4) : '',
    messageTemplate: config.messageTemplate || DEFAULT_TEMPLATE,
  });
});

adminRouter.post('/api/config', (req, res) => {
  if (typeof req.body.discordWebhookUrl !== 'string') return res.status(400).json({ error: 'discordWebhookUrl requis' });
  config.discordWebhookUrl = req.body.discordWebhookUrl.trim();
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true });
});

adminRouter.post('/api/config/overseerr', (req, res) => {
  const { overseerrUrl, overseerrApiKey } = req.body || {};
  if (overseerrUrl !== undefined) config.overseerrUrl = String(overseerrUrl).trim();
  if (overseerrApiKey !== undefined) config.overseerrApiKey = String(overseerrApiKey).trim();
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true });
});

adminRouter.post('/api/config/template', (req, res) => {
  const { template } = req.body || {};
  if (typeof template !== 'string') return res.status(400).json({ error: 'template requis' });
  config.messageTemplate = template;
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true });
});

adminRouter.post('/api/config/template/reset', (req, res) => {
  config.messageTemplate = DEFAULT_TEMPLATE;
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true, template: DEFAULT_TEMPLATE });
});

adminRouter.post('/api/config/test-discord', async (req, res) => {
  if (!config.discordWebhookUrl) return res.status(400).json({ error: 'Aucun webhook configure' });
  await notifyDiscord('Test Discord depuis Whatsoverr.');
  res.json({ sent: true });
});

adminRouter.post('/api/restart', (req, res) => { res.json({ restarting: true }); setTimeout(() => process.exit(1), 500); });
adminRouter.post('/api/restart-wipe', async (req, res) => {
  res.json({ restarting: true });
  try { sock.end(); } catch {}
  try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); fs.mkdirSync(AUTH_PATH, { recursive: true }); } catch {}
  setTimeout(() => process.exit(1), 500);
});

// Users CRUD
adminRouter.get('/api/users', (req, res) => {
  const users = loadJson(USERS_FILE, {});
  const avatars = loadJson(AVATARS_FILE, {});
  res.json(Object.entries(users).map(([email, phone]) => ({ email, phone, avatar: avatars[email.toLowerCase()] || '' })));
});

adminRouter.post('/api/users', (req, res) => {
  const { email, phone, avatar } = req.body || {};
  if (!email || !phone) return res.status(400).json({ error: 'email/phone requis' });
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanPhone = String(phone).replace(/\D/g, '');
  const users = loadJson(USERS_FILE, {});
  users[cleanEmail] = cleanPhone;
  saveJson(USERS_FILE, users);
  if (avatar) { const av = loadJson(AVATARS_FILE, {}); av[cleanEmail] = avatar; saveJson(AVATARS_FILE, av); }
  res.json({ saved: true, email: cleanEmail, phone: cleanPhone });
});

adminRouter.put('/api/users/:email', (req, res) => {
  const oldEmail = decodeURIComponent(req.params.email).toLowerCase();
  const { email: newEmail, phone, avatar } = req.body || {};
  const users = loadJson(USERS_FILE, {});
  if (!users[oldEmail]) return res.status(404).json({ error: 'Introuvable' });
  const finalEmail = newEmail ? String(newEmail).trim().toLowerCase() : oldEmail;
  const finalPhone = phone ? String(phone).replace(/\D/g, '') : users[oldEmail];
  delete users[oldEmail];
  users[finalEmail] = finalPhone;
  saveJson(USERS_FILE, users);
  if (avatar !== undefined) {
    const av = loadJson(AVATARS_FILE, {});
    if (oldEmail !== finalEmail) delete av[oldEmail];
    if (avatar) av[finalEmail] = avatar;
    saveJson(AVATARS_FILE, av);
  }
  res.json({ saved: true, email: finalEmail, phone: finalPhone });
});

adminRouter.delete('/api/users/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const users = loadJson(USERS_FILE, {});
  delete users[email];
  saveJson(USERS_FILE, users);
  const av = loadJson(AVATARS_FILE, {});
  delete av[email];
  saveJson(AVATARS_FILE, av);
  res.json({ deleted: true });
});

// Overseerr Integration
function getOverseerrBase() {
  let url = config.overseerrUrl || process.env.OVERSEERR_URL || '';
  url = url.replace(/\/$/, '');
  if (url && !url.startsWith('http')) url = 'http://' + url;
  return url;
}

adminRouter.post('/api/overseerr/test', async (req, res) => {
  const baseUrl = getOverseerrBase();
  const apiKey = config.overseerrApiKey || process.env.OVERSEERR_API_KEY || '';
  if (!baseUrl || !apiKey) return res.status(400).json({ error: 'URL ou Cle API non configuree' });
  try {
    const response = await fetch(baseUrl + '/api/v1/user?take=1', { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    res.json({ ok: true, userCount: data.pageInfo?.results ?? '?' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/api/overseerr/users', async (req, res) => {
  const baseUrl = getOverseerrBase();
  const apiKey = config.overseerrApiKey || process.env.OVERSEERR_API_KEY || '';
  if (!baseUrl || !apiKey) return res.status(400).json({ error: 'URL ou Cle API non configuree' });
  try {
    const response = await fetch(baseUrl + '/api/v1/user?take=1000', { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const registered = loadJson(USERS_FILE, {});
    const avatars = loadJson(AVATARS_FILE, {});
    const result = (data.results || []).filter(u => u.email).map(u => {
      const email = u.email.toLowerCase();
      const key = Object.keys(registered).find(k => k.toLowerCase() === email);
      let avatar = u.avatar || '';
      if (avatar && avatar.startsWith('/')) avatar = baseUrl + avatar;
      if (avatar) avatars[email] = avatar;
      return { id: u.id, title: u.displayName || u.plexUsername || 'Inconnu', email: u.email, thumb: avatar, registered: !!key, phone: key ? registered[key] : '' };
    });
    saveJson(AVATARS_FILE, avatars);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Retry
adminRouter.post('/api/retry/:id', async (req, res) => {
  const entry = history.find(h => h.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entree introuvable' });
  if (!whatsappReady || !sock) return res.status(503).json({ error: 'WhatsApp non pret' });
  const users = loadJson(USERS_FILE, {});
  const emailKey = String(entry.requestedBy_email).toLowerCase();
  const userKey = Object.keys(users).find(k => k.toLowerCase() === emailKey);
  const phone = userKey ? users[userKey] : null;
  if (!phone) return res.status(404).json({ error: 'Aucun numero' });
  const jid = toChatJid(phone);
  const text = buildMessage(entry);
  const base = { requestedBy_username: entry.requestedBy_username, requestedBy_email: entry.requestedBy_email, media_title: entry.media_title, media_type: entry.media_type, media_poster: entry.media_poster };
  try {
    if (entry.media_poster && entry.media_poster.startsWith('http')) {
      try {
        const { buffer, mimeType } = await fetchImageBuffer(entry.media_poster);
        await sock.sendMessage(jid, { image: buffer, caption: text, mimetype: mimeType });
        pushHistory({ ...base, status: 'sent_with_poster', retriedFrom: entry.id });
        return res.json({ sent: true, withPoster: true });
      } catch (imgErr) {
        await sock.sendMessage(jid, { text });
        pushHistory({ ...base, status: 'sent_text_only', error: imgErr.message, retriedFrom: entry.id });
        return res.json({ sent: true, withPoster: false });
      }
    } else {
      await sock.sendMessage(jid, { text });
      pushHistory({ ...base, status: 'sent_text_only', retriedFrom: entry.id });
      return res.json({ sent: true, withPoster: false });
    }
  } catch (err) {
    pushHistory({ ...base, status: 'error', error: err.message, retriedFrom: entry.id });
    return res.status(500).json({ error: err.message });
  }
});

app.use('/dashboard', adminRouter);
app.use((req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.listen(PORT, () => console.log('[server] Port ' + PORT));
connectWhatsApp();
