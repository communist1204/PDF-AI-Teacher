/** Conservative notation-to-speech conversion. Never evaluates mathematics or code. */
export interface MathSpeechResult {
  sourceText: string;
  speechText: string | null;
  reviewRequired: boolean;
  status: 'converted' | 'review' | 'not-math';
  reason?: string;
}
export interface MathSpeechOptions { format?: 'auto' | 'latex' | 'unicode' }

const MAX_INPUT = 2000;
const MAX_TOKENS = 512;
const MAX_DEPTH = 24;
const MAX_OUTPUT = 6000;
const DIGITS = '零一二三四五六七八九';
const GREEK: Record<string, string> = {
  alpha: '阿尔法', beta: '贝塔', gamma: '伽马', delta: '德尔塔', epsilon: '艾普西隆',
  zeta: '泽塔', eta: '伊塔', theta: '西塔', iota: '约塔', kappa: '卡帕', lambda: '拉姆达',
  mu: '缪', nu: '纽', xi: '克西', omicron: '奥密克戎', pi: '派', rho: '柔', sigma: '西格玛',
  tau: '陶', upsilon: '宇普西隆', phi: '斐', chi: '卡伊', psi: '普赛', omega: '欧米伽',
};
const GREEK_LETTERS = 'αβγδεζηθικλμνξοπρστυφχψω';
const GREEK_NAMES = Object.keys(GREEK);
const GREEK_VARIANTS: Record<string, string> = { ϵ: 'epsilon', ϑ: 'theta', ϰ: 'kappa', ϖ: 'pi', ϱ: 'rho', ς: 'sigma', ϕ: 'phi' };
const COMMANDS: Record<string, string> = {
  frac: 'frac', dfrac: 'frac', tfrac: 'frac', partial: 'partial', sum: 'sum', sqrt: 'sqrt',
  cdot: '*', times: '*', div: '/', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', infty: 'infinity', sin: 'function', cos: 'function', tan: 'function',
  log: 'function', ln: 'function', exp: 'function',
};
const FUNCTIONS: Record<string, string> = { sin: '正弦', cos: '余弦', tan: '正切', log: '对数', ln: '自然对数', exp: '指数函数' };
const SUPER = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾';
const SUB = '₀₁₂₃₄₅₆₇₈₉₊₋₍₎';
const SCRIPT_ASCII = '0123456789+-()';
class ReviewError extends Error {}
interface Token { kind: string; value: string }
type Node =
  | { kind: 'symbol' | 'number' | 'infinity'; value: string }
  | { kind: 'group'; bracket: string; child: Node }
  | { kind: 'unary' | 'partial' | 'sqrt' | 'function'; value: string; child: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'script'; base: Node; sub?: Node; sup?: Node }
  | { kind: 'sum'; lower: Node; upper: Node; body: Node };

