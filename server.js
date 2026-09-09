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

// --- Config ---
const PORT      = process.env.PORT || 3000;
const USERS_FILE  = process.env.USERS_FILE || path.join(__dirname, 'data', 'users.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');
const CONFIG_FILE  = path.join(__dirname, 'data', 'config.json');
const AUTH_PATH    = path.join(__dirname, 'auth_info');
const MAX_HISTORY  = 50;

const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
if (ADMIN_PASSWORD === 'changeme') console.warn('[admin] ATTENTION : mot de passe par défaut !');

// --- JSON ---
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {}
}

let history = loadJson(HISTORY_FILE, []);
let config  = loadJson(CONFIG_FILE, {
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  overseerrUrl:   process.env.OVERSEERR_URL   || '',
  overseerrApiKey: process.env.OVERSEERR_API_KEY || '',
});

if (!fs.existsSync(USERS_FILE)) saveJson(USERS_FILE, {});
fs.mkdirSync(AUTH_PATH, { recursive: true });

function pushHistory(entry) {
  history.unshift({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), timestamp: new Date().toISOString(), ...entry });
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  saveJson(HISTORY_FILE, history);
}

async function notifyDiscord(content) {
  const url = config.discordWebhookUrl;
  if (!url) return;
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }); } catch (err) {}
}

const app = express();
app.use(express.json());

// --- WhatsApp ---
let sock          = null;
let whatsappReady = false;
let lastQrDataUrl = null;
const startedAt   = Date.now();
const waLogger = pino({ level: 'silent' });

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
      if (qr) try { lastQrDataUrl = await QRCode.toDataURL(qr); } catch {}
      if (connection === 'close') {
        whatsappReady = false;
        lastQrDataUrl = null;
        const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (!loggedOut) setTimeout(connectWhatsApp, 5000);
        else await notifyDiscord('⚠️ Session WhatsApp expirée. Purge + rescan QR requis depuis le dashboard.');
      }
      if (connection === 'open') {
        whatsappReady = true;
        lastQrDataUrl = null;
        notifyDiscord('✅ Bot WhatsApp connecté et prêt.');
      }
    });
  } catch (err) { setTimeout(connectWhatsApp, 5000); }
}

function toChatJid(phone) { return String(phone).replace(/\D/g, '') + '@s.whatsapp.net'; }
function buildMessage({ requestedBy_username, media_title, media_type }) {
  const icon = media_type === 'movie' ? '🎬' : '📺';
  return `Salut *${requestedBy_username}* 👋\n\n${icon} *${media_title}* que tu as demandé est disponible sur Overseerr !\nBon visionnage 🍿\n\n_— Message automatisé_`;
}
async function fetchImageBuffer(url) {
  let safeUrl = url;
  if (url.includes('tmdb.org')) {
    safeUrl = url.replace(/w\d+_and_h\d+_bestv2/, 'w185').replace(/\/(original|w500|w342|w600|w300|w200|w92)\//g, '/w185/');
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
  if (!whatsappReady || !sock) { pushHistory({ ...base, status: 'error', error: 'WhatsApp non prêt' }); return res.status(503).json({ error: 'WhatsApp non prêt' }); }
  
  const users = loadJson(USERS_FILE, null);
  if (!users) return res.status(500).json({ error: 'Fichier users.json inaccessible' });
  
  const emailKey = String(requestedBy_email).toLowerCase();
  const userEntry = Object.keys(users).find(k => k.toLowerCase() === emailKey);
  const phone = userEntry ? users[userEntry] : null;
  
  if (!phone) { pushHistory({ ...base, status: 'unknown_user', error: 'Aucun numéro' }); return res.status(404).json({ error: 'Aucun numéro' }); }
  
  const jid = toChatJid(phone);
  const messageText = buildMessage({ requestedBy_username, media_title, media_type });
  
  try {
    if (media_poster && media_poster.startsWith('http')) {
      try {
        const { buffer, mimeType } = await fetchImageBuffer(media_poster);
        await sock.sendMessage(jid, { image: buffer, caption: messageText, mimetype: mimeType });
        pushHistory({ ...base, status: 'sent_with_poster' });
        return res.status(200).json({ sent: true, withPoster: true });
      } catch (imgErr) {
        await sock.sendMessage(jid, { text: messageText });
        pushHistory({ ...base, status: 'sent_text_only', error: 'Poster: ' + imgErr.message });
        return res.status(200).json({ sent: true, withPoster: false });
      }
    } else {
      await sock.sendMessage(jid, { text: messageText });
      pushHistory({ ...base, status: 'sent_text_only' });
      return res.status(200).json({ sent: true, withPoster: false });
    }
  } catch (err) {
    pushHistory({ ...base, status: 'error', error: err.message });
    await notifyDiscord(`❌ Echec envoi WhatsApp a **${requestedBy_username}** : ${err.message}`);
    return res.status(500).json({ error: 'Erreur WhatsApp' });
  }
});

// --- Admin Router ---
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
    hasOverseerrApiKey: !!apiKey, maskedApiKey: apiKey ? '........' + apiKey.slice(-4) : ''
  });
});

