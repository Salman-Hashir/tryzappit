# TryZappit 🔥

> P2P file transfer. No servers. No uploads. No size limits.

Browser-to-browser file sharing using WebRTC DataChannels. Files never touch a server.

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML/CSS/JS + Three.js |
| Signaling | Node.js + Socket.io |
| P2P | WebRTC DataChannel |
| STUN | Google free STUN |
| Frontend Deploy | Vercel / Netlify (free) |
| Server Deploy | Render (free) |

---

## Project Structure

```
tryzappit/
├── server/
│   ├── index.js          # Socket.io signaling server
│   └── package.json
└── public/
    ├── index.html        # Landing page (Three.js wormhole)
    ├── css/
    │   └── style.css     # Global styles
    ├── js/
    │   ├── webrtc.js     # WebRTC P2P manager
    │   └── app.js        # Main app logic + UI
    └── pages/
        ├── send.html     # Create room + send files
        ├── receive.html  # Join room + receive files
        └── room.html     # Universal room (via link/QR)
```

---

## Deploy in 10 Minutes

### 1. Deploy Signaling Server (Render — Free)

1. Push `server/` folder to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo
4. Settings:
   - **Build command:** `npm install`
   - **Start command:** `node index.js`
   - **Environment:** Node
5. Deploy → copy the URL (e.g. `https://tryzappit-server.onrender.com`)

### 2. Update Server URL in Frontend

In these files, replace the server URL:
- `public/pages/send.html` → line with `window.ZAPPIT_SERVER`
- `public/pages/receive.html` → same
- `public/pages/room.html` → same

```js
window.ZAPPIT_SERVER = 'https://YOUR-SERVER.onrender.com';
```

### 3. Deploy Frontend (Vercel — Free)

```bash
npm install -g vercel
cd public/
vercel
```

Or drag-drop `public/` folder to [netlify.com](https://netlify.com).

---

## Features

- ⚡ **Zero upload** — files go browser-to-browser only
- 👥 **Group share** — one file to multiple peers simultaneously  
- 💬 **P2P chat** — no logs, disappears when session ends
- 👁 **File preview** — images, video, audio, PDF in browser
- 🔐 **Password rooms** — optional room password
- 📱 **All platforms** — Chrome, Safari, Firefox, Edge, Mobile
- 🔗 **3 invite methods** — room code, shareable link, QR code
- ∞ **No size limit** — chunked transfer handles GBs

---

## How P2P Works

```
Sender Browser ──[offer]──→ Signaling Server ──[offer]──→ Receiver Browser
Sender Browser ←──[answer]── Signaling Server ←──[answer]── Receiver Browser
          ↓                                                        ↓
     STUN Server (find public IP)                      STUN Server
          ↓                                                        ↓
     Direct WebRTC DataChannel Connection (P2P) ←─────────────────┘
          ↓
     Files stream directly — server never sees file data
```

The signaling server only exchanges ~1KB of WebRTC handshake data.  
All actual file bytes go directly peer-to-peer.

---

## Local Development

```bash
# Run signaling server
cd server/
npm install
npm run dev   # starts on port 3001

# Serve frontend
cd public/
npx serve .   # or just open index.html
```

Update `window.ZAPPIT_SERVER = 'http://localhost:3001'` in the HTML pages.

---

## License

MIT — Build freely, share freely.
