import { describe, expect, it } from 'vitest';
import { mathToSpeech } from '../../apps/web/src/features/voice/mathSpeech';

function read(source: string, format: 'auto' | 'latex' | 'unicode' = 'auto'): string {
  const result = mathToSpeech(source, { format });
  expect(result).toMatchObject({ sourceText: source, status: 'converted', reviewRequired: false });
  expect(typeof result.speechText).toBe('string');
  return result.speechText!;
}
function review(source: string, format: 'auto' | 'latex' | 'unicode' = 'auto'): void {
  expect(mathToSpeech(source, { format }).reason).not.toMatch(/\?{2,}/u);
  expect(mathToSpeech(source, { format })).toMatchObject({ sourceText: source, status: 'review', reviewRequired: true, speechText: null, reason: expect.any(String) });
}

describe('complete formulas to Chinese speech', () => {
  it.each(['∂L/∂w', String.raw`\frac{\partial L}{\partial w}`, String.raw`$\frac{\partial L}{\partial w}$`])('reads the same partial derivative without inventing symbol meanings: %s', source => {
    expect(read(source)).toBe('大写 L 对 w 的偏导数');
  });

  it.each(['β_1^t', String.raw`\beta_{1}^{t}`, 'β₁^t'])('reads Greek letters and both scripts: %s', source => {
    expect(read(source)).toBe('贝塔 下标 一 的 t 次方');
  });

  it('reads the EMA recurrence with the t−1 index scope and every operand', () => {
    const output = read('M_t = β M_(t-1)+(1-β)g_t');
    expect(output).toBe('大写 M 下标 t 等于 贝塔 乘以 大写 M，下标开始，t 减 一，下标结束 加 左括号，一 减 贝塔，右括号 乘以 g 下标 t');
  });

  it('keeps nested fraction and exponent scopes audible for bias correction', () => {
    const output = read(String.raw`\frac{1}{1-\beta^t}`);
    expect(output).toBe('分数开始，分子为一，分母为一 减 贝塔 的 t 次方，分数结束');
    expect(read(String.raw`\frac{\frac{a}{b}}{c+d}`)).toBe('分数开始，分子为分数开始，分子为a，分母为b，分数结束，分母为c 加 d，分数结束');
  });

  it('preserves source whitespace, explicit delimiters, and line breaks byte for byte', () => {
    const source = ' \r\n\\[\\frac{1}{\n1-\\beta^t}\\]  ';
    expect(mathToSpeech(source)).toMatchObject({ sourceText: source, status: 'converted' });
    expect(read(source)).toBe(read(String.raw`\frac{1}{1-\beta^t}`));
  });

  it.each([
    ['x²', 'x 的 二 次方'], ['x₁₂', 'x 下标 十二'], ['x⁻²', 'x 的 负二 次方'],
    ['x^T', 'x 上标 大写 T'], ['x^{t+1}', 'x，上标开始，t 加 一，上标结束'],
    ['x_{i+1}', 'x，下标开始，i 加 一，下标结束'],
  ])('keeps script grouping without guessing a transpose or annotation meaning: %s', (source, expected) => {
    expect(read(source)).toBe(expected);
  });

  it('reads bounded sums with a definite end before a following addend', () => {
    const source = String.raw`\sum_{i=1}^{n} x_i + b`;
    expect(read(source)).toBe('求和开始，下限为i 等于 一，上限为n，求和项为x 下标 i，求和结束 加 b');
    expect(read('∑_{i=1}^{n} (x_i+b)')).toBe('求和开始，下限为i 等于 一，上限为n，求和项为左括号，x 下标 i 加 b，右括号，求和结束');
    expect(read(String.raw`\sum^{n}_{i=1} x_i`)).toBe(read(String.raw`\sum_{i=1}^{n} x_i`));
  });

  it('reads explicit radicals and known LaTeX functions without treating bare English as a command', () => {
    expect(read(String.raw`\sqrt{1+x^2}`)).toBe('平方根，根号内为一 加 x 的 二 次方，根号结束');
    expect(read('√(x+1)')).toBe('平方根，根号内为x 加 一，根号结束');
    expect(read(String.raw`\sin(x)+\ln{x}`)).toBe('正弦，参数为x，参数结束 加 自然对数，参数为x，参数结束');
    expect(mathToSpeech('sin')).toMatchObject({ status: 'not-math', speechText: 'sin' });
  });

  it('reads clear relations, decimals and multiplication without dropping signs', () => {
    expect(read('α = 0.9 × β + .1')).toBe('阿尔法 等于 零点九 乘以 贝塔 加 零点一');
    expect(read('0 ≤ x < 1')).toBe('零 小于等于 x 小于 一');
    expect(read('(a/b)c')).toBe('左括号，分数开始，分子为a，分母为b，分数结束，右括号 乘以 c');
    expect(read('x-1')).toBe('x 减 一');
    expect(read('β-1')).toBe('贝塔 减 一');
    expect(read(String.raw`x\ne y\approx z`)).toBe('x 不等于 y 约等于 z');
    expect(read('x = -1001')).toBe('x 等于 负一千零一');
    expect(read('x = 001.02')).toBe('x 等于 零零一点零二');
  });

  it('retains function-like juxtaposition as written rather than guessing its semantics', () => {
    expect(read('f(x)', 'unicode')).toBe('f，左括号，x，右括号');
    expect(read('x(y+1)')).toBe('x，左括号，y 加 一，右括号');
  });

  it('reads Greek variants and upper case consistently across Unicode and LaTeX', () => {
    expect(read('Σ = σ + ς')).toBe('大写西格玛 等于 西格玛 加 西格玛');
    expect(read(String.raw`\Gamma = \varphi + \epsilon`)).toBe('大写伽马 等于 斐 加 艾普西隆');
  });
});

