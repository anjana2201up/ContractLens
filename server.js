/* eslint-disable */
'use strict';
require('dotenv').config();

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs       = require('fs');
const path     = require('path');
const cors     = require('cors');

const app  = express();
const PORT           = process.env.PORT        || 3000;
const JWT_SECRET     = process.env.JWT_SECRET  || 'contractlens-super-secret-key-2024-change-in-prod';
const GLOBAL_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GLOBAL_MODEL   = process.env.ANTHROPIC_MODEL  || 'claude-sonnet-4-5';

// ─── Resolve effective API key & model for a user ─────────
function getEffectiveKey(user) {
  return (user?.apiKey) || GLOBAL_API_KEY || null;
}
function getEffectiveModel(user) {
  return (user?.model) || GLOBAL_MODEL;
}
function hasGlobalKey() { return !!GLOBAL_API_KEY && !GLOBAL_API_KEY.includes('paste-your-key'); }

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));        // serve frontend

// ─── File-based JSON Database ─────────────────────────────────
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

function readDB(name) {
  const file = path.join(DB_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeDB(name, data) {
  fs.writeFileSync(path.join(DB_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

// ─── Auth Middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── File Upload (memory) ─────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },  // 15 MB
});

// ─── AI Prompt Builders ───────────────────────────────────────
function buildExtractionPrompt(contractText) {
  const truncated = contractText.length > 40000
    ? contractText.slice(0, 40000) + '\n\n[Document truncated for analysis]'
    : contractText;

  return `You are an expert legal analyst. Analyze the following business contract and extract all key information.

Return ONLY a valid JSON object (no markdown, no explanation) with exactly this structure:

{
  "contractTitle": "string",
  "contractType": "string",
  "parties": [{"name":"string","role":"string","description":"string"}],
  "effectiveDate": "YYYY-MM-DD or null",
  "expirationDate": "YYYY-MM-DD or null",
  "renewalTerms": "string or Not specified",
  "paymentTerms": {
    "amount":"string or null","frequency":"string","dueDate":"string",
    "lateFee":"string or null","currency":"string","summary":"string"
  },
  "terminationConditions": [{"condition":"string","noticePeriod":"string or null","type":"string"}],
  "serviceObligations": [{"party":"string","obligation":"string","details":"string"}],
  "obligations": [
    {
      "id":"ob_1","party":"string","obligation":"string",
      "deadline":"YYYY-MM-DD or null","deadlineDescription":"string",
      "type":"Payment|Reporting|Delivery|Compliance|Notice|Review|Other",
      "frequency":"One-time|Monthly|Quarterly|Annually|Ongoing or null",
      "status":"pending","sourceClause":"string","critical":true
    }
  ],
  "flaggedClauses": [
    {
      "id":"flag_1","title":"string","text":"string",
      "risk":"High|Medium|Low",
      "type":"Indemnification|Auto-Renewal|Liability Cap|Non-Compete|Liquidated Damages|Unilateral Amendment|Force Majeure|IP Assignment|Exclusivity|Other",
      "reason":"string","recommendation":"string"
    }
  ],
  "keyFacts": {
    "totalValue":"string or null","jurisdiction":"string or null",
    "governingLaw":"string or null","disputeResolution":"string or null",
    "confidentialityTerm":"string or null",
    "exclusivityClause":true,"ipAssignment":true,
    "limitationOfLiability":"string or null"
  },
  "executiveSummary":"string",
  "keyRisks":["string"],
  "keyBenefits":["string"],
  "actionItems":["string"],
  "sourceReferences":[{"insight":"string","clause":"string"}]
}

CONTRACT TEXT:
---
${truncated}
---

Return only the JSON. Be thorough. Use null or empty arrays when not found.`;
}

function buildComparisonPrompt(textA, textB, nameA, nameB) {
  const tA = textA.length > 20000 ? textA.slice(0, 20000) + '\n[truncated]' : textA;
  const tB = textB.length > 20000 ? textB.slice(0, 20000) + '\n[truncated]' : textB;
  return `You are an expert contract analyst. Compare these two contract versions.

CONTRACT A (${nameA}):
---
${tA}
---

CONTRACT B (${nameB}):
---
${tB}
---

Return ONLY valid JSON:
{
  "summary":"string - 2-3 paragraph business-friendly summary",
  "changeCount":number,
  "riskLevel":"High|Medium|Low",
  "majorChanges":[{"category":"string","description":"string","impact":"string","severity":"High|Medium|Low"}],
  "newClauses":["string"],
  "removedClauses":["string"],
  "modifiedTerms":[{"term":"string","before":"string","after":"string","impact":"string"}],
  "recommendation":"string"
}`;
}

// ─── Helper ───────────────────────────────────────────────────
async function callClaude(apiKey, model, messages, system, maxTokens) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });

  const params = {
    model: model || 'claude-sonnet-4-5',
    max_tokens: maxTokens || 2000,
    messages,
  };
  if (system) params.system = system;

  const msg = await client.messages.create(params);
  return msg.content[0].text;
}

