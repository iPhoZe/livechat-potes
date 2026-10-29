# 🎉 LiveChat Potes

Envoie des GIFs, images, vidéos et sons qui s'affichent **directement sur l'écran de tes potes**, par-dessus tout (jeu en fenêtré, navigateur, Discord…).

```
 Toi (appli)  ──►  Serveur relais  ──►  Appli de ton pote  ──►  overlay sur son écran
```

- `server/` : le petit serveur relais (une seule personne le lance)
- `app/` : l'appli Windows que **chaque pote** installe

---

## Installer

Télécharge `LiveChat-Potes-Setup-x.y.z.exe` dans les [Releases](../../releases/latest), lance-le, choisis un pseudo
et entre le **code du salon** que te donne celui qui héberge. L'appli se met ensuite à jour toute seule.

## Hébergement

- L'hébergeur coche **« Héberger le salon sur ce PC »** : le serveur relais tourne dans l'appli (port 8080).
- Un tunnel TCP (ici playit.gg) rend ce port joignable depuis Internet.
- `app/defaults.json` est intégré à l'installateur : il pré-remplit l'adresse du serveur. Le code du salon n'y est
  **pas** (le dépôt et l'installateur sont publics) : il se partage à part, entre potes.

## Publier une mise à jour

1. Changer `version` dans `app/package.json` (ex. `1.2.1`).
2. `cd app && npm run dist`
3. Créer une release GitHub `v1.2.1` avec `dist/LiveChat-Potes-Setup-1.2.1.exe`, son `.blockmap` et `latest.yml`.

Les applis installées vérifient au démarrage puis toutes les 4 h, téléchargent en fond et installent à la fermeture.

> Compiler depuis un dossier au **chemin court** : avec un chemin trop long, NSIS échoue
> (limite Windows de 260 caractères dans `node_modules`).

## Nouveautés v1.1

- Nouvelle interface : premier lancement guidé, réglages séparés, bouton **Quitter** (⏻), choix à la fermeture.
- **Liens X / Twitter** : la vidéo (ou l'image) du post est récupérée via l'API publique FxTwitter (secours : vxTwitter).
- **Vidéos limitées à 15 s**, avec un curseur pour choisir le passage à envoyer.
- **Liste des gens en ligne** avec bouton ↻ (vérifie qui répond vraiment) et indicateur « peut recevoir / ne pas déranger ».
  Clic sur un pote = envoi à lui seul.
- **Accusés de réception** : ⏳ en route → ✓ reçu → ✓✓ vu (affiché à l'écran), ✗ échec, 🔕 ne pas déranger.
- **Installateur** (`LiveChat-Potes-Setup-x.y.z.exe`) avec raccourcis Bureau / menu Démarrer + option « Lancer au démarrage de Windows ».

## Nouveautés v1.4 : duel de clics 🪢

- Choisis un média, clique sur un pote, puis **⚔ Duel** : un panneau apparaît chez vous deux, compte à rebours 3, 2, 1, GO !
- **Tir à la corde** : chaque clic tire la corde de ton côté. Premier à 30 clics d'avance, ou celui qui mène au bout de 20 s.
- **Le perdant se mange le média** (si le lanceur perd : retour à l'envoyeur). Égalité : tout le monde le reçoit.
- Les clics sont comptés par le serveur (anti-triche, 20 clics/s max). Déconnexion pendant le duel = forfait.

## Nouveautés v1.3 : mode combat ⚔️

- Chaque média reçu a **10 cœurs** façon Minecraft. Clique dessus pour lui faire des dégâts (tremblement, flash rouge,
  chiffres de dégâts, coups critiques). À 0 cœur, il explose en fumée et disparaît.
- L'expéditeur voit **💀 détruit** dans ses accusés de réception.
- La souris n'est captée qu'au-dessus du média : partout ailleurs, les clics passent à tes fenêtres.

## Nouveautés v1.2

- **Mises à jour automatiques** via GitHub Releases (bandeau « Redémarrer pour l'installer », bouton « Rechercher » dans les réglages).
- Le code du salon n'est plus intégré à l'installateur : il est demandé au premier lancement.

## 1. Lancer le serveur (une seule personne)

> Plus nécessaire si l'hébergeur coche « Héberger le salon sur ce PC » dans l'appli.

```bash
cd server
npm install
npm start
```

Le serveur écoute sur le port **8080** (modifiable : `PORT=9000 npm start`).

### Rendre le serveur accessible à tes potes

Le plus simple dépend de votre situation :

| Option | Comment | Adresse à mettre dans l'appli |
|---|---|---|
| **Même réseau / test** | Rien à faire | `ws://IP-LOCALE-DU-PC:8080` |
| **Cloudflare Tunnel** (gratuit, sans ouvrir de port) | Installer `cloudflared` puis `cloudflared tunnel --url http://localhost:8080` | `wss://xxxx.trycloudflare.com` (l'URL affichée, avec `wss://`) |
| **Tailscale** (VPN entre potes) | Tout le monde installe Tailscale et rejoint le même réseau | `ws://IP-TAILSCALE:8080` |
| **Ouvrir un port** | Rediriger le port 8080 sur ta box | `ws://TON-IP-PUBLIQUE:8080` |
| **Hébergé 24/7** | Déployer `server/` sur Render, Railway, Fly.io… | `wss://ton-app.onrender.com` |

> L'URL `trycloudflare` change à chaque lancement. Pour une adresse fixe : Tailscale ou un hébergeur.

Réglages du serveur (variables d'environnement) :
- `MAX_MB` : taille max d'un média (25 par défaut)
- `COOLDOWN_MS` : délai mini entre deux envois d'une même personne (2000 par défaut)

---

## 2. Lancer l'appli (chaque pote)

```bash
cd app
npm install
npm start
```

Puis dans la fenêtre **Connexion** :
1. **Adresse du serveur** : celle donnée par la personne qui héberge
2. **Ton pseudo**
3. **Code du salon** : le même pour toute la bande. Il sert de mot de passe, garde-le secret.

### Faire un .exe à envoyer aux potes

```bash
cd app
npm run dist
```

Ça crée un `.exe` portable dans `app/dist/`. Tes potes n'ont qu'à le lancer, pas besoin d'installer Node.

---

## Utilisation

- **Envoyer** : glisse un fichier dans la zone, clique pour en choisir un, colle une image (`Ctrl+V`) ou colle un **lien direct** (`.gif`, `.mp4`, `.webm`, `.png`, `.mp3`…). Ajoute un message, choisis le destinataire (ou *Tout le monde*), puis **Envoyer**.
- **Tester sur moi** : affiche le média sur ton propre écran, sans l'envoyer.
- Les médias s'affichent un par un, à une position aléatoire, avec ton pseudo et ton message.
  - Images et GIFs : durée réglable (6 s par défaut)
  - Vidéos : jusqu'à la fin (30 s max)
  - Sons : une bulle 🔊 pendant la lecture

### Garder le contrôle (côté receveur)

| Action | Comment |
|---|---|
| Effacer tout ce qui est affiché + vider la file | `Ctrl+Maj+X` |
| Mode **Ne pas déranger** (plus rien n'arrive) | `Ctrl+Maj+D`, ou la case dans Réglages, ou clic droit sur l'icône |
| Volume des vidéos/sons | Réglages |
| Quitter complètement | Clic droit sur l'icône près de l'horloge → Quitter |

Fermer la fenêtre ne quitte pas l'appli : elle reste dans la zone de notification pour continuer à recevoir.

---

## Limites connues

- **Jeux en plein écran exclusif** : l'overlay ne peut pas passer par-dessus. Mets le jeu en **plein écran fenêtré / sans bordure**.
- **Liens Tenor / Giphy** : il faut le lien **direct** vers le fichier (clic droit sur le GIF → *Copier l'adresse de l'image*), pas le lien de la page.
- Les liens YouTube ne sont pas lus (seulement les fichiers vidéo directs).
- L'overlay s'affiche sur l'**écran principal**.
- Le serveur ne stocke rien : les médias transitent puis disparaissent.
