# Carnet de route et backlog du projet agy-telegram

Ce document assure le suivi opérationnel, l'état d'avancement des contributions et la feuille de route du bot Telegram pour Antigravity CLI.

---

## 1. Suivi des contributions et transition vers le fork officiel

Historiquement développé sur une version personnalisée (`agy-telegram-custom`), le projet bascule vers le fork officiel (`LeMeD/antigravity-cli-telegram-bot`) en miroir du dépôt amont (`ardiannurcahya/antigravity-cli-telegram-bot`).

### État des pull requests

- [x] **PR #19** : Alignement des modèles Gemini par défaut (Gemini 3.8 Flash High/Medium/Low, Gemini 3.7, Claude, GPT) avec calcul dynamique du contexte. *(Fusionnée dans upstream/main)*
- [x] **PR #22** : Rendu propre des liens de conversation `conversation://` et de fichiers `file://` en HTML Telegram, durcissement de l'analyse des commandes AGY et résilience SQLite. *(Fusionnée dans upstream/main)*
- [x] **PR #23** : Prise en charge des documents images non compressés, résilience réseau avec backoff pour les téléchargements de fichiers et gestion du cycle de vie des fichiers temporaires (purge sur `/new` et fichiers de plus de 24h). *(Fusionnée dans upstream/main)*
  - Lien : https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/pull/23
- [x] **Finalisation de la bascule sur le fork officiel** :
  - Procédure de bascule exécutée avec succès (alignement sur upstream/main, synchronisation sur fork/main, suppression de la branche locale fix, compilation TypeScript et redémarrage du service systemd).

---

## 2. Procédure opérationnelle de bascule (dès fusion de la PR #23)

Lorsque la PR #23 est validée et fusionnée par Ardian, exécuter la séquence suivante pour aligner l'instance locale en production :

```bash
# 1. Se positionner sur la branche principale et récupérer les commits fusionnés
cd /home/med/projets/agy-telegram
git checkout main
git pull upstream main

# 2. Mettre à jour la branche main de votre fork sur GitHub
git push fork main

# 3. Supprimer la branche locale devenue obsolète
git branch -d fix/image-handling-and-session-cleanup

# 4. Compiler le code TypeScript
npm run build

# 5. Redémarrer le service systemd du bot
systemctl --user restart agy-telegram
```

### Vérifications post-bascule
1. Contrôler le statut du service : `systemctl --user status agy-telegram`.
2. Envoyer `/start` ou `/menu` sur Telegram pour confirmer la réactivité du bot.
3. Vérifier que la version active contient l'ensemble des fonctionnalités amont (topics de forum, messages vocaux, images haute fidélité).
4. Archiver ou conserver en simple lecture le dépôt `agy-telegram-custom` sur GitHub.

---

## 3. Améliorations futures et pistes d'évolution

- [x] **Isolation de workspace par session et topic (/workspace)** : Portée dynamique du répertoire de travail (`cwd`), autocomplétion native Telegram et sélection interactive par boutons inline, résolution flexible avec préfixe slash (`/`), rappel visuel du workspace forcé au prompt, réinitialisation éphémère en DM 1:1 sur `/new` (Option A) et persistance par forum topic, sécurisé par vérification de confinement (`isWithin`) ([Issue #26](https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/issues/26), [Spécifications](docs/specs/per-session-workspace-isolation.md)).
- [ ] **Transcription vocale automatique (Speech-to-Text / STT)** : Transcription automatique des messages vocaux Telegram en prompts textuels directs via Gemini Speech ou Whisper ([Spécifications](docs/specs/speech-to-text-transcription.md)).
- [ ] **Internationalisation (i18n)** : Possibilité de configurer la langue des messages système du bot (français / anglais).
- [ ] **Gestion avancée des quotas** : Alertes Telegram paramétrables lorsque le quota approche d'un seuil critique (ex. 80 %).
- [ ] **Commandes rapides personnalisées** : Permettre la définition d'alias de prompts personnalisés depuis l'interface utilisateur.
