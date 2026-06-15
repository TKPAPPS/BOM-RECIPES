/**
 * formulaEval.js
 *
 * Tiny, SAFE arithmetic expression evaluator for pricing formulas.
 * Supports + - * / ( ), unary +/-, decimal numbers, and named
 * variables (e.g. `cost`).  No eval/Function — a hand-written
 * recursive-descent parser, so untrusted formula strings can never
 * execute code.
 *
 *   evalFormula('cost * 1.5 * 1.07', { cost: 100 })  // → 160.5
 */

function evalFormula(expr, vars = {}) {
  const s = String(expr ?? '');
  let i = 0;

  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };

  function parseExpr() {           // + and -
    let v = parseTerm();
    for (;;) {
      skip();
      const c = s[i];
      if (c === '+') { i++; v += parseTerm(); }
      else if (c === '-') { i++; v -= parseTerm(); }
      else break;
    }
    return v;
  }

  function parseTerm() {           // * and /
    let v = parseFactor();
    for (;;) {
      skip();
      const c = s[i];
      if (c === '*') { i++; v *= parseFactor(); }
      else if (c === '/') { i++; const d = parseFactor(); v = d === 0 ? NaN : v / d; }
      else break;
    }
    return v;
  }

  function parseArgs() {           // "(" expr ("," expr)* ")"
    i++; // consume '('
    const args = [parseExpr()];
    skip();
    while (s[i] === ',') { i++; args.push(parseExpr()); skip(); }
    if (s[i] !== ')') throw new Error('Missing closing ")"');
    i++;
    return args;
  }

  function applyFunc(name, args) {
    const x = args[0];
    // roundup/rounddown/round: optional 2nd arg = decimal places.
    const f = Math.pow(10, args.length > 1 ? Math.max(0, Math.round(args[1])) : 0);
    // *to variants: 2nd arg = the multiple to snap to (e.g. 5 → multiples of 5).
    const step = args.length > 1 ? args[1] : 1;
    const needStep = () => { if (!(step > 0)) throw new Error(`"${name}" needs a positive step, e.g. ${name}(cost * 1.5, 5)`); };
    switch (name) {
      case 'roundup':
      case 'ceil':        return Math.ceil(x * f) / f;
      case 'rounddown':
      case 'floor':       return Math.floor(x * f) / f;
      case 'round':       return Math.round(x * f) / f;
      case 'roundupto':   needStep(); return Math.ceil(x / step) * step;
      case 'rounddownto': needStep(); return Math.floor(x / step) * step;
      case 'roundto':     needStep(); return Math.round(x / step) * step;
      default: throw new Error(`Unknown function "${name}"`);
    }
  }

  function parseFactor() {         // numbers, variables, functions, parens, unary +/-
    skip();
    const c = s[i];
    if (c === '(') {
      i++;
      const v = parseExpr();
      skip();
      if (s[i] !== ')') throw new Error('Missing closing ")"');
      i++;
      return v;
    }
    if (c === '-') { i++; return -parseFactor(); }
    if (c === '+') { i++; return parseFactor(); }

    const num = /^[0-9]*\.?[0-9]+/.exec(s.slice(i));
    if (num) { i += num[0].length; return parseFloat(num[0]); }

    const id = /^[a-zA-Z_֐-׿][a-zA-Z0-9_֐-׿]*/.exec(s.slice(i));
    if (id) {
      i += id[0].length;
      const key = id[0].toLowerCase();
      skip();
      if (s[i] === '(') return applyFunc(key, parseArgs());   // function call
      if (!(key in vars)) throw new Error(`Unknown variable "${id[0]}"`);
      const val = Number(vars[key]);
      if (!Number.isFinite(val)) throw new Error(`Variable "${id[0]}" has no numeric value`);
      return val;
    }
    throw new Error(c ? `Unexpected character "${c}"` : 'Unexpected end of formula');
  }

  const result = parseExpr();
  skip();
  if (i < s.length) throw new Error(`Unexpected character "${s[i]}"`);
  if (!Number.isFinite(result)) throw new Error('Formula did not produce a valid number');
  return result;
}

/**
 * Validate a formula and return a representative multiplier (the price ÷
 * cost at a sample cost of 100).  Stored as a legacy/fallback multiplier;
 * the live engine evaluates the formula directly (so rounding etc. is
 * exact).  Throws if the formula is invalid or non-positive.
 */
function multiplierFromFormula(expr) {
  const SAMPLE = 100;
  const price = evalFormula(expr, { cost: SAMPLE });
  const m = price / SAMPLE;
  if (!(m > 0)) throw new Error('Formula must evaluate to a positive price');
  return m;
}

/**
 * The price for a given cost: evaluate the formula on `cost` when present
 * (exact — supports rounding & constants), else fall back to cost ×
 * multiplier.  Returns null when cost is unknown.
 */
function applyFormula(formulaExpr, multiplier, cost) {
  const c = Number(cost);
  if (cost == null || !Number.isFinite(c)) return null;
  if (formulaExpr) {
    try {
      const v = evalFormula(formulaExpr, { cost: c });
      if (Number.isFinite(v)) return v;
    } catch { /* fall back to multiplier */ }
  }
  return multiplier != null ? c * Number(multiplier) : null;
}

module.exports = { evalFormula, multiplierFromFormula, applyFormula };