function greekName(value: string): string | undefined {
  if (Object.hasOwn(GREEK_VARIANTS, value)) return GREEK[GREEK_VARIANTS[value]];
  const index = GREEK_LETTERS.indexOf(value.toLowerCase());
  if (value.length === 1 && index >= 0) return (value === value.toUpperCase() ? '大写' : '') + GREEK[GREEK_NAMES[index]];
  const variants: Record<string, string> = { varepsilon: 'epsilon', vartheta: 'theta', varkappa: 'kappa', varpi: 'pi', varrho: 'rho', varsigma: 'sigma', varphi: 'phi' };
  const name = Object.hasOwn(variants, value) ? variants[value] : value.toLowerCase();
  if (Object.hasOwn(GREEK, name)) return (/^[A-Z]/u.test(value) ? '大写' : '') + GREEK[name];
  return undefined;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const sizedDelimiters: string[] = [];
  const push = (kind: string, value = kind) => {
    tokens.push({ kind, value });
    if (tokens.length > MAX_TOKENS) throw new ReviewError('公式过长，请分段校对读法。');
  };
  for (let at = 0; at < input.length;) {
    const char = input[at];
    if (/\s/u.test(char)) { at += 1; continue; }
    if (SUPER.includes(char) || SUB.includes(char)) {
      const alphabet = SUPER.includes(char) ? SUPER : SUB;
      let digits = '';
      while (at < input.length && alphabet.includes(input[at])) digits += SCRIPT_ASCII[alphabet.indexOf(input[at++])];
      push(alphabet === SUPER ? '^' : '_'); push('{');
      for (const token of tokenize(digits)) push(token.kind, token.value);
      push('}'); continue;
    }
    if (char === '\\') {
      const match = /^\\([A-Za-z]+|[,;! ])/u.exec(input.slice(at));
      if (!match) throw new ReviewError('存在不支持的 LaTeX 标记，请校对读法。');
      const command = match[1]; at += match[0].length;
      if (/^[,;! ]$/u.test(command) || ['quad', 'qquad'].includes(command)) continue;
      if (command === 'left' || command === 'right') {
        const next = input.slice(at).trimStart()[0];
        if (!(command === 'left' ? ['(', '[', '{'] : [')', ']', '}']).includes(next)) throw new ReviewError('公式括号标记不完整。');
        if (command === 'left') sizedDelimiters.push(next);
        else if (({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[next] !== sizedDelimiters.pop()) throw new ReviewError('LaTeX 左右括号标记不匹配。');
        continue;
      }
      const greek = greekName(command);
      if (greek) { push('symbol', greek); continue; }
      if (!Object.hasOwn(COMMANDS, command)) throw new ReviewError('存在尚不支持的 LaTeX 命令，请校对读法。');
      push(COMMANDS[command], command); continue;
    }
    const number = /^(?:\d+(?:\.\d+)?|\.\d+)/u.exec(input.slice(at));
    if (number) {
      if (/^[eE][+-]?\d/u.test(input.slice(at + number[0].length))) throw new ReviewError('紧凑科学计数法需要确认，请改为显式的乘十次方读法。');
      push('number', number[0]); at += number[0].length; continue;
    }
    const word = /^[A-Za-z]+/u.exec(input.slice(at));
    if (word) {
      if (word[0].length > 1) throw new ReviewError('连续英文字母的含义不明确，请校对读法。');
      push('symbol', /[A-Z]/u.test(char) ? `大写 ${char}` : char); at += 1; continue;
    }
    const greek = greekName(char);
    if (greek) { push('symbol', greek); at += 1; continue; }
    const alias: Record<string, string> = { '−': '-', '×': '*', '·': '*', '÷': '/', '∂': 'partial', '∑': 'sum', '√': 'sqrt', '∞': 'infinity' };
    if (Object.hasOwn(alias, char)) { push(alias[char], char); at += 1; continue; }
    if ('+-*/=<>≤≥≠≈_^()[]{}'.includes(char)) { push(char); at += 1; continue; }
    throw new ReviewError('公式含有无法可靠识别的字符，请对照原文校对。');
  }
  if (sizedDelimiters.length) throw new ReviewError('LaTeX 左右括号标记不匹配。');
  return tokens;
}

class Parser {
  private at = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek(): string { return this.tokens[this.at]?.kind ?? 'end'; }
  private take(): Token {
    const token = this.tokens[this.at++];
    if (!token) throw new ReviewError('公式缺少操作数或上下标。');
    return token;
  }
  private nested<T>(read: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new ReviewError('公式嵌套过深，请分段校对。');
    try { return read(); } finally { this.depth -= 1; }
  }
  parse(): Node {
    const node = this.relation();
    if (this.at !== this.tokens.length) throw new ReviewError('公式符号或括号不完整，请校对读法。');
    return node;
  }
  private relation(): Node {
    let node = this.additive();
    while (['=', '<', '>', '≤', '≥', '≠', '≈'].includes(this.peek())) {
      const op = this.take().kind;
      node = { kind: 'binary', op, left: node, right: this.additive() };
    }
    return node;
  }
  private additive(): Node {
    let node = this.product();
    while (['+', '-'].includes(this.peek())) {
      const op = this.take().kind;
      node = { kind: 'binary', op, left: node, right: this.product() };
    }
    return node;
  }
  private startsAtom(): boolean {
    return ['number', 'symbol', 'infinity', '(', '[', '{', 'frac', 'sqrt', 'sum', 'partial', 'function'].includes(this.peek());
  }
  private product(): Node {
    let node = this.unary();
    while (['*', '/'].includes(this.peek()) || this.startsAtom()) {
      const explicit = ['*', '/'].includes(this.peek());
      const op = explicit ? this.take().kind : 'implicit';
      const right = this.unary();
      if (!explicit && node.kind === 'binary' && node.op === '/') throw new ReviewError('斜线除法与相邻乘积的范围不明确，请添加括号。');
      if (!explicit && node.kind === 'number' && right.kind === 'number') throw new ReviewError('相邻数字之间缺少明确运算符。');
      node = { kind: 'binary', op, left: node, right };
    }
    return node;
  }
  private unary(): Node {
    if (['+', '-'].includes(this.peek())) {
      const value = this.take().kind;
      return { kind: 'unary', value, child: this.nested(() => this.unary()) };
    }
    return this.postfix();
  }
  private postfix(): Node {
    const base = this.atom();
    if (!['_', '^'].includes(this.peek())) return base;
    const node: Extract<Node, { kind: 'script' }> = { kind: 'script', base };
    while (['_', '^'].includes(this.peek())) {
      const script = this.take().kind === '_' ? 'sub' : 'sup';
      if (node[script]) throw new ReviewError('重复上下标的分组不明确，请补充括号。');
      node[script] = this.scriptArgument();
    }
    return node;
  }
  private scriptArgument(): Node {
    return this.nested(() => {
      if (['{', '(', '['].includes(this.peek())) return this.group();
      // An unbraced script is exactly one symbol or one digit, as in TeX.
      const next = this.tokens[this.at];
      if (!next || !['symbol', 'number', 'infinity'].includes(next.kind) || (next.kind === 'number' && next.value.length !== 1)) {
        throw new ReviewError('复合上下标需要明确括号，请校对读法。');
      }
      return this.atom();
    });
  }
  private group(): Node {
    const bracket = this.take().kind;
    const end = ({ '{': '}', '(': ')', '[': ']' } as Record<string, string>)[bracket];
    if (!end) throw new ReviewError('公式缺少必要分组。');
    return this.nested(() => {
      const child = this.relation();
      if (this.take().kind !== end) throw new ReviewError('公式括号不匹配。');
      return { kind: 'group', bracket, child };
    });
  }
  private requiredBraces(): Node {
    if (this.peek() !== '{') throw new ReviewError('LaTeX 分式或根式缺少花括号。');
    return this.group();
  }
  private atom(): Node {
    const token = this.tokens[this.at];
    if (!token) throw new ReviewError('公式缺少操作数或上下标。');
    if (['{', '(', '['].includes(token.kind)) return this.group();
    this.at += 1;
    switch (token.kind) {
      case 'number': case 'symbol': case 'infinity': return { kind: token.kind, value: token.value };
      case 'frac': return { kind: 'binary', op: 'fraction', left: this.requiredBraces(), right: this.requiredBraces() };
      case 'sqrt': {
        const child = token.value === '√' ? (['(', '[', '{'].includes(this.peek()) ? this.group() : undefined) : this.requiredBraces();
        if (!child) throw new ReviewError('根号覆盖范围不明确，请补充括号。');
        return { kind: 'sqrt', value: '', child };
      }
      case 'partial': {
        if (this.peek() !== 'symbol') throw new ReviewError('偏导符号后的变量不明确。');
        const child = this.nested(() => this.postfix());
        if (child.kind === 'script' && child.sup) throw new ReviewError('偏导阶数或带幂变量的含义不明确，请校对。');
        return { kind: 'partial', value: '', child };
      }
      case 'function': {
        if (!['(', '[', '{'].includes(this.peek())) throw new ReviewError('函数参数的范围需要用括号明确。');
        return { kind: 'function', value: token.value, child: this.nested(() => this.postfix()) };
      }
      case 'sum': {
        let lower: Node | undefined; let upper: Node | undefined;
        while (['_', '^'].includes(this.peek())) {
          const bound = this.take().kind;
          if (bound === '_') { if (lower) throw new ReviewError('求和下限重复。'); lower = this.scriptArgument(); }
          else { if (upper) throw new ReviewError('求和上限重复。'); upper = this.scriptArgument(); }
        }
        if (!lower || !upper || !this.startsAtom()) throw new ReviewError('求和缺少上下限或求和项，请校对。');
        return { kind: 'sum', lower, upper, body: this.nested(() => this.product()) };
      }
      default: throw new ReviewError('公式操作数或括号不完整，请校对读法。');
    }
  }
}

function ungroup(node: Node): Node { return node.kind === 'group' ? ungroup(node.child) : node; }
function sayNumber(value: string): string {
  const [integer, fraction] = value.split('.');
  let spoken: string;
  if (!integer) spoken = '零';
  else if (integer.length > 4 || (integer.length > 1 && integer.startsWith('0'))) spoken = [...integer].map(char => DIGITS[Number(char)]).join('');
  else {
    const number = Number(integer);
    if (number === 0) spoken = '零';
    else {
      spoken = '';
      const units = ['', '十', '百', '千'];
      for (let index = 0; index < integer.length; index += 1) {
        const digit = Number(integer[index]); const place = integer.length - index - 1;
        if (digit) spoken += DIGITS[digit] + units[place];
        else if (spoken && !spoken.endsWith('零') && Number(integer.slice(index + 1))) spoken += '零';
      }
      if (spoken.startsWith('一十')) spoken = spoken.slice(1);
    }
  }
  return spoken + (fraction === undefined ? '' : '点' + [...fraction].map(char => DIGITS[Number(char)]).join(''));
}
function simple(node: Node): boolean { return ['symbol', 'number', 'infinity'].includes(ungroup(node).kind); }
function say(node: Node): string {
  switch (node.kind) {
    case 'symbol': return node.value;
    case 'number': return sayNumber(node.value);
    case 'infinity': return '无穷大';
    case 'group': {
      const pair = node.bracket === '[' ? ['左方括号', '右方括号'] : ['左括号', '右括号'];
      return `${pair[0]}，${say(node.child)}，${pair[1]}`;
    }
    case 'unary': return (node.value === '-' ? '负' : '正') + say(node.child);
    case 'partial': return `偏微分 ${say(node.child)}`;
    case 'sqrt': return `平方根，根号内为${say(ungroup(node.child))}，根号结束`;
    case 'function': return `${FUNCTIONS[node.value]}，参数为${say(ungroup(node.child))}，参数结束`;
    case 'script': {
      let result = say(node.base);
      if (node.sub) result += simple(node.sub) ? ` 下标 ${say(ungroup(node.sub))}` : `，下标开始，${say(ungroup(node.sub))}，下标结束`;
      if (node.sup) {
        const exponent = ungroup(node.sup);
        // Capital T often means transpose; speak the notation without guessing its meaning.
        if (exponent.kind === 'symbol' && exponent.value.startsWith('大写')) result += ` 上标 ${say(exponent)}`;
        else if (simple(exponent) || exponent.kind === 'unary') result += ` 的 ${say(exponent)} 次方`;
        else result += `，上标开始，${say(exponent)}，上标结束`;
      }
      return result;
    }
    case 'sum': return `求和开始，下限为${say(ungroup(node.lower))}，上限为${say(ungroup(node.upper))}，求和项为${say(node.body)}，求和结束`;
    case 'binary': {
      const left = ungroup(node.left); const right = ungroup(node.right);
      if (node.op === '/' || node.op === 'fraction') {
        if (left.kind === 'partial' && right.kind === 'partial') return `${say(left.child)} 对 ${say(right.child)} 的偏导数`;
        return `分数开始，分子为${say(left)}，分母为${say(right)}，分数结束`;
      }
      // f(x) and x(y+z) have the same notation: do not invent function/multiplication semantics.
      if (node.op === 'implicit' && ['symbol', 'script'].includes(node.left.kind) && node.right.kind === 'group') return `${say(node.left)}，${say(node.right)}`;
      const operators: Record<string, string> = { '+': '加', '-': '减', '*': '乘以', implicit: '乘以', '=': '等于', '<': '小于', '>': '大于', '≤': '小于等于', '≥': '大于等于', '≠': '不等于', '≈': '约等于' };
      return `${say(node.left)} ${operators[node.op]} ${say(node.right)}`;
    }
  }
}

/** Call with one complete formula or explicit math span, never an arbitrary prose paragraph.
 * Unsupported/ambiguous input returns null speech: the caller must stop and request review.
 * This is a notation reader, not a CAS: it does not infer the meanings of L, w, T, etc.
 */
export function mathToSpeech(sourceText: string, options: MathSpeechOptions = {}): MathSpeechResult {
  const format = options.format ?? 'auto';
  let input = sourceText.trim();
  const delimiters = [['$$', '$$'], ['$', '$'], ['\\[', '\\]'], ['\\(', '\\)']];
  const delimiter = delimiters.find(([start]) => input.startsWith(start));
  const corrupted = /[\uFFFD\u200B-\u200F]|\p{Co}|\p{Cc}/u.test(sourceText.replace(/[\t\r\n]/gu, ''));
  const candidate = corrupted || format !== 'auto' || !!delimiter || /^[A-Za-z\dα-ω]\s*-/u.test(input) || /[\\α-ωΑ-Ωϵϑϰϖϱϕ∂∑∫√∞=+*/<>≤≥≠≈_^−×·÷⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/u.test(input);
  if (!candidate) return { sourceText, speechText: sourceText, reviewRequired: false, status: 'not-math' };
  try {
    if (corrupted) throw new ReviewError('公式含有乱码或不可见控制字符，请对照原文校对。');
    if (input.length > MAX_INPUT) throw new ReviewError('公式过长，请分段校对读法。');
    if (delimiter) {
      const [start, end] = delimiter;
      if (input.length <= start.length + end.length || !input.endsWith(end)) throw new ReviewError('公式分隔符不完整或公式为空。');
      input = input.slice(start.length, -end.length).trim();
    }
    if (!input) throw new ReviewError('公式为空，请补充内容。');
    const speechText = say(new Parser(tokenize(input)).parse());
    if (speechText.length > MAX_OUTPUT) throw new ReviewError('公式读法过长，请分段校对。');
    return { sourceText, speechText, reviewRequired: false, status: 'converted' };
  } catch (error) {
    if (!(error instanceof ReviewError)) throw error;
    return { sourceText, speechText: null, reviewRequired: true, status: 'review', reason: error.message };
  }
}