function parseJSON(raw) {
  let s = raw.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Failed to parse AI response as JSON');
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const users = readDB('users');
    if (Object.values(users).find(u => u.email.toLowerCase() === email.toLowerCase())) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    users[id] = {
      id, name, email: email.toLowerCase(), passwordHash,
      apiKey: '', model: 'claude-sonnet-4-5',
      criticalThreshold: 14, warningThreshold: 45,
      createdAt: new Date().toISOString(),
      avatar: name.charAt(0).toUpperCase(),
    };
    writeDB('users', users);

    const token = jwt.sign({ id, email: email.toLowerCase(), name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, name, email: email.toLowerCase(), avatar: users[id].avatar } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const users = readDB('users');
    const user = Object.values(users).find(u => u.email === email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        avatar: user.avatar || user.name.charAt(0).toUpperCase(),
        hasApiKey: !!user.apiKey, model: user.model,
        criticalThreshold: user.criticalThreshold,
        warningThreshold: user.warningThreshold,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const users = readDB('users');
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({
    id: user.id, name: user.name, email: user.email,
    avatar: user.avatar || user.name.charAt(0).toUpperCase(),
    hasApiKey: !!(user.apiKey || hasGlobalKey()),
    hasPersonalKey: !!user.apiKey,
    globalKeyActive: hasGlobalKey(),
    model: user.model || GLOBAL_MODEL,
    criticalThreshold: user.criticalThreshold,
    warningThreshold: user.warningThreshold,
  });
});

// Update settings
app.put('/api/auth/settings', authMiddleware, (req, res) => {
  const users = readDB('users');
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { apiKey, model, criticalThreshold, warningThreshold, name } = req.body;
  if (apiKey  !== undefined) user.apiKey   = apiKey;
  if (model)                 user.model    = model;
  if (criticalThreshold)     user.criticalThreshold = parseInt(criticalThreshold);
  if (warningThreshold)      user.warningThreshold  = parseInt(warningThreshold);
  if (name)                  { user.name = name; user.avatar = name.charAt(0).toUpperCase(); }

  writeDB('users', users);
  res.json({ success: true, hasApiKey: !!user.apiKey });
});

// ═══════════════════════════════════════════════════════════════
// CONTRACT ROUTES
// ═══════════════════════════════════════════════════════════════

// List contracts (no full text in list)
app.get('/api/contracts', authMiddleware, (req, res) => {
  const contracts = readDB('contracts');
  const result = Object.values(contracts)
    .filter(c => c.userId === req.user.id)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .map(({ text, ...rest }) => rest);   // strip full text from list
  res.json(result);
});

// Get single contract (with full text)
app.get('/api/contracts/:id', authMiddleware, (req, res) => {
  const contracts = readDB('contracts');
  const c = contracts[req.params.id];
  if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
  res.json(c);
});

// Create contract
app.post('/api/contracts', authMiddleware, (req, res) => {
  const { name, type, notes, text, fileName } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'Name and text are required.' });

  const contracts = readDB('contracts');
  const id = uuidv4();
  contracts[id] = {
    id, userId: req.user.id,
    name, type: type || 'other', notes: notes || '',
    text, fileName: fileName || 'document',
    uploadedAt: new Date().toISOString(),
    analysis: null,
  };
  writeDB('contracts', contracts);
  const { text: _, ...safe } = contracts[id];
  res.json(safe);
});

// Update contract (e.g. obligation status)
app.put('/api/contracts/:id', authMiddleware, (req, res) => {
  const contracts = readDB('contracts');
  const c = contracts[req.params.id];
  if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });

  // Merge — protect immutable fields
  const { id, userId, text: _t, ...updates } = req.body;
  Object.assign(c, updates);
  contracts[req.params.id] = c;
  writeDB('contracts', contracts);
  res.json({ success: true });
});

// Delete contract
app.delete('/api/contracts/:id', authMiddleware, (req, res) => {
  const contracts = readDB('contracts');
  const c = contracts[req.params.id];
  if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
  delete contracts[req.params.id];
  writeDB('contracts', contracts);
  res.json({ success: true });
});

// Analyze contract with Claude AI
app.post('/api/contracts/:id/analyze', authMiddleware, async (req, res) => {
  const users = readDB('users');
  const user  = users[req.user.id];
  const apiKey = getEffectiveKey(user);
  if (!apiKey) return res.status(400).json({ error: 'No API key configured. Add ANTHROPIC_API_KEY to your .env file or set one in Settings.' });

  const contracts = readDB('contracts');
  const c = contracts[req.params.id];
  if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });

  try {
    const raw = await callClaude(
      apiKey, getEffectiveModel(user),
      [{ role: 'user', content: buildExtractionPrompt(c.text) }],
      null, 8000,
    );
    const analysis = parseJSON(raw);
    c.analysis = analysis;
    contracts[req.params.id] = c;
    writeDB('contracts', contracts);
    res.json({ analysis });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message || 'AI analysis failed. Check your API key.' });
  }
});

