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
const PORT      = process.env.PORT || 3000;
const USERS_FILE  = process.env.USERS_FILE || path.join(__dirname, 'data', 'users.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');
const CONFIG_FILE  = path.join(__dirname, 'data', 'config.json');
const AUTH_PATH    = path.join(__dirname, 'auth_info');
const MAX_HISTORY  = 50;

const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
if (ADMIN_PASSWORD === 'changeme') {
  console.warn('[admin] ATTENTION : mot de passe par defaut ! Changez ADMIN_PASSWORD dans docker-compose.yml');
}

// ---------------------------------------------------------------------------
// Stockage JSON
// ---------------------------------------------------------------------------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[storage] Echec ecriture ' + file + ' :', err.message);
  }
}

let history = loadJson(HISTORY_FILE, []);
let config  = loadJson(CONFIG_FILE, {
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  plexUrl:   process.env.PLEX_URL   || '',
  plexToken: process.env.PLEX_TOKEN || '',
});

// Auto-creation users.json au premier lancement
if (!fs.existsSync(USERS_FILE)) {
  saveJson(USERS_FILE, {});
  console.log('[startup] users.json cree. Ajoutez des utilisateurs depuis le dashboard.');
}
fs.mkdirSync(AUTH_PATH, { recursive: true });

function pushHistory(entry) {
  history.unshift({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  saveJson(HISTORY_FILE, history);
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
async function notifyDiscord(content) {
  const url = config.discordWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error('[discord] Echec :', err.message);
  }
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// WhatsApp (Baileys) — aucun Chrome, WebSocket pur
// ---------------------------------------------------------------------------
let sock          = null;
let whatsappReady = false;
let lastQrDataUrl = null;
const startedAt   = Date.now();

// Logger silencieux pour Baileys (evite les logs verbeux)
const waLogger = pino({ level: 'silent' });

async function connectWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

    let version = [2, 3000, 1015920]; // version de secours
    try { ({ version } = await fetchLatestBaileysVersion()); } catch {}

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      printQRInTerminal: false,
      logger: waLogger,
      browser: ['Whatsoverr', 'Desktop', '2.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('[whatsapp] QR disponible — scannez depuis /dashboard');
        try { lastQrDataUrl = await QRCode.toDataURL(qr); } catch {}
      }

      if (connection === 'close') {
        whatsappReady = false;
        lastQrDataUrl = null;
        const code      = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.warn('[whatsapp] Connexion fermee (code:' + code + ').' + (loggedOut ? ' Session expiree.' : ' Reconnexion dans 5s...'));
        if (!loggedOut) {
          setTimeout(connectWhatsApp, 5000);
        } else {
          await notifyDiscord('⚠️ Session WhatsApp expiree. Purge + rescan QR requis depuis le dashboard.');
        }
      }

      if (connection === 'open') {
        whatsappReady = true;
        lastQrDataUrl = null;
        console.log('[whatsapp] Client pret. Webhook operationnel.');
        notifyDiscord('✅ Bot WhatsApp connecte et pret.');
      }
    });

  } catch (err) {
    console.error('[whatsapp] Erreur init :', err.message);
    setTimeout(connectWhatsApp, 5000);
  }
}

// ---------------------------------------------------------------------------
// Helpers metier
// ---------------------------------------------------------------------------
function toChatJid(phone) {
  const cleaned = String(phone).replace(/\D/g, '');
  return cleaned + '@s.whatsapp.net';
}

function buildMessage({ requestedBy_username, media_title, media_type }) {
  const icon = media_type === 'movie' ? '🎬' : '📺';
  return 'Salut *' + requestedBy_username + '* 👋\n\n' + icon + ' *' + media_title + '* que tu as demandé est disponible sur Plex !\nBon visionnage 🍿\n\n_— Message automatisé_';
}

