# Whatsoverr - Overseerr WhatsApp Notifications

Un bot léger et autonome pour envoyer des notifications WhatsApp multi-utilisateurs basées sur les webhooks d'Overseerr.

![Whatsoverr Dashboard](https://github.com/KyBen20/whatsoverr/blob/main/public/logo.png)

## 🚀 Fonctionnalités

- **Extrêmement léger** : ~50Mo de RAM (utilise Baileys via WebSocket pur, *aucun navigateur Chrome n'est requis*).
- **Dashboard d'administration** intégré et sécurisé.
- **Intégration Overserr** : Importation des utilisateurs Overserr en 1 clic.
- **Historique et Relances** : Visualisation des statuts d'envoi et bouton pour réessayer en cas d'erreur.
- **Affiches (Posters)** : Récupération des images TMDB en miniature.
- **Zero Configuration Code** : Tout est configurable via le dashboard Web ou variables d'environnement.

## 📦 Installation via Docker

1. Clonez le dépôt :
```bash
git clone https://github.com/votre_pseudo/overseerr-whatsapp.git
cd overseerr-whatsapp
```

2. Préparez vos variables d'environnement :
```bash
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env
```

3. Modifiez le fichier `.env` pour définir votre mot de passe d'administration :
```env
ADMIN_USER=admin
ADMIN_PASSWORD=changez_moi
```

4. Lancez le container :
```bash
docker-compose up -d --build
```

## ⚙️ Configuration

1. Accédez au dashboard : `http://ip_de_votre_serveur:3001/dashboard`
2. Connectez-vous avec vos identifiants.
3. **Scannez le QR Code** avec votre application WhatsApp mobile (Appareils connectés -> Lier un appareil).
4. Ajoutez vos utilisateurs dans l'onglet **Utilisateurs** (manuellement ou via l'import Overseerr).

### Configuration Overseerr
Dans Overseerr, allez dans **Settings > Notifications > Webhook** :
- **Webhook URL** : `http://ip_de_votre_serveur:3001/webhook`
- **JSON Payload** :
```json
{
  "notification_type": "{{notification_type}}",
  "subject": "{{subject}}",
  "image": "{{image}}",
  "media_type": "{{media_type}}",
  "requestedBy_username": "{{requestedBy_username}}",
  "requestedBy_email": "{{requestedBy_email}}"
}
```

## 🛠️ Stack Technique
- Node.js & Express
- [Baileys](https://github.com/WhiskeySockets/Baileys) (Client WhatsApp Web)
- Docker & Docker Compose
