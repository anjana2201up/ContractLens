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

const app  = express();
const PORT           = process.env.PORT        || 3000;
const JWT_SECRET     = process.env.JWT_SECRET  || 'contractlens-super-secret-key-2024';
const GLOBAL_API_KEY = process.env.GEMINI_API_KEY || '';
const GLOBAL_MODEL   = process.env.GEMINI_MODEL   || 'gemini-1.5-flash';
const MONGODB_URI    = process.env.MONGODB_URI    || '';

// ─── Helpers ──────────────────────────────────────────────────
function getEffectiveKey(user)   { return (user?.apiKey) || GLOBAL_API_KEY || null; }
function getEffectiveModel(user) { return (user?.model)  || GLOBAL_MODEL; }
function hasGlobalKey() { return !!GLOBAL_API_KEY && !GLOBAL_API_KEY.includes('paste-your-key'); }

const { MongoClient } = require('mongodb');
let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not set in environment variables');
  const client = await MongoClient.connect(MONGODB_URI);
  cachedDb = client.db('contractlens');
  return cachedDb;
}

// ─── DB Helpers ───────────────────────────────────────────────
async function getUserById(id) {
  const db = await getDb();
  return await db.collection('users').findOne({ id });
}
async function getUserByEmail(email) {
  const db = await getDb();
  return await db.collection('users').findOne({ email: email.toLowerCase() });
}
async function saveUser(user) {
  const db = await getDb();
  await db.collection('users').updateOne({ id: user.id }, { $set: user }, { upsert: true });
}
async function getContractById(id) {
  const db = await getDb();
  return await db.collection('contracts').findOne({ id });
}
async function getUserContracts(userId) {
  const db = await getDb();
  return await db.collection('contracts').find({ userId }).sort({ uploadedAt: -1 }).toArray();
}
async function saveContract(contract) {
  const db = await getDb();
  await db.collection('contracts').updateOne({ id: contract.id }, { $set: contract }, { upsert: true });
}
async function removeContract(id) {
  const db = await getDb();
  await db.collection('contracts').deleteOne({ id });
}

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try { req.user = jwt.verify(header.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ─── AI Helpers ───────────────────────────────────────────────
async function callAI(apiKey, model, messages, system, maxTokens) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const aiModel = genAI.getGenerativeModel({ 
    model: model || 'gemini-1.5-flash',
    systemInstruction: system
  });
  
  const history = messages.slice(0, -1).map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));
  const lastMessage = messages[messages.length - 1].content;
  
  const chat = aiModel.startChat({ history });
  const result = await chat.sendMessage(lastMessage);
  return result.response.text();
}

function parseJSON(raw) {
  let s = raw.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(s); }
  catch { const m = s.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Failed to parse AI response'); }
}

function buildExtractionPrompt(contractText) {
  const t = contractText.length > 40000 ? contractText.slice(0, 40000) + '\n[truncated]' : contractText;
  return `You are an expert legal analyst. Analyze this business contract and extract all key information.

Return ONLY a valid JSON object with this structure:
{
  "contractTitle":"string","contractType":"string",
  "parties":[{"name":"string","role":"string","description":"string"}],
  "effectiveDate":"YYYY-MM-DD or null","expirationDate":"YYYY-MM-DD or null",
  "renewalTerms":"string","paymentTerms":{"amount":"string","frequency":"string","dueDate":"string","lateFee":"string","currency":"string","summary":"string"},
  "terminationConditions":[{"condition":"string","noticePeriod":"string","type":"string"}],
  "serviceObligations":[{"party":"string","obligation":"string","details":"string"}],
  "obligations":[{"id":"ob_1","party":"string","obligation":"string","deadline":"YYYY-MM-DD or null","deadlineDescription":"string","type":"Payment|Reporting|Delivery|Compliance|Notice|Review|Other","frequency":"string","status":"pending","sourceClause":"string","critical":true}],
  "flaggedClauses":[{"id":"flag_1","title":"string","text":"string","risk":"High|Medium|Low","type":"string","reason":"string","recommendation":"string"}],
  "keyFacts":{"totalValue":"string","jurisdiction":"string","governingLaw":"string","disputeResolution":"string","confidentialityTerm":"string","exclusivityClause":true,"ipAssignment":true,"limitationOfLiability":"string"},
  "executiveSummary":"string","keyRisks":["string"],"keyBenefits":["string"],"actionItems":["string"],
  "sourceReferences":[{"insight":"string","clause":"string"}]
}

CONTRACT:
---
${t}
---
Return only the JSON. Be thorough.`;
}