async function fetchImageBuffer(url) {
  let safeUrl = url;
  if (url.includes('tmdb.org')) {
    safeUrl = url
      .replace(/w\d+_and_h\d+_bestv2/, 'w185')
      .replace(/\/(original|w500|w342|w600|w300|w200|w92)\//g, '/w185/');
  }
  const response = await fetch(safeUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Whatsoverr/2.0)',
      Accept: 'image/*',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  if (!mimeType.startsWith('image/')) throw new Error('Pas une image : ' + mimeType);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mimeType };
}

// ---------------------------------------------------------------------------
// Routes publiques
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp_ready: whatsappReady });
});

app.post('/webhook', async (req, res) => {
  const payload = req.body || {};
  const {
    notification_type,
    subject:              media_title,
    image:                media_poster,
    media_type,
    requestedBy_username,
    requestedBy_email,
  } = payload;

  console.log('[webhook] Recu : type=' + notification_type + ' media="' + media_title + '" (' + media_type + ') user=' + requestedBy_username + ' email=' + requestedBy_email);

  if (notification_type && notification_type !== 'MEDIA_AVAILABLE') {
    return res.status(200).json({ ignored: true, reason: 'notification_type non pertinent' });
  }

  const base = { requestedBy_username, requestedBy_email, media_title, media_type, media_poster };

  if (!requestedBy_email || !media_title) {
    pushHistory({ ...base, status: 'error', error: 'Payload incomplet (requestedBy_email / subject requis)' });
    return res.status(400).json({ error: 'Payload incomplet' });
  }
  if (!whatsappReady || !sock) {
    pushHistory({ ...base, status: 'error', error: 'Client WhatsApp non pret' });
    return res.status(503).json({ error: 'Client WhatsApp non pret' });
  }

  const users    = loadJson(USERS_FILE, null);
  if (!users) {
    pushHistory({ ...base, status: 'error', error: 'Impossible de lire users.json' });
    return res.status(500).json({ error: 'Impossible de lire users.json' });
  }

  const emailKey  = String(requestedBy_email).toLowerCase();
  const userEntry = Object.keys(users).find(k => k.toLowerCase() === emailKey);
  const phone     = userEntry ? users[userEntry] : null;

  if (!phone) {
    pushHistory({ ...base, status: 'unknown_user', error: 'Aucun numero mappe pour ' + requestedBy_email });
    return res.status(404).json({ error: 'Aucun numero mappe pour "' + requestedBy_email + '"' });
  }

  const jid         = toChatJid(phone);
  const messageText = buildMessage({ requestedBy_username, media_title, media_type });

  try {
    if (media_poster && media_poster.startsWith('http')) {
      try {
        const { buffer, mimeType } = await fetchImageBuffer(media_poster);
        await sock.sendMessage(jid, { image: buffer, caption: messageText, mimetype: mimeType });
        pushHistory({ ...base, status: 'sent_with_poster' });
        return res.status(200).json({ sent: true, withPoster: true });
      } catch (imgErr) {
        console.warn('[webhook] Echec image, texte seul :', imgErr.message);
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
    console.error('[webhook] Erreur WhatsApp :', err.message);
    pushHistory({ ...base, status: 'error', error: err.message });
    await notifyDiscord('❌ Echec envoi WhatsApp a **' + (requestedBy_username || requestedBy_email) + '** pour *' + media_title + '* : ' + err.message);
    return res.status(500).json({ error: 'Erreur WhatsApp', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Auth admin
// ---------------------------------------------------------------------------
function checkAdminAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  const sepIdx  = decoded.indexOf(':');
  return decoded.slice(0, sepIdx) === ADMIN_USER && decoded.slice(sepIdx + 1) === ADMIN_PASSWORD;
}

// ---------------------------------------------------------------------------
// Panneau admin
// ---------------------------------------------------------------------------
const adminRouter = express.Router();
adminRouter.use(express.static(path.join(__dirname, 'public')));
adminRouter.use('/api', (req, res, next) => {
  if (checkAdminAuth(req)) return next();
  return res.status(401).json({ error: 'Authentification requise' });
});

adminRouter.get('/api/status', (req, res) => {
  res.json({
    whatsapp_ready: whatsappReady,
    qr: whatsappReady ? null : lastQrDataUrl,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

adminRouter.get('/api/history', (req, res) => res.json(history));

adminRouter.get('/api/config', (req, res) => {
  const discUrl  = config.discordWebhookUrl || '';
  const plexTok  = config.plexToken || process.env.PLEX_TOKEN || '';
  res.json({
    hasWebhook:   !!discUrl,
    maskedUrl:    discUrl ? '........' + discUrl.slice(-8) : '',
    plexUrl:      config.plexUrl || process.env.PLEX_URL || '',
    hasPlexToken: !!plexTok,
    maskedToken:  plexTok ? '........' + plexTok.slice(-4) : '',
  });
});

adminRouter.post('/api/config', (req, res) => {
  const { discordWebhookUrl } = req.body || {};
  if (typeof discordWebhookUrl !== 'string') {
    return res.status(400).json({ error: 'discordWebhookUrl requis' });
  }
  config.discordWebhookUrl = discordWebhookUrl.trim();
  saveJson(CONFIG_FILE, config);
  res.json({ saved: true });
});

adminRouter.post('/api/config/plex', (req, res) => {
  const { plexUrl, plexToken } = req.body || {};
  if (plexUrl   !== undefined) config.plexUrl   = String(plexUrl).trim();
  if (plexToken !== undefined) config.plexToken = String(plexToken).trim();
  saveJson(CONFIG_FILE, config);
  console.log('[plex] Config mise a jour');
  res.json({ saved: true });
});

adminRouter.post('/api/config/test-discord', async (req, res) => {
  if (!config.discordWebhookUrl) return res.status(400).json({ error: 'Aucun webhook Discord configure' });
  await notifyDiscord('✅ Test depuis le dashboard Whatsoverr.');
  res.json({ sent: true });
});

adminRouter.post('/api/restart', (req, res) => {
  res.json({ restarting: true, wipe: false });
  setTimeout(() => process.exit(1), 500);
});

adminRouter.post('/api/restart-wipe', async (req, res) => {
  res.json({ restarting: true, wipe: true });
  try { sock.end(); } catch {}
  try {
    fs.rmSync(AUTH_PATH, { recursive: true, force: true });
    fs.mkdirSync(AUTH_PATH, { recursive: true });
  } catch {}
  setTimeout(() => process.exit(1), 500);
});

// ---------------------------------------------------------------------------
// API — Gestion des utilisateurs
// ---------------------------------------------------------------------------
adminRouter.get('/api/users', (req, res) => {
  const users = loadJson(USERS_FILE, {});
  res.json(Object.entries(users).map(([email, phone]) => ({ email, phone })));
});

adminRouter.post('/api/users', (req, res) => {
  const { email, phone } = req.body || {};
  if (!email || !phone) return res.status(400).json({ error: 'email et phone requis' });
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanEmail || !cleanPhone) return res.status(400).json({ error: 'email ou phone invalide' });
  const users = loadJson(USERS_FILE, {});
  users[cleanEmail] = cleanPhone;
  saveJson(USERS_FILE, users);
  console.log('[users] Ajout : ' + cleanEmail + ' -> ' + cleanPhone);
  res.json({ saved: true, email: cleanEmail, phone: cleanPhone });
});

adminRouter.put('/api/users/:email', (req, res) => {
  const oldEmail = decodeURIComponent(req.params.email).toLowerCase();
  const { email: newEmail, phone } = req.body || {};
  const users = loadJson(USERS_FILE, {});
  if (!users[oldEmail]) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const finalEmail = newEmail ? String(newEmail).trim().toLowerCase() : oldEmail;
  const finalPhone = phone ? String(phone).replace(/\D/g, '') : users[oldEmail];
  delete users[oldEmail];
  users[finalEmail] = finalPhone;
  saveJson(USERS_FILE, users);
  res.json({ saved: true, email: finalEmail, phone: finalPhone });
});

adminRouter.delete('/api/users/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const users = loadJson(USERS_FILE, {});
  if (!users[email]) return res.status(404).json({ error: 'Utilisateur introuvable' });
  delete users[email];
  saveJson(USERS_FILE, users);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// API — Plex
// ---------------------------------------------------------------------------
function parsePlexXmlUsers(xml) {
  const users = [];
  const userRe = /<User\b([^>]*?)(?:\/>|>)/gs;
  const attrRe = /(\w+)="([^"]*)"/g;
  let um;
  while ((um = userRe.exec(xml)) !== null) {
    const attrs = {};
    attrRe.lastIndex = 0;
    let am;
    while ((am = attrRe.exec(um[1])) !== null) {
      attrs[am[1]] = am[2];
    }
    if (attrs.email) {
      users.push({
        id:    attrs.id    || '',
        title: attrs.title || attrs.username || '',
        email: attrs.email || '',
        thumb: attrs.thumb || '',
      });
    }
  }
  return users;
}

adminRouter.post('/api/plex/test', async (req, res) => {
  const plexToken = config.plexToken || process.env.PLEX_TOKEN || '';
  if (!plexToken) return res.status(400).json({ error: 'Token Plex non configure' });
  try {
    const response = await fetch('https://plex.tv/api/users?X-Plex-Token=' + plexToken, {
      headers: { Accept: 'application/xml', 'X-Plex-Client-Identifier': 'whatsoverr' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Plex API HTTP ' + response.status);
    const xml   = await response.text();
    const users = parsePlexXmlUsers(xml);
    res.json({ ok: true, userCount: users.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/api/plex/users', async (req, res) => {
  const plexToken = config.plexToken || process.env.PLEX_TOKEN || '';
  if (!plexToken) return res.status(400).json({ error: 'Token Plex non configure' });
  try {
    const response = await fetch('https://plex.tv/api/users?X-Plex-Token=' + plexToken, {
      headers: { Accept: 'application/xml', 'X-Plex-Client-Identifier': 'whatsoverr' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Plex API HTTP ' + response.status);
    const xml       = await response.text();
    const plexUsers = parsePlexXmlUsers(xml);
    const registered = loadJson(USERS_FILE, {});
    const result = plexUsers.map(u => {
      const key   = Object.keys(registered).find(k => k.toLowerCase() === u.email.toLowerCase());
      return { ...u, registered: !!key, phone: key ? registered[key] : '' };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API — Retry
// ---------------------------------------------------------------------------
adminRouter.post('/api/retry/:id', async (req, res) => {
  const entry = history.find(h => h.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entree introuvable' });
  if (!whatsappReady || !sock) return res.status(503).json({ error: 'Client WhatsApp non pret' });

  const { requestedBy_username, requestedBy_email, media_title, media_type, media_poster } = entry;
  const users     = loadJson(USERS_FILE, {});
  const emailKey  = String(requestedBy_email).toLowerCase();
  const userEntry = Object.keys(users).find(k => k.toLowerCase() === emailKey);
  const phone     = userEntry ? users[userEntry] : null;
  if (!phone) return res.status(404).json({ error: 'Aucun numero mappe pour ' + requestedBy_email });

  const jid         = toChatJid(phone);
  const messageText = buildMessage({ requestedBy_username, media_title, media_type });
  const base        = { requestedBy_username, requestedBy_email, media_title, media_type, media_poster };

  try {
    if (media_poster && media_poster.startsWith('http')) {
      try {
        const { buffer, mimeType } = await fetchImageBuffer(media_poster);
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
    return res.status(500).json({ error: 'Erreur WhatsApp', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Montage des routes
// ---------------------------------------------------------------------------
app.use('/dashboard', adminRouter);
app.use((req, res) => res.status(404).json({ error: 'Route inconnue' }));

// ---------------------------------------------------------------------------
// Demarrage
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('[server] Port ' + PORT + ' | Webhook: POST /webhook | Admin: /dashboard');
});
connectWhatsApp();