// Compare two contracts
app.post('/api/contracts/compare', authMiddleware, async (req, res) => {
  const { contractAId, contractBId } = req.body;
  const users = readDB('users');
  const user  = users[req.user.id];
  const apiKey = getEffectiveKey(user);
  if (!apiKey) return res.status(400).json({ error: 'No API key configured. Add ANTHROPIC_API_KEY to your .env file.' });

  const contracts = readDB('contracts');
  const cA = contracts[contractAId];
  const cB = contracts[contractBId];
  if (!cA || cA.userId !== req.user.id) return res.status(404).json({ error: 'Contract A not found.' });
  if (!cB || cB.userId !== req.user.id) return res.status(404).json({ error: 'Contract B not found.' });

  try {
    const raw = await callClaude(
      apiKey, getEffectiveModel(user),
      [{ role: 'user', content: buildComparisonPrompt(cA.text, cB.text, cA.name, cB.name) }],
      null, 4000,
    );
    res.json(parseJSON(raw));
  } catch (err) {
    console.error('Compare error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// AI Chat about a contract
app.post('/api/contracts/:id/chat', authMiddleware, async (req, res) => {
  const { messages } = req.body;
  const users = readDB('users');
  const user  = users[req.user.id];
  const apiKey = getEffectiveKey(user);
  if (!apiKey) return res.status(400).json({ error: 'No API key configured.' });

  const contracts = readDB('contracts');
  const c = contracts[req.params.id];
  if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });

  const summary = JSON.stringify({
    title:       c.analysis?.contractTitle,
    parties:     c.analysis?.parties,
    dates:       { effective: c.analysis?.effectiveDate, expiration: c.analysis?.expirationDate },
    paymentTerms: c.analysis?.paymentTerms,
    obligations: c.analysis?.obligations,
    flaggedClauses: c.analysis?.flaggedClauses,
    keyFacts:    c.analysis?.keyFacts,
    renewalTerms: c.analysis?.renewalTerms,
    termination:  c.analysis?.terminationConditions,
  }, null, 2);

  const contractText = c.text ? c.text.slice(0, 15000) : '';

  const system = `You are ContractLens AI, an expert contract analyst. Answer questions about the contract precisely and cite specific clauses.
Always recommend legal review for critical decisions. Format responses with clear structure.

CONTRACT ANALYSIS (structured data):
${summary}

CONTRACT TEXT (source):
---
${contractText}
---`;

  try {
    const raw = await callClaude(apiKey, getEffectiveModel(user), messages, system, 2000);
    res.json({ response: raw });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD & PARSE
// ═══════════════════════════════════════════════════════════════

app.post('/api/upload/parse', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const ext = req.file.originalname.split('.').pop().toLowerCase();

  try {
    let text = '';

    if (ext === 'txt') {
      text = req.file.buffer.toString('utf8');

    } else if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      text = data.text;

    } else if (ext === 'docx') {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;

    } else {
      return res.status(400).json({ error: `Unsupported file type: .${ext}. Please use PDF, DOCX, or TXT.` });
    }

    if (!text || text.trim().length < 20) {
      return res.status(400).json({ error: 'Could not extract meaningful text from this file.' });
    }

    res.json({ text: text.trim(), charCount: text.trim().length });
  } catch (err) {
    console.error('Parse error:', err.message);
    res.status(500).json({ error: 'Failed to parse file: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// DATA EXPORT / IMPORT
// ═══════════════════════════════════════════════════════════════

app.get('/api/export', authMiddleware, (req, res) => {
  const contracts = readDB('contracts');
  const userContracts = Object.values(contracts).filter(c => c.userId === req.user.id);
  res.json({
    exportedAt: new Date().toISOString(),
    version: '2.0',
    contracts: userContracts,
  });
});

app.post('/api/import', authMiddleware, (req, res) => {
  const { contracts: incoming } = req.body;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Invalid import format.' });

  const contracts = readDB('contracts');
  let imported = 0;
  incoming.forEach(c => {
    if (!c.id || !c.name) return;
    const newId = uuidv4();
    contracts[newId] = { ...c, id: newId, userId: req.user.id, importedAt: new Date().toISOString() };
    imported++;
  });
  writeDB('contracts', contracts);
  res.json({ imported });
});

// ─── SPA Fallback: serve login.html for unknown routes ────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'login.html'));
});

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⚖️  ContractLens v2`);
  console.log(`  ──────────────────────────────`);
  console.log(`  🚀  Running on  http://localhost:${PORT}`);
  console.log(`  🔑  Login:      http://localhost:${PORT}/login.html`);
  if (hasGlobalKey()) {
    console.log(`  ✅  Global API key: ACTIVE (all users can analyze contracts)`);
  } else {
    console.log(`  ⚠️   No global API key — edit .env and set ANTHROPIC_API_KEY`);
    console.log(`  📖  Get your key at: https://console.anthropic.com`);
  }
  console.log(`  ──────────────────────────────\n`);
});
