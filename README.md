KIRA WhatsApp Bot - root-file deployment

Start locally:
1. npm install
2. cp .env.example .env
3. npm start
4. Open http://localhost:5000

Main files:
- server.js        main backend and bot logic
- index.html      QR / pairing login page
- admin.html      admin dashboard
- *.json          root storage files
- Procfile        Heroku compatible
- render.yaml     Render compatible
- railway.json    Railway compatible
- koyeb.yaml      Koyeb compatible
- Dockerfile      Docker deployment
- nixpacks.toml   Nixpacks deployment

Important env values:
PORT=5000
ADMIN_UI_TOKEN=change-this-token
SESSION_DIR=./session
BASE_URL=https://your-domain.com

Notes:
- QR and pairing code are emitted over Socket.IO.
- Message replies use msg.reply with a safe fallback.
- Keep one active instance per WhatsApp session to avoid WhatsApp session lock errors.
