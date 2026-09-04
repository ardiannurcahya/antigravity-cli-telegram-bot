# Guide de qualification et checklist de tests : Option 2.5 (Bot de test)

Ce guide fournit la liste des tests fonctionnels à réaliser en conditions réelles sur le **bot Telegram de test** (`@Chromie_lemed_test_bot` / `8797558243`) pour qualifier l'isolation des tours de délégation et les citations dépliables.

---

## 1. Environnement de test

- **Bot cible :** [@Chromie_lemed_test_bot](https://t.me/Chromie_lemed_test_bot)
- **Instance active :** Runner éphémère exécutant la branche `feature/subagent-delegation-expandable-quote`
- **Configuration :** `~/.config/agy-telegram-test/.env`
- **Production :** Intacte et active en parallèle sur `agy-telegram.service`

---

## 2. Checklist des scénarios de test

### Test 1 : Tâche avec délégation de sous-agent (Mode détaillé par défaut)
* **Objectif :** Vérifier que le préambule de l'agent n'apparaît plus en texte brut dans la réponse finale mais dans un bloc de citation dépliable Telegram.
* **Configuration :** `/verbose detailed` (ou réglage par défaut).
* **Prompt suggéré :**
  > « Active le sous-agent research pour vérifier la dernière version de nodejs. »
  *(ou tout prompt incitant explicitement l'agent à annoncer une intention avant d'invoquer un outil ou sous-agent)*
* **Résultats attendus :**
  - [ ] Pendant l'exécution : le message de progression (`⏳ AGY is working...`) affiche un ticker compact et fluide (ex. `➜ 🤖 Subagent: research` ou `⚙️ Command: ...`), sans pavé de texte envahissant.
  - [ ] À la livraison finale : un bloc dépliable `🤖 Context & delegation:` apparaît en tête du message.
  - [ ] En cliquant sur la flèche ou le bloc dépliable : le préambule intermédiaire se déplie correctement.
  - [ ] En dessous du bloc dépliable : la réponse finale synthétique est propre et ne répète pas le texte de préambule.

---

### Test 2 : Requête simple sans outil ni sous-agent (Mono-tour)
* **Objectif :** Vérifier la non-régression sur les réponses directes.
* **Configuration :** `/verbose detailed`
* **Prompt suggéré :**
  > « Quelle est la capitale de l'Australie ? Réponds en un mot. »
* **Résultats attendus :**
  - [ ] Aucun bloc de citation dépliable n'est généré.
  - [ ] La réponse directe (« Canberra ») est livrée directement et immédiatement.

---

### Test 3 : Mode de verbosité compact (`/verbose compact`)
* **Objectif :** Vérifier le masquage complet du préambule intermédiaire en mode synthétique.
* **Configuration :** Taper `/verbose compact` (ou choisir via le menu inline `/menu` -> `Verbose` -> `compact`).
* **Prompt suggéré :**
  > « Liste les 3 premiers fichiers à la racine du projet via la commande ls. »
* **Résultats attendus :**
  - [ ] Le message de progression affiche les étapes de manière compacte.
  - [ ] À la livraison finale, **aucun bloc de citation dépliable n'apparaît**.
  - [ ] Seule la conclusion finale propre est envoyée.

---

### Test 4 : Réinitialisation de session (`/new`)
* **Objectif :** Vérifier que `/new` nettoie correctement le contexte sans impacter l'état du runner.
* **Commande :** `/new`
* **Résultats attendus :**
  - [ ] Le bot confirme la réinitialisation de la session (`✨ Conversation reset`).
  - [ ] Les compteurs et l'historique conversationnel repartent de zéro.

---

## 3. Synthèse de validation

Une fois l'ensemble de ces points validés :
1. Informer l'agent que la qualification est conforme (`OK pour la PR`).
2. L'agent procédera à l'arrêt du runner de test (`pkill -f agy-telegram-test`) et à la soumission propre de la pull request vers l'amont (`upstream:main`).