function buildComparisonPrompt(textA, textB, nameA, nameB) {
  return `Compare these two contracts and return ONLY valid JSON:
{
  "summary":"string","changeCount":0,"riskLevel":"High|Medium|Low",
  "majorChanges":[{"category":"string","description":"string","impact":"string","severity":"High|Medium|Low"}],
  "newClauses":["string"],"removedClauses":["string"],
  "modifiedTerms":[{"term":"string","before":"string","after":"string","impact":"string"}],
  "recommendation":"string"
}

CONTRACT A (${nameA}):
---
${textA.slice(0, 18000)}
---
CONTRACT B (${nameB}):
---
${textB.slice(0, 18000)}
---`;
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
    const user = { id, name, email: email.toLowerCase(), passwordHash, apiKey: '', model: 'gemini-1.5-flash', criticalThreshold: 14, warningThreshold: 45, createdAt: new Date().toISOString(), avatar: name.charAt(0).toUpperCase() };
    await saveUser(user);
    const token = jwt.sign({ id, email: email.toLowerCase(), name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, name, email: email.toLowerCase(), avatar: user.avatar } });
  } catch (err) { console.error('Register:', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const user = await getUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password.' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar || user.name.charAt(0).toUpperCase(), hasApiKey: !!(user.apiKey || hasGlobalKey()), hasPersonalKey: !!user.apiKey, globalKeyActive: hasGlobalKey(), model: user.model || GLOBAL_MODEL, criticalThreshold: user.criticalThreshold, warningThreshold: user.warningThreshold } });
  } catch (err) { console.error('Login:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ id: user.id, name: user.name, email: user.email, avatar: user.avatar || user.name.charAt(0).toUpperCase(), hasApiKey: !!(user.apiKey || hasGlobalKey()), hasPersonalKey: !!user.apiKey, globalKeyActive: hasGlobalKey(), model: user.model || GLOBAL_MODEL, criticalThreshold: user.criticalThreshold, warningThreshold: user.warningThreshold });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/auth/settings', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const { apiKey, model, criticalThreshold, warningThreshold, name } = req.body;
    if (apiKey !== undefined) user.apiKey = apiKey;
    if (model) user.model = model;
    if (criticalThreshold) user.criticalThreshold = parseInt(criticalThreshold);
    if (warningThreshold) user.warningThreshold = parseInt(warningThreshold);
    if (name) { user.name = name; user.avatar = name.charAt(0).toUpperCase(); }
    await saveUser(user);
    res.json({ success: true, hasApiKey: !!(user.apiKey || hasGlobalKey()) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CONTRACT ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/contracts', authMiddleware, async (req, res) => {
  try { res.json((await getUserContracts(req.user.id)).map(({ text, ...r }) => r)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contracts/:id', authMiddleware, async (req, res) => {
  try {
    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contracts', authMiddleware, async (req, res) => {
  try {
    const { name, type, notes, text, fileName } = req.body;
    if (!name || !text) return res.status(400).json({ error: 'Name and text required.' });
    const id = uuidv4();
    const contract = { id, userId: req.user.id, name, type: type || 'other', notes: notes || '', text, fileName: fileName || 'document', uploadedAt: new Date().toISOString(), analysis: null };
    await saveContract(contract);
    const { text: _, ...safe } = contract;
    res.json(safe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/contracts/:id', authMiddleware, async (req, res) => {
  try {
    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
    const { id: _, userId: __, ...updates } = req.body;
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
    const user = await getUserById(req.user.id);
    const apiKey = getEffectiveKey(user);
    if (!apiKey) return res.status(400).json({ error: 'No API key configured. Set GEMINI_API_KEY in environment variables.' });
    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
    const raw = await callAI(apiKey, getEffectiveModel(user), [{ role: 'user', content: buildExtractionPrompt(c.text) }], null, 8000);
    const analysis = parseJSON(raw);
    c.analysis = analysis;
    await saveContract(c);
    res.json({ analysis });
  } catch (err) { console.error('Analyze:', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/contracts/compare', authMiddleware, async (req, res) => {
  try {
    const { contractAId, contractBId } = req.body;
    const user = await getUserById(req.user.id);
    const apiKey = getEffectiveKey(user);
    if (!apiKey) return res.status(400).json({ error: 'No API key configured.' });
    const cA = await getContractById(contractAId);
    const cB = await getContractById(contractBId);
    if (!cA || cA.userId !== req.user.id) return res.status(404).json({ error: 'Contract A not found.' });
    if (!cB || cB.userId !== req.user.id) return res.status(404).json({ error: 'Contract B not found.' });
    const raw = await callAI(apiKey, getEffectiveModel(user), [{ role: 'user', content: buildComparisonPrompt(cA.text, cB.text, cA.name, cB.name) }], null, 4000);
    res.json(parseJSON(raw));
  } catch (err) { console.error('Compare:', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/contracts/:id/chat', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    const user = await getUserById(req.user.id);
    const apiKey = getEffectiveKey(user);
    if (!apiKey) return res.status(400).json({ error: 'No API key configured.' });
    const c = await getContractById(req.params.id);
    if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Contract not found.' });
    const system = `You are ContractLens AI, an expert contract analyst. Answer questions about this contract precisely.

ANALYSIS: ${JSON.stringify({ title: c.analysis?.contractTitle, parties: c.analysis?.parties, dates: { effective: c.analysis?.effectiveDate, expiration: c.analysis?.expirationDate }, paymentTerms: c.analysis?.paymentTerms, obligations: c.analysis?.obligations, flaggedClauses: c.analysis?.flaggedClauses, keyFacts: c.analysis?.keyFacts }, null, 2)}

CONTRACT TEXT:
---
${c.text ? c.text.slice(0, 15000) : ''}
---`;
    const raw = await callAI(apiKey, getEffectiveModel(user), messages, system, 2000);
    res.json({ response: raw });
  } catch (err) { console.error('Chat:', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/upload/parse', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  try {
    let text = '';
    if (ext === 'txt')       text = req.file.buffer.toString('utf8');
    else if (ext === 'pdf')  { const d = await require('pdf-parse')(req.file.buffer); text = d.text; }
    else if (ext === 'docx') { const r = await require('mammoth').extractRawText({ buffer: req.file.buffer }); text = r.value; }
    else return res.status(400).json({ error: `Unsupported: .${ext}` });
    if (!text || text.trim().length < 20) return res.status(400).json({ error: 'Could not extract text.' });
    res.json({ text: text.trim(), charCount: text.trim().length });
  } catch (err) { res.status(500).json({ error: 'Parse failed: ' + err.message }); }
});

app.get('/api/export', authMiddleware, async (req, res) => {
  try { res.json({ exportedAt: new Date().toISOString(), version: '2.0', contracts: await getUserContracts(req.user.id) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/import', authMiddleware, async (req, res) => {
  try {
    const { contracts: incoming } = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Invalid format.' });
    let imported = 0;
    for (const c of incoming) {
      if (!c.name) continue;
      await saveContract({ ...c, id: uuidv4(), userId: req.user.id, importedAt: new Date().toISOString() });
      imported++;
    }
    res.json({ imported });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Health check (useful for Vercel)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: !!MONGODB_URI, apiKey: hasGlobalKey(), ts: new Date().toISOString() });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ⚖️  ContractLens v2`);
  console.log(`  🚀  http://localhost:${PORT}/login.html`);
  console.log(`  ${hasGlobalKey() ? '✅' : '⚠️ '} API Key: ${hasGlobalKey() ? 'ACTIVE' : 'not set'}`);
  console.log(`  ${MONGODB_URI ? '✅' : '⚠️ '} MongoDB: ${MONGODB_URI ? 'configured' : 'not set — add MONGODB_URI'}\n`);
});

module.exports = app;
