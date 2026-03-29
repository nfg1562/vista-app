# VISTA Migration Skeleton

Ce dépôt conserve le prototype Streamlit existant et ajoute une architecture monorepo prête pour une migration en production.

## Structure

- `/backend` : FastAPI + WebSocket avec moteur de temps centralisé.
- `/frontend` : Next.js (React) avec navigation de base et slider synchronisé.
- `app1.py` reste pour référence pendant la migration.

## Lancement local

### Backend

```bash
python -m venv .venv-backend
source .venv-backend/bin/activate
pip install -r backend/requirements.txt
uvicorn api:app --app-dir backend --reload --port 8000
```

Le backend expose :

- `GET /health` : vérifie l'état.
- `WebSocket /ws` : envoie périodiquement l'état `time_update`.

## Partage sécurisé

Pour partager l'app sans exposer le code, hébergez uniquement le frontend et le backend, puis activez l'authentification:

```bash
export VISTA_ADMIN_PASSWORD="change-me-admin"
export VISTA_VIEWER_PASSWORD="change-me-viewer"
export VISTA_AUTH_SECRET="change-me-long-random-secret"
export VISTA_CORS_ORIGINS="https://ton-frontend.example.com"
```

Comportement:

- `admin` : accès complet
- `viewer` : accès lecture seule aux analyses
- sans `VISTA_*_PASSWORD` : l'auth reste désactivée pour le dev local

Frontend:

```bash
export NEXT_PUBLIC_API_URL="https://ton-backend.example.com"
export NEXT_PUBLIC_WS_URL="wss://ton-backend.example.com"
export NEXT_PUBLIC_MATCH_ID="local-demo"
```

## Déploiement Vercel + Railway

### 1. Backend sur Railway

- Connectez le repo GitHub à Railway.
- Créez un nouveau service depuis ce repo.
- Laissez Railway utiliser le `Dockerfile` à la racine.
- Ajoutez un `Volume` Railway monté sur `/data`.
- Ajoutez les variables d'environnement du fichier [backend/.env.example](/Users/nohaavril/Live/App/backend/.env.example).

Variables minimum :

```bash
VISTA_ADMIN_PASSWORD=change-me-admin
VISTA_VIEWER_PASSWORD=change-me-viewer
VISTA_AUTH_SECRET=change-me-long-random-secret
VISTA_CORS_ORIGINS=https://your-frontend-domain.vercel.app
VISTA_DATA_DIR=/data
```

Le `Dockerfile` copie aussi les CSV et le dataset du preset Gabon, donc le preset reste disponible en production.

### 2. Frontend sur Vercel

- Importez le même repo dans Vercel.
- Dans les paramètres du projet, définissez `Root Directory` sur `frontend`.
- Ajoutez les variables d'environnement du fichier [frontend/.env.example](/Users/nohaavril/Live/App/frontend/.env.example).

Variables minimum :

```bash
NEXT_PUBLIC_API_URL=https://your-backend-domain.up.railway.app
NEXT_PUBLIC_WS_URL=wss://your-backend-domain.up.railway.app
NEXT_PUBLIC_MATCH_ID=local-demo
```

### 3. CORS

Une fois Vercel déployé, copiez son vrai domaine public dans `VISTA_CORS_ORIGINS` côté Railway. Exemple :

```bash
VISTA_CORS_ORIGINS=https://vista-app.vercel.app
```

### 4. Lien à partager

Partagez uniquement l'URL Vercel du frontend, par exemple :

```text
https://vista-app.vercel.app
```

L'utilisateur se connecte avec le mot de passe `viewer` et n'a pas accès au repo ni au backend.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Le frontend contacte le backend sur `ws://localhost:8000/ws` et expose :

- `/` : page d'accueil.
- `/match` : slider synchronisé et métriques.
- `/training` : page placeholder Entraînement.

Assurez-vous que la variable `NEXT_PUBLIC_WS_URL` pointe vers `ws://localhost:8000/ws` si vous lancez frontend/back séparément.
