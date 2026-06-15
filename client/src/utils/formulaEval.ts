/**
 * Safe arithmetic evaluator for pricing formulas (client mirror of the
 * server's src/utils/formulaEval.js).  Supports + - * / ( ), unary +/-,
 * decimals and named variables (e.g. `cost`).  No eval() — a small
 * recursive-descent parser, so it is safe for user-entered strings.
 */
export function evalFormula(expr: string, vars: Record<string, number> = {}): number {
  const s = String(expr ?? '');
  let i = 0;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };

  function parseExpr(): number {
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
  function parseTerm(): number {
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
  function parseArgs(): number[] {
    i++; // consume '('
    const args = [parseExpr()];
    skip();
    while (s[i] === ',') { i++; args.push(parseExpr()); skip(); }
    if (s[i] !== ')') throw new Error('Missing closing ")"');
    i++;
    return args;
  }
  function applyFunc(name: string, args: number[]): number {
    const x = args[0];
    const f = Math.pow(10, args.length > 1 ? Math.max(0, Math.round(args[1])) : 0);
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
  function parseFactor(): number {
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
      if (!Number.isFinite(val)) throw new Error(`Variable "${id[0]}" has no value`);
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

/** Validate a formula; returns null if valid, or an error message string. */
export function validateFormula(expr: string): string | null {
  try {
    const price = evalFormula(expr, { cost: 100 });
    if (!(price > 0)) return 'Formula must evaluate to a positive price';
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