adminRouter.post('/api/config', (req, res) => {
  if (typeof req.body.discordWebhookUrl === 'string') {
    config.discordWebhookUrl = req.body.discordWebhookUrl.trim();
    saveJson(CONFIG_FILE, config);
    res.json({ saved: true });
  } else res.status(400).json({ error: 'Mauvais format' });
});

adminRouter.post('/api/config/overseerr', (req, res) => {
  const { overseerrUrl, overseerrApiKey } = req.body || {};
  if (overseerrUrl !== undefined) config.overseerrUrl = String(overseerrUrl).trim();
  if (overseerrApiKey !== undefined) config.overseerrApiKey = String(overseerrApiKey).trim();
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true });
});

adminRouter.post('/api/config/test-discord', async (req, res) => {
  if (!config.discordWebhookUrl) return res.status(400).json({ error: 'Aucun webhook' });
  await notifyDiscord('✅ Test Discord.');
  res.json({ sent: true });
});

adminRouter.post('/api/restart', (req, res) => { res.json({ restarting: true }); setTimeout(() => process.exit(1), 500); });
adminRouter.post('/api/restart-wipe', async (req, res) => {
  res.json({ restarting: true });
  try { sock.end(); } catch {}
  try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); fs.mkdirSync(AUTH_PATH); } catch {}
  setTimeout(() => process.exit(1), 500);
});

adminRouter.get('/api/users', (req, res) => {
  const users = loadJson(USERS_FILE, {});
  res.json(Object.entries(users).map(([email, phone]) => ({ email, phone })));
});

adminRouter.post('/api/users', (req, res) => {
  const { email, phone } = req.body || {};
  if (!email || !phone) return res.status(400).json({ error: 'email/phone requis' });
  const users = loadJson(USERS_FILE, {});
  users[String(email).trim().toLowerCase()] = String(phone).replace(/\D/g, '');
  saveJson(USERS_FILE, users);
  res.json({ saved: true });
});

adminRouter.put('/api/users/:email', (req, res) => {
  const oldEmail = decodeURIComponent(req.params.email).toLowerCase();
  const { email: newEmail, phone } = req.body || {};
  const users = loadJson(USERS_FILE, {});
  if (!users[oldEmail]) return res.status(404).json({ error: 'Introuvable' });
  delete users[oldEmail];
  users[newEmail ? String(newEmail).trim().toLowerCase() : oldEmail] = phone ? String(phone).replace(/\D/g, '') : users[oldEmail];
  saveJson(USERS_FILE, users);
  res.json({ saved: true });
});

adminRouter.delete('/api/users/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const users = loadJson(USERS_FILE, {});
  if (users[email]) { delete users[email]; saveJson(USERS_FILE, users); }
  res.json({ deleted: true });
});

