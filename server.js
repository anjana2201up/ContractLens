/* eslint-disable */
'use strict';
require('dotenv').config();

const express      = require('express');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const { v4: uuidv4 } = require('uuid');
const path         = require('path');
const cors         = require('cors');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT           = process.env.PORT        || 3000;
const JWT_SECRET     = process.env.JWT_SECRET  || 'contractlens-super-secret-key-2024-change-in-prod';
const GLOBAL_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GLOBAL_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-5';
const MONGODB_URI    = process.env.MONGODB_URI || '';

// ─── Helpers ──────────────────────────────────────────────────
function getEffectiveKey(user)   { return (user?.apiKey) || GLOBAL_API_KEY || null; }
function getEffectiveModel(user) { return (user?.model)  || GLOBAL_MODEL; }
function hasGlobalKey() { return !!GLOBAL_API_KEY && !GLOBAL_API_KEY.includes('paste-your-key'); }

// ─── MongoDB connection ───────────────────────────────────────
let _db = null;

async function getDB() {
  if (_db) return _db;
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not set. Add it to your .env file.');
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  _db = client.db('contractlens');
  console.log('  ✅  MongoDB connected');
  return _db;
}

// ─── DB helpers ───────────────────────────────────────────────
async function getUserById(id) {
  const db = await getDB();
  return db.collection('users').findOne({ id });
}
async function getUserByEmail(email) {
  const db = await getDB();
  return db.collection('users').findOne({ email: email.toLowerCase() });
}
async function saveUser(user) {
  const db = await getDB();
  await db.collection('users').replaceOne({ id: user.id }, user, { upsert: true });
}
async function getContractById(id) {
  const db = await getDB();
  return db.collection('contracts').findOne({ id });
}
async function getUserContracts(userId) {
  const db = await getDB();
  return db.collection('contracts')
    .find({ userId })
    .sort({ uploadedAt: -1 })
    .toArray();
}
async function saveContract(contract) {
  const db = await getDB();
  await db.collection('contracts').replaceOne({ id: contract.id }, contract, { upsert: true });
}
async function removeContract(id) {
  const db = await getDB();
  await db.collection('contracts').deleteOne({ id });
}

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// ─── Auth Middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try { req.user = jwt.verify(header.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ─── File Upload ──────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ─── AI Helpers ───────────────────────────────────────────────
async function callClaude(apiKey, model, messages, system, maxTokens) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });
  const params = { model: model || 'claude-sonnet-4-5', max_tokens: maxTokens || 2000, messages };
  if (system) params.system = system;
  const msg = await client.messages.create(params);
  return msg.content[0].text;
}

