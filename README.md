# 🟢 Whatsoverr

**Whatsoverr** est un relai Webhook ultra-léger conçu pour faire le pont entre **Overseerr** et **WhatsApp**.
Amis, famille, tout le monde n'a pas Discord ou Telegram, ne trouvant rien qui repondait à mon besoin j'ai donc vibecodé ce petit projet qui est ultra léger.

Lorsqu'un média demandé sur Overseerr devient disponible, Whatsoverr envoie automatiquement une notification WhatsApp à l'utilisateur qui l'a demandé (avec l'affiche du film/série).

![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-22d372.svg)
![RAM](https://img.shields.io/badge/RAM-~50MB-purple.svg)

---

## ✨ Whatsoverr c'est quoi ? 

Whatsoverr a été entièrement écrit sur la librairie **Baileys** (WebSocket), offrant une très faible consommation RAM de **~6 0Mo**.

*   📱 **Configuration simple** : Le dashboard permet de configurer le bot depuis une interface simple et intuitive.
*   📱 **Dashboard PWA** : Une interface d'administration Web moderne, responsive (PWA installable sur smartphone).
*   🌍 **Multi-Langues** : Assigne une langue (FR / EN) à chaque utilisateur. Whatsoverr utilisera le bon template de message automatiquement !
*   🔕 **Mode "Ne Pas Déranger"** : Définis une plage silencieuse ; les messages seront mis en file d'attente et distribués à la fin de la plage horaire.
*   👥 **Import intelligent Overseerr** : Connecte Whatsoverr à l'API Overseerr pour importer tes utilisateurs et leurs avatars d'un simple clic.
*   💾 **Sauvegarde en 1 clic** : Exporte et importe toute ta configuration (utilisateurs, numéros, templates) facilement depuis le dashboard.
*   🤖 **Notifications Discord** : Alertes système (ex: WhatsApp déconnecté) via webhook Discord, avec un système d'anti-spam.


## 🚀 Installation rapide (Docker)

Plus besoin de compiler ! Une image Docker multi-architecture (`amd64` / `arm64`) est automatiquement générée.

1. Crée un fichier `docker-compose.yml` :
```yaml
services:
  whatsoverr:
    image: ghcr.io/kyben20/whatsoverr:latest
    container_name: whatsoverr
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASSWORD=changeme
      - TZ=Europe/Paris
    volumes:
      - ./data:/usr/src/app/data
      - ./auth_info:/usr/src/app/auth_info
```

2. Lance le conteneur :
```bash
docker compose up -d
```

## ⚙️ Configuration

1. **Accès au Dashboard :** Ouvre `http://<IP_DE_TON_SERVEUR>:3000/dashboard` dans ton navigateur. Connecte-toi avec `admin` / `changeme`.
2. **Lier WhatsApp :** Dans l'onglet *Statut*, scanne le QR Code avec l'application WhatsApp de ton bot (Appareils connectés > Lier un appareil).
3. **Connecter Overseerr :** Dans *Réglages*, renseigne l'URL et la clé API de ton Overseerr, puis va dans l'onglet *Utilisateurs* pour les importer.
4. **Configurer le Webhook Overseerr :** 
   * Va dans les réglages de ton Overseerr > Notifications > Webhook.
   * Coche `Demande Disponible` (Media Available).
   * Webhook URL : `http://<IP_DE_WHATSOVERR>:3000/webhook`
   * JSON Payload : Laisse par défaut ou assure-toi que `{{request.requestedBy_email}}`, `{{subject}}` et `{{image}}` soient présents.

## 📝 Personnalisation des Templates

Dans l'onglet *Réglages*, tu peux personnaliser le message WhatsApp envoyé pour le français et l'anglais en utilisant ces variables :
* `{username}` : Nom de l'utilisateur ayant fait la demande
* `{title}` : Titre du film ou de la série
* `{icon}` : Icône automatique (🎬 pour un film, 📺 pour une série)
* `{type}` : Le mot "Film" ou "Série"

*Exemple de template par défaut :*
> Salut *{username}* 👋
> 
> {icon} *{title}* que tu as demandé est disponible !
> Bon visionnage 🍿
> 
> _— Message automatisé_

---

**Développé avec Claude pour la communauté de l'auto-hébergement.**
