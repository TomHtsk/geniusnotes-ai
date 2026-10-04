// Notepad "Create picture": the AI never draws. It returns structured data in one of a few
// fixed shapes; the browser (js/diagram-templates.js) draws the diagram from fixed
// templates. This file holds the prompt and the strict validation of the AI's JSON.
// Called from api/writing.js (action: 'diagram').

const MAX_NOTE_CHARS = 6000;
const LIMITS = {
  title: 80, subtitle: 100, formula: 24, name: 40, condition: 40, location: 60,
  label: 40, detail: 120, heading: 40, point: 120,
  substancesPerSide: 4, steps: 8, minSteps: 2, columns: 4, minColumns: 2, points: 6, count: 99,
};
const NOTHING_DRAWABLE = 'Nothing in this note looks drawable yet. Select an equation or a process and try again.';
const DIAGRAM_FAILED = "We couldn't make a diagram from this note just now. Please try again.";

function buildDiagramMessages(noteText) {
  const system = `You turn a student's note into DATA for one diagram. You never draw and never write SVG. Reply with ONE JSON object and nothing else.

Find the single most important drawable thing in the note. Prefer, in this order: an equation, a process, a cycle, a comparison.

Allowed shapes (use exactly these keys):
1. Chemical equation that the note writes with chemical formulas:
{"kind":"equation","title":"","subtitle":"","reactants":[{"count":1,"formula":"","name":""}],"products":[{"count":1,"formula":"","name":""}],"condition":"","location":""}
- count: the whole number written in front of the formula in the note (1 if none).
- formula: exactly as written in the note, plain characters like CO2 or C6H12O6. No spaces.
- name: the plain name of the substance ONLY if the note gives it; otherwise "".
- condition: what the note says drives the reaction (for example light, heat, an enzyme); otherwise "".
- location: where the note says it happens; otherwise "".
- At most ${LIMITS.substancesPerSide} reactants and ${LIMITS.substancesPerSide} products.
2. Steps that happen in order and then stop:
{"kind":"process","title":"","steps":[{"label":"","detail":""}]}
3. Steps that repeat in a loop:
{"kind":"cycle","title":"","steps":[{"label":"","detail":""}]}
- process and cycle: ${LIMITS.minSteps} to ${LIMITS.steps} steps, in the note's order. label is a few words; detail is one short phrase or "".
4. Two to four things compared side by side:
{"kind":"comparison","title":"","columns":[{"heading":"","points":[""]}]}
- ${LIMITS.minColumns} to ${LIMITS.columns} columns, 1 to ${LIMITS.points} short points each.
5. Nothing drawable:
{"kind":"none"}

STRICT RULES
- Copy all wording from the note exactly. Do not add facts, numbers, names, steps or substances that the note does not contain. Do not correct the note, even if you think it is wrong (for example do not balance an equation).
- title: a short title taken from the note's own words. subtitle may be "".
- Keep every text short: titles under ${LIMITS.title} characters, labels and headings under ${LIMITS.label}, details and points under ${LIMITS.detail}.
- If the note has no equation written with formulas, no ordered steps, no loop and nothing to compare, reply {"kind":"none"}.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: 'NOTE:\n' + String(noteText).slice(0, MAX_NOTE_CHARS) },
  ];
}

function _str(v, max, required) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (required && !s) return null;
  if (s.length > max) return null;
  return s;
}

// Formulas are compared with the note ignoring spaces and Unicode sub/superscripts, so
// "CO₂" in the note matches "CO2" from the AI.
function _normalizeChem(s) {
  const sub = '₀₁₂₃₄₅₆₇₈₉', sup = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  return String(s).replace(/[₀-₉]/g, c => sub.indexOf(c)).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c => sup.indexOf(c))
    .replace(/[⁺]/g, '+').replace(/[⁻−–]/g, '-').replace(/\s+/g, '');
}

function _substances(list, noteChem) {
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.substancesPerSide) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    let count = item.count === undefined || item.count === null || item.count === '' ? 1 : Number(item.count);
    if (!Number.isInteger(count) || count < 1 || count > LIMITS.count) return null;
    const formula = _str(item.formula, LIMITS.formula, true);
    if (!formula || !/^[A-Za-z0-9()\[\]+\-·.]+$/.test(_normalizeChem(formula)) || !/[A-Za-z]/.test(formula)) return null;
    // The formula must really be in the note — the AI may not introduce substances.
    if (!noteChem.includes(_normalizeChem(formula))) return null;
    const name = _str(item.name, LIMITS.name, false);
    if (name === null) return null;
    out.push({ count, formula: _normalizeChem(formula), name });
  }
  return out;
}

function _steps(list) {
  if (!Array.isArray(list) || list.length < LIMITS.minSteps || list.length > LIMITS.steps) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const label = _str(item.label, LIMITS.label, true), detail = _str(item.detail, LIMITS.detail, false);
    if (label === null || detail === null) return null;
    out.push({ label, detail });
  }
  return out;
}

// Returns a clean diagram object containing ONLY the allowed fields, or null if the AI's
// reply does not fit one of the shapes exactly.
function validateDiagram(raw, noteText) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = raw.kind;
  if (kind === 'none') return { kind: 'none' };
  const title = _str(raw.title, LIMITS.title, true);
  if (title === null) return null;

  if (kind === 'equation') {
    const noteChem = _normalizeChem(noteText || '');
    const reactants = _substances(raw.reactants, noteChem), products = _substances(raw.products, noteChem);
    const subtitle = _str(raw.subtitle, LIMITS.subtitle, false);
    const condition = _str(raw.condition, LIMITS.condition, false), location = _str(raw.location, LIMITS.location, false);
    if (!reactants || !products || subtitle === null || condition === null || location === null) return null;
    return { kind, title, subtitle, reactants, products, condition, location };
  }
  if (kind === 'process' || kind === 'cycle') {
    const steps = _steps(raw.steps);
    if (!steps) return null;
    return { kind, title, steps };
  }
  if (kind === 'comparison') {
    if (!Array.isArray(raw.columns) || raw.columns.length < LIMITS.minColumns || raw.columns.length > LIMITS.columns) return null;
    const columns = [];
    for (const col of raw.columns) {
      if (!col || typeof col !== 'object') return null;
      const heading = _str(col.heading, LIMITS.heading, true);
      if (heading === null || !Array.isArray(col.points) || col.points.length < 1 || col.points.length > LIMITS.points) return null;
      const points = [];
      for (const p of col.points) { const s = _str(p, LIMITS.point, true); if (s === null) return null; points.push(s); }
      columns.push({ heading, points });
    }
    return { kind, title, columns };
  }
  return null;
}

// Pulls the JSON object out of the model's reply (tolerates code fences / stray text).
function parseDiagramReply(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
}

module.exports = { buildDiagramMessages, validateDiagram, parseDiagramReply, MAX_NOTE_CHARS, NOTHING_DRAWABLE, DIAGRAM_FAILED, LIMITS };
