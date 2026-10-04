// Diagram templates for the Notepad's "Create picture".
//
// The AI never draws. The server returns structured DATA (see api/_lib/diagram.js) and this
// file builds the SVG from one fixed template per kind: equation, process, cycle,
// comparison. Every label is real text placed by this code, so every diagram has the same
// design (style reference: the photosynthesis equation card layout).
//
//   GNDiagram.render(data)  -> { svg, width, height }
//   GNDiagram.toPng(result) -> Promise<PNG data URL>   (2x, white background)
//   GNDiagram.countAtoms(formula), GNDiagram.balance(data), GNDiagram.formulaParts(formula)
//
// Rules: white background, sans-serif, no font below 14, no external images/fonts/scripts,
// text wraps or shrinks to fit its box and is cut with "…" only as a last resort.
(function (root) {
  'use strict';

  // Arial/Helvetica only: a picture can't load web fonts, and measuring and drawing must
  // use the same font or the fitting below would be wrong.
  var FONT = 'Arial, Helvetica, sans-serif';
  var MIN_FONT = 14;
  var COL = {
    ink: '#0B0F14', sub: '#5B6875', body: '#3A4450', teal: '#0F6E7A',
    cardIn: '#F3F5F7', cardOut: '#E6F4F6', stroke: '#C9D3DB',
    noteFill: '#FFF8E1', noteStroke: '#E8D9A8', white: '#FFFFFF',
    sun: '#F7C948', sunStroke: '#E0A100'
  };

  // ── text helpers ──────────────────────────────────────────────────────────
  var _ctx = null;
  function measure(text, size, weight, spacing) {
    text = String(text);
    if (_ctx === null) {
      try { _ctx = document.createElement('canvas').getContext('2d'); } catch (e) { _ctx = false; }
    }
    var w;
    if (_ctx) { _ctx.font = (weight || 400) + ' ' + size + 'px ' + FONT; w = _ctx.measureText(text).width; }
    else w = text.length * size * ((weight || 400) >= 600 ? 0.6 : 0.55);
    return w * 1.04 + (spacing || 0) * text.length; // 4% safety margin
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function r1(n) { return Math.round(n * 10) / 10; }

  // Greedy word wrap; a single word wider than the box is broken by characters.
  // firstExtra reserves extra width on the first line (used for a bold prefix).
  function wrap(text, size, weight, maxW, firstExtra) {
    var words = String(text).split(/\s+/).filter(Boolean), lines = [], cur = '';
    function room() { return maxW - (lines.length === 0 ? (firstExtra || 0) : 0); }
    words.forEach(function (word) {
      while (measure(word, size, weight) > room() && word.length > 1) {
        if (cur) { lines.push(cur); cur = ''; }
        var cut = word.length - 1;
        while (cut > 1 && measure(word.slice(0, cut), size, weight) > room()) cut--;
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      var next = cur ? cur + ' ' + word : word;
      if (measure(next, size, weight) <= room()) cur = next;
      else { if (cur) lines.push(cur); cur = word; }
    });
    if (cur) lines.push(cur);
    return lines;
  }

  // Wraps at `size`, shrinking one step at a time down to `min` until it fits in maxLines.
  // If it still doesn't fit, the last line is cut with "…".
  function fitLines(text, opt) {
    var size = opt.size, min = Math.max(MIN_FONT, opt.min || MIN_FONT), lines;
    // Shrink before splitting a word in the middle.
    var longest = String(text).split(/\s+/).sort(function (a, b) { return b.length - a.length; })[0] || '';
    while (size > min && measure(longest, size, opt.weight) > opt.maxW) size--;
    for (;;) {
      lines = wrap(text, size, opt.weight, opt.maxW);
      if (lines.length <= opt.maxLines || size <= min) break;
      size--;
    }
    if (lines.length > opt.maxLines) {
      lines = lines.slice(0, opt.maxLines);
      var last = lines[opt.maxLines - 1];
      while (last.length > 1 && measure(last + '…', size, opt.weight) > opt.maxW) last = last.slice(0, -1);
      lines[opt.maxLines - 1] = last.replace(/\s+$/, '') + '…';
    }
    return { size: size, lines: lines };
  }

  function textEl(x, y, str, a) {
    a = a || {};
    return '<text x="' + r1(x) + '" y="' + r1(y) + '" font-size="' + (a.size || 16) + '"' +
      (a.anchor ? ' text-anchor="' + a.anchor + '"' : '') +
      ' fill="' + (a.fill || COL.ink) + '"' +
      (a.weight ? ' font-weight="' + a.weight + '"' : '') +
      (a.spacing ? ' letter-spacing="' + a.spacing + '"' : '') +
      (a.fit ? ' data-fit="' + a.fit.map(r1).join(' ') + '"' : '') + '>' + str + '</text>';
  }

  // ── chemistry: formulas, atom counting, balance ───────────────────────────
  var ELEMENT_NAMES = {};
  ('H:hydrogen,He:helium,Li:lithium,Be:beryllium,B:boron,C:carbon,N:nitrogen,O:oxygen,F:fluorine,Ne:neon,' +
   'Na:sodium,Mg:magnesium,Al:aluminum,Si:silicon,P:phosphorus,S:sulfur,Cl:chlorine,Ar:argon,K:potassium,Ca:calcium,' +
   'Sc:scandium,Ti:titanium,V:vanadium,Cr:chromium,Mn:manganese,Fe:iron,Co:cobalt,Ni:nickel,Cu:copper,Zn:zinc,' +
   'Ga:gallium,Ge:germanium,As:arsenic,Se:selenium,Br:bromine,Kr:krypton,Rb:rubidium,Sr:strontium,Y:yttrium,Zr:zirconium,' +
   'Nb:niobium,Mo:molybdenum,Tc:technetium,Ru:ruthenium,Rh:rhodium,Pd:palladium,Ag:silver,Cd:cadmium,In:indium,Sn:tin,' +
   'Sb:antimony,Te:tellurium,I:iodine,Xe:xenon,Cs:cesium,Ba:barium,La:lanthanum,Ce:cerium,Pr:praseodymium,Nd:neodymium,' +
   'Pm:promethium,Sm:samarium,Eu:europium,Gd:gadolinium,Tb:terbium,Dy:dysprosium,Ho:holmium,Er:erbium,Tm:thulium,Yb:ytterbium,' +
   'Lu:lutetium,Hf:hafnium,Ta:tantalum,W:tungsten,Re:rhenium,Os:osmium,Ir:iridium,Pt:platinum,Au:gold,Hg:mercury,' +
   'Tl:thallium,Pb:lead,Bi:bismuth,Po:polonium,At:astatine,Rn:radon,Fr:francium,Ra:radium,Ac:actinium,Th:thorium,' +
   'Pa:protactinium,U:uranium,Np:neptunium,Pu:plutonium').split(',').forEach(function (p) {
    var kv = p.split(':'); ELEMENT_NAMES[kv[0]] = kv[1];
  });

  // Short names that look like formulas but are not (ATP would otherwise read as At + P).
  var ABBREVIATIONS = ['ATP', 'ADP', 'AMP', 'NADPH', 'NADP', 'NADP+', 'NADH', 'NAD', 'NAD+', 'FADH2', 'FAD', 'GTP', 'GDP', 'DNA', 'RNA', 'CoA', 'Pi', 'PPi'];

  function normalizeFormula(f) {
    var sub = '₀₁₂₃₄₅₆₇₈₉';
    return String(f).replace(/[₀-₉]/g, function (c) { return sub.indexOf(c); }).replace(/[−–]/g, '-').replace(/\s+/g, '');
  }
  function isAbbreviation(f) { return ABBREVIATIONS.indexOf(f) !== -1; }

  // { ok:true, atoms:{C:1,O:2} } or { ok:false, reason:'abbreviation'|'charge'|'unreadable' }.
  function countAtoms(formula) {
    var f = normalizeFormula(formula);
    if (isAbbreviation(f)) return { ok: false, reason: 'abbreviation' };
    if (/[+\-]/.test(f)) return { ok: false, reason: 'charge' };
    var atoms = {}, okAll = true;
    f.split(/[·.]/).forEach(function (part) {
      if (!part) { okAll = false; return; }
      var m = /^(\d+)/.exec(part), mult = 1;
      if (m) { mult = parseInt(m[1], 10); part = part.slice(m[1].length); }
      var pos = 0;
      function group(closer) {
        var out = {};
        while (pos < part.length) {
          var ch = part[pos];
          if (ch === '(' || ch === '[') {
            pos++;
            var inner = group(ch === '(' ? ')' : ']');
            if (!inner) return null;
            var n = /^\d+/.exec(part.slice(pos)), k = 1;
            if (n) { k = parseInt(n[0], 10); pos += n[0].length; }
            Object.keys(inner).forEach(function (e) { out[e] = (out[e] || 0) + inner[e] * k; });
          } else if (ch === ')' || ch === ']') {
            if (ch !== closer) return null;
            pos++;
            return out;
          } else {
            var el = /^[A-Z][a-z]?/.exec(part.slice(pos));
            if (!el) return null;
            var sym = el[0];
            if (!ELEMENT_NAMES[sym]) { sym = sym[0]; if (!ELEMENT_NAMES[sym]) return null; }
            pos += sym.length;
            var c = /^\d+/.exec(part.slice(pos)), cnt = 1;
            if (c) { cnt = parseInt(c[0], 10); pos += c[0].length; }
            out[sym] = (out[sym] || 0) + cnt;
          }
        }
        return closer ? null : out;
      }
      var res = part ? group(null) : null;
      if (!res || !Object.keys(res).length) { okAll = false; return; }
      Object.keys(res).forEach(function (e) { atoms[e] = (atoms[e] || 0) + res[e] * mult; });
    });
    return okAll ? { ok: true, atoms: atoms } : { ok: false, reason: 'unreadable' };
  }

  function hillOrder(symbols) {
    var s = symbols.slice().sort();
    if (s.indexOf('C') !== -1) {
      var rest = s.filter(function (x) { return x !== 'C' && x !== 'H'; });
      return ['C'].concat(s.indexOf('H') !== -1 ? ['H'] : [], rest);
    }
    return s;
  }
  function listAtoms(atoms, symbols) {
    var parts = symbols.map(function (e) { return (atoms[e] || 0) + ' ' + (ELEMENT_NAMES[e] || e); });
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  // The balance line is worked out HERE from the formulas and counts — never by the AI.
  function balance(data) {
    var sides = [data.reactants || [], data.products || []].map(function (list) {
      var total = {}, problem = null;
      list.forEach(function (s) {
        var c = countAtoms(s.formula);
        if (!c.ok) { if (!problem) problem = { reason: c.reason, formula: normalizeFormula(s.formula) }; return; }
        Object.keys(c.atoms).forEach(function (e) { total[e] = (total[e] || 0) + c.atoms[e] * (s.count || 1); });
      });
      return { total: total, problem: problem };
    });
    var problem = sides[0].problem || sides[1].problem;
    if (problem) {
      var why = problem.reason === 'abbreviation' ? problem.formula + ' is a short name, not a full chemical formula, so the atoms can’t be counted.'
        : problem.reason === 'charge' ? 'this equation has charged ions, so the atoms were not counted.'
        : '“' + problem.formula + '” could not be read as a chemical formula.';
      return { state: 'unchecked', bold: 'Balance not checked:', rest: ' ' + why };
    }
    var L = sides[0].total, R = sides[1].total, all = {};
    Object.keys(L).concat(Object.keys(R)).forEach(function (e) { all[e] = 1; });
    var symbols = hillOrder(Object.keys(all));
    var same = symbols.every(function (e) { return (L[e] || 0) === (R[e] || 0); });
    if (same) return { state: 'balanced', bold: 'Balanced:', rest: ' both sides have ' + listAtoms(L, symbols) + ' atoms. Nothing is lost, only rearranged.' };
    return { state: 'unbalanced', bold: 'Not balanced as written:', rest: ' left has ' + listAtoms(L, symbols) + ', right has ' + listAtoms(R, symbols) + '.' };
  }

  // Splits a formula into normal / subscript / superscript runs. Digits right after a
  // letter or a closing bracket are subscripts; a trailing + or - is a charge.
  function formulaParts(formula) {
    var f = normalizeFormula(formula), parts = [];
    function push(t, text) {
      if (parts.length && parts[parts.length - 1].t === t) parts[parts.length - 1].text += text;
      else parts.push({ t: t, text: text });
    }
    var ion = /^([A-Z][a-z]?)(\d*[+\-])$/.exec(f); // single-element ion: Fe3+, Na+, O2-
    if (ion && !isAbbreviation(f)) { push('n', ion[1]); push('sup', ion[2].replace('-', '−')); return parts; }
    for (var i = 0; i < f.length; i++) {
      var ch = f[i], prev = i ? f[i - 1] : '';
      if (/\d/.test(ch) && /[A-Za-z)\]]/.test(prev)) {
        var run = ch;
        while (i + 1 < f.length && /\d/.test(f[i + 1])) run += f[++i];
        push('sub', run);
      } else if ((ch === '+' || ch === '-') && i === f.length - 1 && i > 0) push('sup', ch === '-' ? '−' : '+');
      else push('n', ch === '.' ? '·' : ch);
    }
    return parts;
  }
  function subSize(size) { return Math.max(MIN_FONT, Math.round(size * 0.63)); }
  function formulaWidth(parts, size, prefix) {
    var w = prefix ? measure(prefix, size, 700) : 0;
    parts.forEach(function (p) { w += measure(p.text, p.t === 'n' ? size : subSize(size), 700); });
    return w;
  }
  function formulaTspans(parts, size, prefix) {
    var out = prefix ? esc(prefix) : '', shift = 0, down = r1(size * 0.27), up = r1(size * 0.4);
    parts.forEach(function (p) {
      var want = p.t === 'sub' ? down : p.t === 'sup' ? -up : 0, dy = want - shift;
      shift = want;
      if (p.t === 'n') out += dy ? '<tspan dy="' + r1(dy) + '">' + esc(p.text) + '</tspan>' : esc(p.text);
      else out += '<tspan dy="' + r1(dy) + '" font-size="' + subSize(size) + '">' + esc(p.text) + '</tspan>';
    });
    return out;
  }

  // ── molecule library ──────────────────────────────────────────────────────
  // Only molecules listed here are drawn as balls. Anything else gets a formula badge —
  // never a guessed structure. Coordinates are relative to the centre of the drawing area.
  var ATOM = {
    O: { fill: '#D9534F', text: '#fff' }, C: { fill: '#3A4450', text: '#fff' }, H: { fill: '#FFFFFF', text: '#0B0F14' },
    N: { fill: '#3B6FD4', text: '#fff' }, S: { fill: '#E3B505', text: '#0B0F14' }, Cl: { fill: '#3FA34D', text: '#fff' },
    Na: { fill: '#8E5BD9', text: '#fff' }
  };
  var RING = [[0, -42], [41.6, -21], [41.6, 21], [0, 42], [-41.6, 21], [-41.6, -21]];
  // atoms: [element, x, y, radius, label?]   bonds: [from, to, order]
  var MOLECULES = {
    CO2: { name: 'carbon dioxide', atoms: [['O', -46, 0, 21], ['C', 0, 0, 19], ['O', 46, 0, 21]], bonds: [[0, 1, 2], [1, 2, 2]] },
    H2O: { name: 'water', atoms: [['O', 0, -8, 23], ['H', -36, 26, 15], ['H', 36, 26, 15]], bonds: [[0, 1, 1], [0, 2, 1]] },
    O2: { name: 'oxygen', atoms: [['O', -24, 0, 23], ['O', 24, 0, 23]], bonds: [[0, 1, 2]] },
    H2: { name: 'hydrogen', atoms: [['H', -21, 0, 17], ['H', 21, 0, 17]], bonds: [[0, 1, 1]] },
    N2: { name: 'nitrogen', atoms: [['N', -24, 0, 23], ['N', 24, 0, 23]], bonds: [[0, 1, 3]] },
    CO: { name: 'carbon monoxide', atoms: [['C', -23, 0, 21], ['O', 23, 0, 23]], bonds: [[0, 1, 3]] },
    CH4: { name: 'methane', atoms: [['C', 0, 0, 21], ['H', -37, -30, 14], ['H', 37, -30, 14], ['H', -37, 30, 14], ['H', 37, 30, 14]], bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]] },
    NH3: { name: 'ammonia', atoms: [['N', 0, -12, 22], ['H', -39, 18, 14], ['H', 0, 34, 14], ['H', 39, 18, 14]], bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1]] },
    HCl: { name: 'hydrogen chloride', atoms: [['H', -27, 0, 15], ['Cl', 13, 0, 24]], bonds: [[0, 1, 1]] },
    NaCl: { name: 'sodium chloride (salt)', unit: 'formula unit', atoms: [['Na', -24, 0, 21, 'Na+'], ['Cl', 22, 0, 25, 'Cl−']], bonds: [] },
    O3: { name: 'ozone', atoms: [['O', 0, -12, 21], ['O', -41, 16, 21], ['O', 41, 16, 21]], bonds: [[0, 1, 2], [0, 2, 1]] },
    NO2: { name: 'nitrogen dioxide', atoms: [['N', 0, -12, 21], ['O', -41, 16, 21], ['O', 41, 16, 21]], bonds: [[0, 1, 2], [0, 2, 1]] },
    SO2: { name: 'sulfur dioxide', atoms: [['S', 0, -12, 22], ['O', -42, 16, 21], ['O', 42, 16, 21]], bonds: [[0, 1, 2], [0, 2, 2]] },
    H2O2: { name: 'hydrogen peroxide', atoms: [['O', -21, 0, 20], ['O', 21, 0, 20], ['H', -52, -26, 14], ['H', 52, 26, 14]], bonds: [[0, 1, 1], [0, 2, 1], [1, 3, 1]] },
    C2H5OH: { name: 'ethanol', atoms: [['C', -40, 0, 15], ['C', 0, 0, 15], ['O', 40, 0, 16], ['H', 68, -24, 14], ['H', -76, 0, 14], ['H', -40, -36, 14], ['H', -40, 36, 14], ['H', 0, -36, 14], ['H', 0, 36, 14]], bonds: [[0, 1, 1], [1, 2, 1], [2, 3, 1], [0, 4, 1], [0, 5, 1], [0, 6, 1], [1, 7, 1], [1, 8, 1]], bondWidth: 4 },
    C6H12O6: { name: 'glucose (sugar)', atoms: RING.map(function (p, i) { return [i ? 'C' : 'O', p[0], p[1], 14]; }), bonds: [[0, 1, 1], [1, 2, 1], [2, 3, 1], [3, 4, 1], [4, 5, 1], [5, 0, 1]], bondWidth: 4 },
    ATP: { name: 'ATP (energy carrier)', badge: true }
  };
  MOLECULES.C2H6O = MOLECULES.CH3CH2OH = MOLECULES.C2H5OH;

  function moleculeHalfWidth(mol) {
    var w = 0;
    mol.atoms.forEach(function (a) { w = Math.max(w, Math.abs(a[1]) + a[3]); });
    return w;
  }
  function drawMolecule(mol, cx, cy) {
    var out = '';
    mol.bonds.forEach(function (b) {
      var A = mol.atoms[b[0]], B = mol.atoms[b[1]];
      var x1 = cx + A[1], y1 = cy + A[2], x2 = cx + B[1], y2 = cy + B[2];
      var len = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) || 1, nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
      var offs = b[2] === 2 ? [-5, 5] : b[2] === 3 ? [-7, 0, 7] : [0];
      var width = b[2] === 1 ? (mol.bondWidth || 5) : 3;
      offs.forEach(function (o) {
        out += '<line x1="' + r1(x1 + nx * o) + '" y1="' + r1(y1 + ny * o) + '" x2="' + r1(x2 + nx * o) + '" y2="' + r1(y2 + ny * o) +
          '" stroke="' + COL.ink + '" stroke-width="' + width + '" stroke-linecap="round"/>';
      });
    });
    mol.atoms.forEach(function (a) {
      var st = ATOM[a[0]] || { fill: '#8894A0', text: '#fff' }, label = a[4] || a[0];
      var fs = Math.max(MIN_FONT, Math.round(label.length > 1 ? a[3] * 0.78 : a[3]));
      out += '<circle cx="' + r1(cx + a[1]) + '" cy="' + r1(cy + a[2]) + '" r="' + a[3] + '" fill="' + st.fill + '" stroke="' + COL.ink + '" stroke-width="1.5"/>' +
        textEl(cx + a[1], cy + a[2] + fs * 0.36, esc(label), { size: fs, anchor: 'middle', fill: st.text, weight: 700 });
    });
    return out;
  }
  // Neat badge for molecules we have no drawing for.
  function drawBadge(formula, cx, cy, maxW) {
    var parts = formulaParts(formula), size = 24;
    while (size > 22 && formulaWidth(parts, size) > maxW - 36) size--;
    var w = Math.min(maxW, Math.max(96, formulaWidth(parts, size) + 36)), h = 60;
    return '<rect x="' + r1(cx - w / 2) + '" y="' + r1(cy - h / 2) + '" width="' + r1(w) + '" height="' + h + '" rx="14" fill="' + COL.white + '" stroke="' + COL.teal + '" stroke-width="2"/>' +
      textEl(cx, cy + size * 0.34, formulaTspans(parts, size), { size: size, anchor: 'middle', fill: COL.teal, weight: 700, fit: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
  }
  function unitFor(formula, mol) {
    if (mol && mol.unit) return mol.unit;
    if (/^[A-Z][a-z]?$/.test(formula) && ELEMENT_NAMES[formula]) return 'atom';
    if (/[+\-]$/.test(formula)) return 'ion';
    return 'molecule';
  }

  // ── shared pieces ─────────────────────────────────────────────────────────
  function open(W, H) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" font-family="' + FONT + '">' +
      '<rect width="' + W + '" height="' + H + '" fill="' + COL.white + '"/>';
  }
  function titleBlock(title, subtitle, maxW) {
    var t = fitLines(title, { size: 26, min: 18, weight: 700, maxW: maxW, maxLines: 1 });
    var out = textEl(30, 46, esc(t.lines[0] || ''), { size: t.size, fill: COL.ink, weight: 700, fit: [30, 16, 30 + maxW, 54] });
    if (subtitle) {
      var s = fitLines(subtitle, { size: 16, weight: 400, maxW: maxW, maxLines: 1 });
      out += textEl(30, 74, esc(s.lines[0]), { size: s.size, fill: COL.sub, fit: [30, 56, 30 + maxW, 80] });
    }
    return out;
  }
  function arrowHead(x, y, angle, len, half, color) {
    var c = Math.cos(angle), s = Math.sin(angle);
    function pt(dx, dy) { return r1(x + dx * c - dy * s) + ' ' + r1(y + dx * s + dy * c); }
    return '<path d="M' + pt(-len, -half) + ' L' + pt(0, 0) + ' L' + pt(-len, half) + ' Z" fill="' + (color || COL.teal) + '"/>';
  }
  // A numbered step card (process and cycle). Returns its height when h is not given.
  function stepLayout(step, cw, maxH) {
    var label = fitLines(step.label, { size: 17, weight: 700, maxW: cw - 62, maxLines: 2 });
    var labelBlock = 18 + label.lines.length * 22 + 6;
    var detail = null;
    if (step.detail) {
      var room = maxH ? Math.max(1, Math.floor((maxH - labelBlock - 16) / 19)) : 8;
      detail = fitLines(step.detail, { size: 15, weight: 400, maxW: cw - 32, maxLines: room });
    }
    return { label: label, detail: detail, labelBlock: labelBlock, height: Math.max(64, labelBlock + (detail ? 6 + detail.lines.length * 19 + 12 : 8)) };
  }
  function stepCard(x, y, cw, h, n, lay, fill) {
    var out = '<rect x="' + r1(x) + '" y="' + r1(y) + '" width="' + cw + '" height="' + r1(h) + '" rx="16" fill="' + (fill || COL.cardIn) + '" stroke="' + COL.stroke + '" stroke-width="1.5"/>';
    var box = [x + 8, y + 4, x + cw - 8, y + h - 4];
    out += '<circle cx="' + r1(x + 30) + '" cy="' + r1(y + 31) + '" r="15" fill="' + COL.teal + '"/>' +
      textEl(x + 30, y + 36.5, String(n), { size: 15, anchor: 'middle', fill: '#fff', weight: 700 });
    lay.label.lines.forEach(function (ln, i) {
      out += textEl(x + 54, y + 37 + i * 22, esc(ln), { size: lay.label.size, fill: COL.ink, weight: 700, fit: box });
    });
    if (lay.detail) lay.detail.lines.forEach(function (ln, i) {
      out += textEl(x + 16, y + lay.labelBlock + 22 + i * 19, esc(ln), { size: lay.detail.size, fill: COL.body, fit: box });
    });
    return out;
  }

  // ── template: equation ────────────────────────────────────────────────────
  function renderEquation(d) {
    var GAP = 44, ZONE = 222, CARD_H = 250, TOP = 120;
    var subs = d.reactants.concat(d.products).map(function (s) {
      var f = normalizeFormula(s.formula), mol = MOLECULES[f] || null, parts = formulaParts(f);
      return { count: s.count || 1, formula: f, mol: mol, parts: parts, prefix: (s.count || 1) > 1 ? (s.count + ' ') : '', name: s.name || (mol ? mol.name : '') };
    });
    // Card width adapts: wide enough for the widest drawing and the widest formula.
    var cardW = 180;
    subs.forEach(function (s) {
      if (s.mol && !s.mol.badge) cardW = Math.max(cardW, Math.ceil(moleculeHalfWidth(s.mol) * 2 + 28));
      cardW = Math.max(cardW, Math.ceil(formulaWidth(s.parts, 22, s.prefix) + 24));
    });
    var n = d.reactants.length, m = d.products.length;
    var rEnd = 30 + n * cardW + (n - 1) * GAP, zc = rEnd + ZONE / 2, pStart = rEnd + ZONE;
    var W = pStart + m * cardW + (m - 1) * GAP + 30;

    var cond = d.condition ? fitLines(d.condition, { size: 15, weight: 600, maxW: 200, maxLines: 2 }) : null;
    var loc = d.location ? fitLines(d.location, { size: 15, weight: 400, maxW: 200, maxLines: 4 }) : null;
    var bal = balance(d);
    var boldExtra = measure(bal.bold, 17, 700) - measure(bal.bold, 17, 400);
    var balLines = wrap(bal.bold + bal.rest, 17, 400, W - 60 - 40, boldExtra);
    var boxH = 52 + (balLines.length - 1) * 22, H = 394 + boxH + 24;

    // The sun is drawn only for a light-driven reaction, and only if the title leaves room.
    var subtitle = d.subtitle || 'What goes in, what comes out';
    var wantSun = !!d.condition && /light|sun|solar|photon/i.test(d.condition);
    var titleRoom = wantSun ? zc - 46 - 30 : W - 60;
    if (wantSun && (measure(d.title, 22, 700) > titleRoom)) { wantSun = false; titleRoom = W - 60; }

    var out = open(W, H) + titleBlock(d.title, subtitle, titleRoom);

    function heading(text, centre) {
      var w = measure(text, 14, 700, 1.5);
      var c = Math.min(Math.max(centre, 30 + w / 2), W - 30 - w / 2);
      return textEl(c, 104, text, { size: 14, anchor: 'middle', fill: COL.teal, weight: 700, spacing: 1.5 });
    }
    out += heading('GOES IN (REACTANTS)', (30 + rEnd) / 2 - (n > 1 ? 10 : 0));
    out += heading('COMES OUT (PRODUCTS)', (pStart + W - 30) / 2 + (m > 1 ? 10 : 0));

    subs.forEach(function (s, i) {
      var isProduct = i >= n, k = isProduct ? i - n : i;
      var x = (isProduct ? pStart : 30) + k * (cardW + GAP), cx = x + cardW / 2;
      var box = [x + 6, TOP + 4, x + cardW - 6, TOP + CARD_H - 4];
      out += '<g><rect x="' + x + '" y="' + TOP + '" width="' + cardW + '" height="' + CARD_H + '" rx="16" fill="' + (isProduct ? COL.cardOut : COL.cardIn) + '" stroke="' + COL.stroke + '" stroke-width="1.5"/>';
      var unit = unitFor(s.formula, s.mol), label = (s.count + ' ' + unit + (s.count === 1 ? '' : 's')).toUpperCase();
      var ls = measure(label, 15, 600, 1) <= cardW - 16 ? { size: 15, spacing: 1 } : { size: 14, spacing: 0 };
      out += textEl(cx, TOP + 32, esc(label), { size: ls.size, anchor: 'middle', fill: COL.sub, weight: 600, spacing: ls.spacing, fit: box });
      out += (s.mol && !s.mol.badge) ? drawMolecule(s.mol, cx, 225) : drawBadge(s.formula, cx, 225, cardW - 28);
      var nm = s.name ? fitLines(s.name, { size: 16, weight: 400, maxW: cardW - 20, maxLines: 2 }) : { lines: [], size: 16 };
      var two = nm.lines.length > 1, fs = 30;
      while (fs > 22 && formulaWidth(s.parts, fs, s.prefix) > cardW - 20) fs--;
      out += textEl(cx, two ? 308 : 318, formulaTspans(s.parts, fs, s.prefix), { size: fs, anchor: 'middle', fill: COL.ink, weight: 700, fit: box });
      nm.lines.forEach(function (ln, j) {
        out += textEl(cx, (two ? 336 : 348) + j * 19, esc(ln), { size: nm.size, anchor: 'middle', fill: COL.body, fit: box });
      });
      out += '</g>';
      var lastOfSide = isProduct ? k === m - 1 : k === n - 1;
      if (!lastOfSide) out += textEl(x + cardW + GAP / 2, 262, '+', { size: 40, anchor: 'middle', fill: COL.ink, weight: 700 });
    });

    if (wantSun) {
      for (var a = 0; a < 360; a += 45) {
        out += '<line x1="' + zc + '" y1="62" x2="' + zc + '" y2="30" stroke="' + COL.sunStroke + '" stroke-width="4" stroke-linecap="round" transform="rotate(' + a + ' ' + zc + ' 62)"/>';
      }
      out += '<circle cx="' + zc + '" cy="62" r="20" fill="' + COL.sun + '" stroke="' + COL.sunStroke + '" stroke-width="2"/>';
    }
    var zoneBox = [rEnd + 6, 108, pStart - 6, 372];
    if (cond) cond.lines.forEach(function (ln, i) {
      out += textEl(zc, 126 + i * 19, esc(ln), { size: cond.size, anchor: 'middle', fill: COL.ink, weight: 600, fit: zoneBox });
    });
    out += '<line x1="' + (rEnd + 18) + '" y1="245" x2="' + (rEnd + 188) + '" y2="245" stroke="' + COL.teal + '" stroke-width="8" stroke-linecap="round"/>' +
      '<path d="M' + (rEnd + 184) + ' 225 L' + (rEnd + 214) + ' 245 L' + (rEnd + 184) + ' 265 Z" fill="' + COL.teal + '"/>';
    if (loc) loc.lines.forEach(function (ln, i) {
      out += textEl(zc, 286 + i * 20, esc(ln), { size: loc.size, anchor: 'middle', fill: COL.body, fit: zoneBox });
    });

    out += '<rect x="30" y="394" width="' + (W - 60) + '" height="' + boxH + '" rx="12" fill="' + COL.noteFill + '" stroke="' + COL.noteStroke + '"/>';
    balLines.forEach(function (ln, i) {
      var str = i === 0 ? '<tspan font-weight="700">' + esc(bal.bold) + '</tspan>' + esc(ln.slice(bal.bold.length)) : esc(ln);
      out += textEl(W / 2, 426 + i * 22, str, { size: 17, anchor: 'middle', fill: COL.ink, fit: [34, 396, W - 34, 394 + boxH - 2] });
    });
    return { svg: out + '</svg>', width: W, height: H, balance: bal.state };
  }

  // ── template: process (steps in a row, second row if more than 4) ─────────
  function renderProcess(d) {
    var CW = 230, GAP = 44, TOP = 100, steps = d.steps, n = steps.length;
    var perRow = n <= 4 ? n : Math.ceil(n / 2);
    var W = Math.max(640, 60 + perRow * CW + (perRow - 1) * GAP);
    var lays = steps.map(function (s) { return stepLayout(s, CW); });
    var rows = [];
    for (var i = 0; i < n; i += perRow) rows.push({ from: i, to: Math.min(n, i + perRow) });
    var y = TOP, body = titleBlock(d.title, '', W - 60);
    rows.forEach(function (row, ri) {
      var h = 0, k;
      for (k = row.from; k < row.to; k++) h = Math.max(h, lays[k].height);
      for (k = row.from; k < row.to; k++) {
        var x = 30 + (k - row.from) * (CW + GAP);
        body += stepCard(x, y, CW, h, k + 1, lays[k]);
        if (k < row.to - 1) {
          var ay = y + h / 2;
          body += '<line x1="' + (x + CW + 8) + '" y1="' + r1(ay) + '" x2="' + (x + CW + GAP - 18) + '" y2="' + r1(ay) + '" stroke="' + COL.teal + '" stroke-width="5" stroke-linecap="round"/>' +
            arrowHead(x + CW + GAP - 6, ay, 0, 14, 9);
        }
      }
      if (ri < rows.length - 1) {
        // elbow connector: from the last card of this row to the first card of the next row
        var lastX = 30 + (row.to - row.from - 1) * (CW + GAP) + CW / 2, firstX = 30 + CW / 2, midY = y + h + 28, nextTop = y + h + 56;
        body += '<path d="M' + r1(lastX) + ' ' + r1(y + h + 6) + ' V' + r1(midY) + ' H' + r1(firstX) + ' V' + r1(nextTop - 16) + '" fill="none" stroke="' + COL.teal + '" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
          arrowHead(firstX, nextTop - 5, Math.PI / 2, 14, 9);
        y = nextTop;
      } else y += h;
    });
    var H = Math.round(y + 30);
    return { svg: open(W, H) + body + '</svg>', width: W, height: H };
  }

  // ── template: cycle (steps around a loop) ─────────────────────────────────
  function renderCycle(d) {
    var CW = 220, MAX_H = 180, TOP = 100, steps = d.steps, n = steps.length;
    // Loop size grows with the number of steps so neighbouring cards never touch and
    // there is always room for a full arrow between them.
    var rx = n <= 4 ? 300 : n <= 6 ? 360 : 420, ry = n <= 4 ? 200 : n <= 6 ? 270 : 340;
    var lays = steps.map(function (s) { return stepLayout(s, CW, MAX_H); });
    var h = 0;
    lays.forEach(function (l) { h = Math.max(h, l.height); });
    h = Math.min(MAX_H, h);
    var W = 2 * rx + CW + 60, cx = W / 2, cy = TOP + ry + h / 2, H = Math.round(cy + ry + h / 2 + 30);
    var centres = steps.map(function (s, i) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / n;
      return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
    });
    var out = open(W, H) + titleBlock(d.title, '', W - 60);
    // arrows first (under the cards)
    function edge(c, dx, dy) { // distance from a card centre to its edge along (dx,dy)
      var tx = dx ? (CW / 2) / Math.abs(dx) : Infinity, ty = dy ? (h / 2) / Math.abs(dy) : Infinity;
      return Math.min(tx, ty);
    }
    centres.forEach(function (c, i) {
      var t = centres[(i + 1) % n], dx = t.x - c.x, dy = t.y - c.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len, s = edge(c, ux, uy) + 6, e = len - edge(t, ux, uy) - 6, ang = Math.atan2(uy, ux);
      if (e - s < 16) return;
      var hx = c.x + ux * e, hy = c.y + uy * e;
      if (e - s > 30) out += '<line x1="' + r1(c.x + ux * s) + '" y1="' + r1(c.y + uy * s) + '" x2="' + r1(c.x + ux * (e - 14)) + '" y2="' + r1(c.y + uy * (e - 14)) + '" stroke="' + COL.teal + '" stroke-width="5" stroke-linecap="round"/>';
      out += arrowHead(hx, hy, ang, 16, 8);
    });
    centres.forEach(function (c, i) {
      out += stepCard(c.x - CW / 2, c.y - h / 2, CW, h, i + 1, lays[i], i === 0 ? COL.cardOut : COL.cardIn);
    });
    out += textEl(cx, cy + 5, 'The cycle repeats', { size: 15, anchor: 'middle', fill: COL.sub, weight: 600 });
    return { svg: out + '</svg>', width: W, height: H };
  }

  // ── template: comparison (columns side by side) ───────────────────────────
  function renderComparison(d) {
    var cols = d.columns, n = cols.length, CW = n === 2 ? 480 : n === 3 ? 330 : 250, GAP = 20, TOP = 100;
    var W = 60 + n * CW + (n - 1) * GAP;
    var heads = cols.map(function (c) { return fitLines(c.heading, { size: 18, weight: 700, maxW: CW - 32, maxLines: 2 }); });
    var headH = 0;
    heads.forEach(function (hd) { headH = Math.max(headH, 22 + hd.lines.length * 22 + 8); });
    var bodies = cols.map(function (c) {
      var yy = 0;
      var pts = c.points.map(function (p) {
        var f = fitLines(p, { size: 15, weight: 400, maxW: CW - 34 - 16, maxLines: 7 });
        var item = { f: f, y: yy };
        yy += f.lines.length * 20 + 10;
        return item;
      });
      return { pts: pts, height: yy };
    });
    var bodyH = 0;
    bodies.forEach(function (b) { bodyH = Math.max(bodyH, b.height); });
    var colH = headH + 18 + bodyH + 8, H = Math.round(TOP + colH + 30);
    var out = open(W, H) + titleBlock(d.title, '', W - 60);
    cols.forEach(function (c, i) {
      var x = 30 + i * (CW + GAP), box = [x + 8, TOP + 2, x + CW - 8, TOP + colH - 2];
      out += '<rect x="' + x + '" y="' + TOP + '" width="' + CW + '" height="' + r1(colH) + '" rx="16" fill="' + COL.cardIn + '" stroke="' + COL.stroke + '" stroke-width="1.5"/>' +
        '<path d="M' + x + ' ' + (TOP + headH) + ' V' + (TOP + 16) + ' a16 16 0 0 1 16 -16 H' + (x + CW - 16) + ' a16 16 0 0 1 16 16 V' + (TOP + headH) + ' Z" fill="' + COL.cardOut + '" stroke="' + COL.stroke + '" stroke-width="1.5"/>';
      heads[i].lines.forEach(function (ln, j) {
        var y0 = TOP + (headH - heads[i].lines.length * 22) / 2 + 17 + j * 22;
        out += textEl(x + CW / 2, y0, esc(ln), { size: heads[i].size, anchor: 'middle', fill: COL.ink, weight: 700, fit: box });
      });
      bodies[i].pts.forEach(function (p) {
        var y0 = TOP + headH + 18 + p.y;
        out += '<circle cx="' + (x + 20) + '" cy="' + r1(y0 + 9) + '" r="3.5" fill="' + COL.teal + '"/>';
        p.f.lines.forEach(function (ln, j) {
          out += textEl(x + 34, y0 + 14 + j * 20, esc(ln), { size: p.f.size, fill: COL.body, fit: box });
        });
      });
    });
    return { svg: out + '</svg>', width: W, height: H };
  }

  // ── public API ────────────────────────────────────────────────────────────
  function render(data) {
    if (!data || typeof data !== 'object') throw new Error('No diagram data');
    if (data.kind === 'equation') return renderEquation(data);
    if (data.kind === 'process') return renderProcess(data);
    if (data.kind === 'cycle') return renderCycle(data);
    if (data.kind === 'comparison') return renderComparison(data);
    throw new Error('Unknown diagram kind: ' + data.kind);
  }

  // SVG -> PNG in the browser: canvas at 2x on a white background. If the file comes out
  // large it is redrawn a little smaller, so a note with several diagrams still syncs.
  function toPng(result, maxBytes) {
    maxBytes = maxBytes || 220 * 1024;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var scales = [2, 1.5, 1.25, 1], url = '';
        for (var i = 0; i < scales.length; i++) {
          var c = document.createElement('canvas');
          c.width = Math.round(result.width * scales[i]); c.height = Math.round(result.height * scales[i]);
          var g = c.getContext('2d');
          g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          url = c.toDataURL('image/png');
          if (url.length * 0.75 <= maxBytes) break;
        }
        resolve(url);
      };
      img.onerror = function () { reject(new Error('The diagram could not be drawn.')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(result.svg);
    });
  }

  root.GNDiagram = {
    render: render, toPng: toPng, countAtoms: countAtoms, balance: balance, formulaParts: formulaParts,
    MOLECULES: MOLECULES, MIN_FONT: MIN_FONT
  };
})(typeof window !== 'undefined' ? window : globalThis);