// --- Overseerr Integration ---
adminRouter.post('/api/overseerr/test', async (req, res) => {
  const url = config.overseerrUrl || process.env.OVERSEERR_URL || '';
  const apiKey = config.overseerrApiKey || process.env.OVERSEERR_API_KEY || '';
  if (!url || !apiKey) return res.status(400).json({ error: 'URL ou Clé API non configurée' });
  try {
    const baseUrl = url.replace(/\/$/, '');
    const response = await fetch(baseUrl + '/api/v1/user?take=1', { headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    res.json({ ok: true, userCount: data.pageInfo.results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/api/overseerr/users', async (req, res) => {
  const url = config.overseerrUrl || process.env.OVERSEERR_URL || '';
  const apiKey = config.overseerrApiKey || process.env.OVERSEERR_API_KEY || '';
  if (!url || !apiKey) return res.status(400).json({ error: 'URL ou Clé API non configurée' });
  try {
    const baseUrl = url.replace(/\/$/, '');
    const response = await fetch(baseUrl + '/api/v1/user?take=1000', { headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const registered = loadJson(USERS_FILE, {});
    
    const result = (data.results || []).map(u => {
      const email = u.email || '';
      const key = email ? Object.keys(registered).find(k => k.toLowerCase() === email.toLowerCase()) : null;
      let avatar = u.avatar || '';
      if (avatar && avatar.startsWith('/')) avatar = baseUrl + avatar;
      return { id: u.id, title: u.displayName || u.plexUsername || 'Inconnu', email: email, thumb: avatar, registered: !!key, phone: key ? registered[key] : '' };
    }).filter(u => u.email);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Retry ---
adminRouter.post('/api/retry/:id', async (req, res) => {
  const entry = history.find(h => h.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entrée introuvable' });
  if (!whatsappReady || !sock) return res.status(503).json({ error: 'WhatsApp non prêt' });
  
  const users = loadJson(USERS_FILE, {});
  const emailKey = String(entry.requestedBy_email).toLowerCase();
  const userEntry = Object.keys(users).find(k => k.toLowerCase() === emailKey);
  const phone = userEntry ? users[userEntry] : null;
  if (!phone) return res.status(404).json({ error: 'Aucun numéro' });
  
  const jid = toChatJid(phone);
  const messageText = buildMessage(entry);
  const base = { ...entry }; delete base.id; delete base.timestamp; delete base.status; delete base.error; delete base.retriedFrom;
  
  try {
    if (entry.media_poster && entry.media_poster.startsWith('http')) {
      try {
        const { buffer, mimeType } = await fetchImageBuffer(entry.media_poster);
        await sock.sendMessage(jid, { image: buffer, caption: messageText, mimetype: mimeType });
        pushHistory({ ...base, status: 'sent_with_poster', retriedFrom: entry.id });
        return res.status(200).json({ sent: true, withPoster: true });
      } catch (imgErr) {
        await sock.sendMessage(jid, { text: messageText });
        pushHistory({ ...base, status: 'sent_text_only', error: imgErr.message, retriedFrom: entry.id });
        return res.status(200).json({ sent: true, withPoster: false });
      }
    } else {
      await sock.sendMessage(jid, { text: messageText });
      pushHistory({ ...base, status: 'sent_text_only', retriedFrom: entry.id });
      return res.status(200).json({ sent: true, withPoster: false });
    }
  } catch (err) {
    pushHistory({ ...base, status: 'error', error: err.message, retriedFrom: entry.id });
    return res.status(500).json({ error: err.message });
  }
});

app.use('/dashboard', adminRouter);
app.use((req, res) => res.status(404).json({ error: 'Route inconnue' }));

app.listen(PORT, () => console.log('[server] Port ' + PORT + ' | Webhook: /webhook | Admin: /dashboard'));
connectWhatsApp();