function parseJSON(raw) {
  let s = raw.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(s); }
  catch { const m = s.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Failed to parse AI response'); }
}

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
  return `You are an expert contract analyst. Compare these two contracts.

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
  "summary":"string",
  "changeCount":number,
  "riskLevel":"High|Medium|Low",
  "majorChanges":[{"category":"string","description":"string","impact":"string","severity":"High|Medium|Low"}],
  "newClauses":["string"],
  "removedClauses":["string"],
  "modifiedTerms":[{"term":"string","before":"string","after":"string","impact":"string"}],
  "recommendation":"string"
}`;
}

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id, name, email: email.toLowerCase(), passwordHash,
      apiKey: '', model: 'claude-sonnet-4-5',
      criticalThreshold: 14, warningThreshold: 45,
      createdAt: new Date().toISOString(),
      avatar: name.charAt(0).toUpperCase(),
    };
    await saveUser(user);

    const token = jwt.sign({ id, email: email.toLowerCase(), name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, name, email: email.toLowerCase(), avatar: user.avatar } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const user = await getUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        avatar: user.avatar || user.name.charAt(0).toUpperCase(),
        hasApiKey: !!(user.apiKey || hasGlobalKey()),
        hasPersonalKey: !!user.apiKey,
        globalKeyActive: hasGlobalKey(),
        model: user.model || GLOBAL_MODEL,
        criticalThreshold: user.criticalThreshold,
        warningThreshold: user.warningThreshold,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/auth/settings', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const { apiKey, model, criticalThreshold, warningThreshold, name } = req.body;
    if (apiKey  !== undefined) user.apiKey = apiKey;
    if (model)                 user.model  = model;
    if (criticalThreshold)     user.criticalThreshold = parseInt(criticalThreshold);
    if (warningThreshold)      user.warningThreshold  = parseInt(warningThreshold);
    if (name)                  { user.name = name; user.avatar = name.charAt(0).toUpperCase(); }
    await saveUser(user);
    res.json({ success: true, hasApiKey: !!(user.apiKey || hasGlobalKey()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// CONTRACT ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/contracts', authMiddleware, async (req, res) => {
  try {
    const contracts = await getUserContracts(req.user.id);
    res.json(contracts.map(({ text, _id, ...rest }) => rest));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contracts/:id', authMiddleware, async (req, res) => {
  try {
    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
    const { _id, ...safe } = c;
    res.json(safe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contracts', authMiddleware, async (req, res) => {
  try {
    const { name, type, notes, text, fileName } = req.body;
    if (!name || !text) return res.status(400).json({ error: 'Name and text are required.' });
    const id = uuidv4();
    const contract = {
      id, userId: req.user.id,
      name, type: type || 'other', notes: notes || '',
      text, fileName: fileName || 'document',
      uploadedAt: new Date().toISOString(),
      analysis: null,
    };
    await saveContract(contract);
    const { text: _, _id, ...safe } = contract;
    res.json(safe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/contracts/:id', authMiddleware, async (req, res) => {
  try {
    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
    const { id: _id2, userId: _uid, _id, ...updates } = req.body;
    Object.assign(c, updates);
    await saveContract(c);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contracts/:id', authMiddleware, async (req, res) => {
  try {
    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
    await removeContract(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contracts/:id/analyze', authMiddleware, async (req, res) => {
  try {
    const user   = await getUserById(req.user.id);
    const apiKey = getEffectiveKey(user);
    if (!apiKey) return res.status(400).json({ error: 'No API key configured. Add ANTHROPIC_API_KEY to your environment variables.' });

    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });

    const raw      = await callClaude(apiKey, getEffectiveModel(user), [{ role: 'user', content: buildExtractionPrompt(c.text) }], null, 8000);
    const analysis = parseJSON(raw);
    c.analysis = analysis;
    await saveContract(c);
    res.json({ analysis });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message || 'AI analysis failed.' });
  }
});

app.post('/api/contracts/compare', authMiddleware, async (req, res) => {
  try {
    const { contractAId, contractBId } = req.body;
    const user   = await getUserById(req.user.id);
    const apiKey = getEffectiveKey(user);
    if (!apiKey) return res.status(400).json({ error: 'No API key configured.' });

    const cA = await getContractById(contractAId);
    const cB = await getContractById(contractBId);
    if (!cA || cA.userId !== req.user.id) return res.status(404).json({ error: 'Contract A not found.' });
    if (!cB || cB.userId !== req.user.id) return res.status(404).json({ error: 'Contract B not found.' });

    const raw = await callClaude(apiKey, getEffectiveModel(user), [{ role: 'user', content: buildComparisonPrompt(cA.text, cB.text, cA.name, cB.name) }], null, 4000);
    res.json(parseJSON(raw));
  } catch (err) {
    console.error('Compare error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contracts/:id/chat', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    const user   = await getUserById(req.user.id);
    const apiKey = getEffectiveKey(user);
    if (!apiKey) return res.status(400).json({ error: 'No API key configured.' });

    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });

    const summary = JSON.stringify({
      title: c.analysis?.contractTitle, parties: c.analysis?.parties,
      dates: { effective: c.analysis?.effectiveDate, expiration: c.analysis?.expirationDate },
      paymentTerms: c.analysis?.paymentTerms, obligations: c.analysis?.obligations,
      flaggedClauses: c.analysis?.flaggedClauses, keyFacts: c.analysis?.keyFacts,
      renewalTerms: c.analysis?.renewalTerms, termination: c.analysis?.terminationConditions,
    }, null, 2);

    const system = `You are ContractLens AI, an expert contract analyst. Answer questions precisely and cite specific clauses.

CONTRACT ANALYSIS:
${summary}

CONTRACT TEXT:
---
${c.text ? c.text.slice(0, 15000) : ''}
---`;

    const raw = await callClaude(apiKey, getEffectiveModel(user), messages, system, 2000);
    res.json({ response: raw });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload & Parse ───────────────────────────────────────────
app.post('/api/upload/parse', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  try {
    let text = '';
    if (ext === 'txt')       { text = req.file.buffer.toString('utf8'); }
    else if (ext === 'pdf')  { const d = await require('pdf-parse')(req.file.buffer); text = d.text; }
    else if (ext === 'docx') { const r = await require('mammoth').extractRawText({ buffer: req.file.buffer }); text = r.value; }
    else return res.status(400).json({ error: `Unsupported file type: .${ext}` });
    if (!text || text.trim().length < 20) return res.status(400).json({ error: 'Could not extract text from file.' });
    res.json({ text: text.trim(), charCount: text.trim().length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse file: ' + err.message });
  }
});

// ─── Export / Import ──────────────────────────────────────────
app.get('/api/export', authMiddleware, async (req, res) => {
  try {
    const contracts = await getUserContracts(req.user.id);
    res.json({ exportedAt: new Date().toISOString(), version: '2.0', contracts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/import', authMiddleware, async (req, res) => {
  try {
    const { contracts: incoming } = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Invalid import format.' });
    let imported = 0;
    for (const c of incoming) {
      if (!c.name) continue;
      const newC = { ...c, id: uuidv4(), userId: req.user.id, importedAt: new Date().toISOString() };
      delete newC._id;
      await saveContract(newC);
      imported++;
    }
    res.json({ imported });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SPA fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'login.html'));
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⚖️  ContractLens v2`);
  console.log(`  ──────────────────────────────`);
  console.log(`  🚀  Running on  http://localhost:${PORT}`);
  console.log(`  🔑  Login:      http://localhost:${PORT}/login.html`);
  if (hasGlobalKey()) {
    console.log(`  ✅  Global API key: ACTIVE`);
  } else {
    console.log(`  ⚠️   No global API key — set ANTHROPIC_API_KEY in .env`);
  }
  if (MONGODB_URI) {
    console.log(`  🗄️   MongoDB: configured`);
  } else {
    console.log(`  ⚠️   No MONGODB_URI — set it in .env`);
  }
  console.log(`  ──────────────────────────────\n`);
});

module.exports = app;