describe('review instead of partial or invented formula speech', () => {
  it.each([
    'x =', '= x', '1 +', 'a/b c', 'a/2x', String.raw`\sin x y`, 'x /', 'x_ ', 'x^', 'x_12', 'x^12', 'x_i_j', 'x^2^3',
    '(x+1]', '(x+1', 'x+1)', String.raw`\frac{1}{}`, String.raw`\frac{1}`, String.raw`\frac12`,
    String.raw`\sqrt`, '√x+1', String.raw`\sum_{i=1} x_i`, String.raw`\sum^n x_i`,
    String.raw`\sum_{i=1}^n`, String.raw`\sum_{i=1}_{j=2}^n x`, String.raw`\sum^n^m_i x`,
    '∂/∂w', '∂L/∂', '∂²L/∂w²', '∂L/∂w²', 'x=1 2', 'x = 1e-3', 'x = 3–5',
    String.raw`\left.x\right)`, String.raw`\left(x+1\right]`, String.raw`\left(x+1)`, String.raw`(x+1\right)`,
  ])('requires explicit review and returns no partial speech for %s', source => review(source));

  it.each([
    String.raw`\int_0^1 f(x)`, String.raw`\begin{matrix}1&2\end{matrix}`,
    String.raw`\unknown{x}`, String.raw`\frac{1}{\unsupported{x}}`,
    String.raw`\input{private-file}`, String.raw`\href{https://example.com}{x}`,
    String.raw`\htmlClass{attack}{x}`, String.raw`\constructor`, String.raw`\varconstructor`,
    '�', '\uE000', '\u0000', '\u000B', 'x=\u000B1', 'x = �', 'x = \uE000', 'x\u200B=1', 'x\u0000=1',
    'x = console.log(1)', 'x = <script>alert(1)</script>', 'x = process.exit()',
    'alpha + beta', 'sum = 1', '说明 x = 1 的含义',
  ])('does not execute, ignore, or guess unsupported source: %s', source => review(source));

  it.each(['beta', 'sum', 'loss', '普通段落没有公式。', 'The sum of two values.', 'well-being', '2026年'])('leaves ordinary prose untouched: %s', source => {
    expect(mathToSpeech(source)).toEqual({ sourceText: source, speechText: source, reviewRequired: false, status: 'not-math' });
  });

  it.each(['$x=1', '$$', '$x=1$$', String.raw`\(x=1\]`, String.raw`\[\]`])('rejects unmatched or empty delimiters: %s', source => review(source));

  it('accepts explicit single-symbol formula input without labeling all prose mathematics', () => {
    expect(read('x', 'latex')).toBe('x');
    expect(read('$x$')).toBe('x');
    expect(read('$$x$$')).toBe('x');
    expect(read(String.raw`\(x\)`)).toBe('x');
    review('ordinary', 'latex');
    review('', 'latex');
  });

  it('supports spacing commands but retains every mathematical operation', () => {
    expect(read(String.raw`\left(1\,-\!\beta\right)\cdot g_t`)).toBe('左括号，一 减 贝塔，右括号 乘以 g 下标 t');
    expect(read(String.raw`\dfrac{1}{2}\quad+\qquad\tfrac{1}{3}`)).toBe('分数开始，分子为一，分母为二，分数结束 加 分数开始，分子为一，分母为三，分数结束');
  });

  it('bounds input size, token count and nested groups without truncating source or crashing', () => {
    review('x='.repeat(1100));
    review('x+'.repeat(300) + 'x');
    review('('.repeat(30) + 'x=1' + ')'.repeat(30));
    review('x' + '^{x'.repeat(30) + '}'.repeat(30));
    review('-'.repeat(30) + 'x', 'unicode');
  });

  it('keeps conversion deterministic and never mutates options or the source', () => {
    const options = Object.freeze({ format: 'latex' as const });
    const source = String.raw`\frac{1}{1-\beta^t}`;
    expect(mathToSpeech(source, options)).toEqual(mathToSpeech(source, options));
    expect(options).toEqual({ format: 'latex' });
    expect(source).toBe(String.raw`\frac{1}{1-\beta^t}`);
  });
});
