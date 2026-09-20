# ⚖️ ContractLens — AI Contract Intelligence

> **AI-powered contract review, obligation tracking, and deadline management for business teams.**

Built with Node.js · Express · Claude AI · Vanilla JS · Glassmorphism UI

---

## ✨ Features

| Feature | Detail |
|---|---|
| 🔐 **Auth** | Register / Login with JWT sessions |
| 🤖 **AI Extraction** | Parties, dates, obligations, payment terms, governing law |
| 🚩 **Risk Flagging** | Auto-detect indemnification, auto-renewals, liability caps, IP clauses |
| 📅 **Deadline Tracking** | Never miss a renewal, payment, or termination notice |
| 💬 **AI Chat** | Ask anything about a contract in plain English |
| 🔄 **Version Compare** | AI-powered diff between two contract versions |
| ✅ **Obligation Tracker** | Cross-contract obligation management with status toggling |
| 🔔 **Alerts** | Urgency-sorted deadline alerts with configurable windows |
| 📤 **Export / Import** | Full data backup as JSON |

---

## 🚀 Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/jashanbhyan/contractlens.git
cd contractlens
npm install
```

### 2. Configure API Key
```bash
cp .env.example .env
```
Open `.env` and set your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```
Get a key at → [console.anthropic.com](https://console.anthropic.com)

### 3. Run
```bash
node server.js
```

Open → **http://localhost:3000/login.html**

---

## 🗂️ Project Structure

```
contractlens/
├── server.js          # Express backend — auth, AI, contracts API
├── package.json       # Node dependencies
├── .env.example       # Environment variable template
├── login.html         # Beautiful login/register page
├── index.html         # Main application shell
├── styles.css         # Full design system (dark glassmorphism)
├── app.js             # Frontend logic — views, router, API client
└── db/                # Auto-created — JSON database files
    ├── users.json
    └── contracts.json
```

---

## 🔧 Tech Stack

**Backend**
- Node.js + Express
- bcryptjs (password hashing)
- jsonwebtoken (JWT auth)
- @anthropic-ai/sdk (Claude AI)
- multer (file uploads)
- pdf-parse + mammoth (PDF/DOCX parsing)

**Frontend**
- Vanilla HTML / CSS / JavaScript (no framework)
- Inter + JetBrains Mono fonts
- Glassmorphism design system
- PDF.js + Mammoth.js (client-side CDN fallback)

---

## 📡 API Endpoints

```
POST   /api/auth/register          Register a new user
POST   /api/auth/login             Login, returns JWT
GET    /api/auth/me                Get current user
PUT    /api/auth/settings          Update API key / model / thresholds

GET    /api/contracts              List all user contracts
POST   /api/contracts              Create contract
GET    /api/contracts/:id          Get single contract
PUT    /api/contracts/:id          Update contract
DELETE /api/contracts/:id          Delete contract
POST   /api/contracts/:id/analyze  AI analysis with Claude
POST   /api/contracts/compare      Compare two contracts
POST   /api/contracts/:id/chat     AI chat about contract

POST   /api/upload/parse           Upload file → extract text
GET    /api/export                 Export all data as JSON
POST   /api/import                 Import from JSON backup
```

---

## 🌐 Supported File Formats

- **PDF** — via pdf-parse
- **DOCX** — via mammoth
- **TXT** — plain text

Max file size: **15 MB**

---

## 🔒 Security Notes

- Passwords hashed with bcrypt (12 rounds)
- JWT tokens expire after 30 days
- API keys stored per-user in server-side JSON DB
- `.env` file is gitignored — never committed
- Always change `JWT_SECRET` in production

---

## 📄 License

MIT — feel free to use, modify, and distribute.

---

Made with ❤️ using [Claude AI](https://anthropic.com)
