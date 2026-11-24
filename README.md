# Wenhui Ma — portfolio website + AI admin panel

The website (copied from wenhuimaaa.cargo.site) plus an admin panel at **/admin** where you describe
in plain language how the site should look, and an AI edits the site for you. Changes go live immediately.

```
site/        the website itself (HTML, CSS, JS, images, videos, fonts)
admin/       the admin panel (chat + live preview)
server.js    small Node.js server: serves the site and runs the admin AI
.env         secrets: admin login + OpenRouter API key (never share or commit this)
data/        created automatically: chat history and undo history
```

## Run it on your computer

Needs Node.js 18 or newer (nodejs.org). No `npm install` needed.

```bash
cd ~/Desktop/wenhuima && node server.js
```

- Website: http://localhost:3000
- Admin: http://localhost:3000/admin (log in with the username and password in `.env`)

## Using the admin panel

- Type what you want, e.g. "make the home page background black with white text" or
  "add a Contact page with my Instagram". You can attach or paste images (reference designs or new artwork);
  they are saved into `site/assets/uploads/` and the AI can place them on the site.
- The preview on the right reloads after every change. Switch between **Desktop** and **Phone** to check both.
- **↶ Undo** reverts the AI's last request (press it repeatedly to go further back).
- **New chat** starts a fresh conversation; the website stays as it is.
- AI model: **Claude Sonnet 5.5** (default; strong at design, about $0.02–0.10 per request).
  Pick **Claude Opus 5.5** in the dropdown for very large redesigns (about 2× the cost).
  Each reply shows what it cost. Usage is billed to your OpenRouter account (openrouter.ai → Credits).

## Put it online with your domain

Because the AI changes files on the server, the site must run on a host that runs Node.js **and keeps
files on disk** (static hosts like Netlify or GitHub Pages can't run the admin).

**Simplest: a small VPS** (Hetzner, DigitalOcean, Vultr, ~$5/month):
1. Install Node.js, copy this whole folder (including `.env`) to the server.
2. Run it permanently, e.g. `npx pm2 start server.js --name portfolio && npx pm2 save`.
3. Install Caddy (caddyserver.com) with this `Caddyfile` — it gets the HTTPS certificate automatically:
   ```
   yourdomain.com, www.yourdomain.com {
       reverse_proxy localhost:3000
   }
   ```
4. At your domain registrar, point an `A` record for `@` and `www` to the server's IP address.

**Or Railway / Render / Fly.io:** deploy this folder as a Node app (start command `node server.js`),
add the values from `.env` as environment variables, and attach a **persistent volume** mounted at `/data`
with `SITE_DIR=/data/site` and `DATA_DIR=/data/admin` — otherwise every redeploy erases the AI's changes.
On first start the server copies `site/` onto the volume. Then add your domain in the host's settings.

Always use HTTPS in production so the admin password is sent encrypted.

## Changing secrets

Edit `.env` and restart the server:
- `ADMIN_USERNAME`, `ADMIN_PASSWORD` — admin login
- `OPENROUTER_API_KEY` — your OpenRouter key
- `AI_MODEL` — default model (any OpenRouter model id)

## Backups

The AI's undo history is in `data/history/`. For a full backup, copy the `site/` folder now and then.
