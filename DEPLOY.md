# Beta Signaling Server Deployment

## GitHub Setup

```bash
cd "/Users/mytech/Downloads/MyTech Apps/Alternative/clevrsend-signaling-beta"
git remote set-url origin https://github.com/cubaseuser3-ai/clevrsend-signaling-beta.git
git push -u origin main
```

## Render.com Setup

1. Gehe zu https://dashboard.render.com/
2. Klicke "New +" → "Web Service"
3. Verbinde GitHub Repository: `clevrsend-signaling-beta`
4. Konfiguration:
   - **Name:** `clevrsend-signaling-beta`
   - **Environment:** Docker
   - **Region:** Frankfurt (EU Central)
   - **Branch:** main
   - **Plan:** Free
   - **Health Check Path:** `/health`

5. Klicke "Create Web Service"

## Deployment URL

Nach dem Deployment wird die URL sein:
- **WebSocket:** `wss://clevrsend-signaling-beta.onrender.com`
- **Health Check:** `https://clevrsend-signaling-beta.onrender.com/health`

## Version

Beta Signaling Server: **v1.4.0-beta.1**
