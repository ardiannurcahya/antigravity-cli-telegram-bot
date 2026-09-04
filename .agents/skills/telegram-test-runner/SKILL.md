---
name: telegram-test-runner
description: >-
  Protocole de recette et de validation interactive sur le bot Telegram dédié aux tests pour le projet agy-telegram.
  À utiliser lors du développement d'une fonctionnalité ou d'un correctif pour démarrer un runner temporaire isolé
  et l'arrêter impérativement dès que la pull request vers l'amont est soumise.
---

# Recette sur le bot Telegram dédié aux tests

Cette compétence encadre la validation fonctionnelle et interactive d'une évolution du bot `agy-telegram` (branche `feature/*`, `fix/*` ou `refactor/*`) avant sa soumission en pull request et son déploiement en production.

---

## 1. Contexte et isolation de l'environnement de test

Pour éviter de perturber le service en production géré par systemd (`agy-telegram.service`), les tests d'intégration réels sur Telegram s'effectuent sur une instance dédiée et éphémère.

* **Identifiant du bot de test :** `@Chromie_lemed_test_bot` (ID numérique : `8797558243`)
* **Configuration d'environnement :** `~/.config/agy-telegram-test/.env`
* **Utilisateur Telegram autorisé :** `704035925`
* **Fichier d'état isolé :** `~/.config/agy-telegram-test/state.json`
* **Répertoire temporaire isolé :** `~/.config/agy-telegram-test/tmp/`

L'instance de test utilise son propre fichier d'état et son propre dossier temporaire afin de garantir une étanchéité absolue avec la production.

---

## 2. Procédure de recette en 4 étapes

### Étape 1 : Compilation préalable
Avant de lancer le runner de test, compiler obligatoirement les sources TypeScript :

```bash
cd /home/med/projets/agy-telegram
npm run build
```

### Étape 2 : Lancement du runner temporaire de test
Démarrer le bot de test en tâche complètement détachée pour ne jamais bloquer la session CLI ni suspendre la passerelle Telegram :

```bash
nohup env AGY_ENV_FILE="$HOME/.config/agy-telegram-test/.env" node dist/cli.js > "$HOME/.config/agy-telegram-test/runner.log" 2>&1 & echo $! > "$HOME/.config/agy-telegram-test/runner.pid"
```

> ⚠️ **Directive stricte pour l'agent :** Ne JAMAIS lancer ce processus directement ou en tâche d'arrière-plan interne Antigravity (`run_command` sans détachement complet `nohup ... &`). En mode non-interactif (`agy --print`), le processus parent resterait bloqué indéfiniment en attendant la fin du sous-processus. Le lancement doit impérativement être détaché et enregistrer son PID.

Vérifier immédiatement le bon démarrage sans erreur dans le journal :
```bash
sleep 1 && tail -n 15 "$HOME/.config/agy-telegram-test/runner.log"
```

### Étape 3 : Validation interactive sur Telegram
1. Ouvrir la conversation Telegram avec le bot de test ([@Chromie_lemed_test_bot](https://t.me/Chromie_lemed_test_bot) ou ID `8797558243`).
2. Exécuter les scénarios de test ciblés par l'évolution :
   * Commandes usuelles (`/start`, `/menu`, `/model`, `/workspace`, etc.).
   * Prompts spécifiques testant la nouvelle fonctionnalité.
   * Vérification des transitions, retours visuels et absence d'erreur dans la console ou `runner.log`.

### Étape 4 : Arrêt obligatoire dès soumission de la pull request
> ⚠️ **Règle absolue :** Dès que la validation est concluante et que la pull request vers l'amont (*upstream*) est ouverte et soumise, **le runner temporaire de test doit être immédiatement arrêté**.

Arrêter le processus via son fichier PID :
```bash
if [ -f "$HOME/.config/agy-telegram-test/runner.pid" ]; then
  kill "$(cat "$HOME/.config/agy-telegram-test/runner.pid")" 2>/dev/null || true
  rm -f "$HOME/.config/agy-telegram-test/runner.pid"
fi
```

En cas de PID orphelin, forcer l'arrêt du processus de test ciblé :
```bash
pkill -f "node dist/cli.js" 2>/dev/null || true
```

---

## 3. Synthèse des commandes

Action | Commande
:--- | :---
**Compiler** | `npm run build`
**Lancer le runner détaché** | `nohup env AGY_ENV_FILE="$HOME/.config/agy-telegram-test/.env" node dist/cli.js > "$HOME/.config/agy-telegram-test/runner.log" 2>&1 & echo $! > "$HOME/.config/agy-telegram-test/runner.pid"`
**Vérifier le statut** | `tail -n 15 "$HOME/.config/agy-telegram-test/runner.log"`
**Arrêter le runner de test** | `kill "$(cat "$HOME/.config/agy-telegram-test/runner.pid")" 2>/dev/null && rm -f "$HOME/.config/agy-telegram-test/runner.pid"`
