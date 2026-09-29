import type { AskRequest, TeachingPlan } from '../../../packages/shared/protocol';

/** A labelled fixture: it never pretends to infer the user's PDF content. */
export function makeDemoPlan(request: AskRequest): TeachingPlan {
  const sourceIds = request.context.sources.map(source => source.sourceId);
  return {
    schemaVersion: '1',
    contextRevision: request.contextRevision,
    answer: '【演示模式 · 非模型回答】已接收你选中的真实 PDF 上下文，但未调用模型、未理解或分析这段教材。下面展示独立的自制 EMA 偏差修正样例，用来体验公式、表格和来源跳转。样例不代表对你当前问题的回答。配置本机 API 后才能获取针对选区的真实讲解。',
    needsClarification: false,
    clarificationQuestion: null,
    steps: [
      {
        stepId: 'demo-scope', title: '演示范围与真实选区',
        explanationMarkdown: '这是本地固定演示，不是 AI 分析。引用按钮只定位你本次选择的位置，不表示 EMA 样例出自该页。',
        speechText: '这是本地固定演示，不是模型回答。下面是独立的自制例子。',
        boardBlocks: [{ id: 'demo-warning', type: 'callout', tone: 'warning', text: '演示样例与当前教材不一定相关；未发送任何模型请求。下方引用仅用于测试选区定位。' }],
        sourceIds, exampleOrigin: 'none',
      },
      {
        stepId: 'demo-ema', title: '自制样例：EMA 与零初始化',
        explanationMarkdown: '令初值 M₀ = 0、β = 0.9，三次输入梯度都为 10。Mₜ 是指数移动平均，β 是历史权重系数，t 是步数。零初始化使前几步的权重和小于 1。',
        speechText: '自制例子：初值为零，贝塔等于零点九，每次梯度都为十。历史平均乘贝塔，加上当前梯度乘一减贝塔。',
        boardBlocks: [
          { id: 'ema-definition', type: 'math', latex: 'M_t = \\beta M_{t-1} + (1-\\beta)g_t, \\quad M_0=0', label: '指数移动平均' },
          { id: 'ema-correction', type: 'math', latex: '\\widehat{M}_t=\\frac{M_t}{1-\\beta^t}', label: '零初始化偏差修正；β 的 t 次方不是 β 乘 t' },
        ], sourceIds: [], exampleOrigin: 'teacher_created',
      },
      {
        stepId: 'demo-numbers', title: '自制样例：代入三个小数字',
        explanationMarkdown: '每次梯度都为 10 时，Mₜ = 10(1 − βᵗ)。除以权重和后均为 10。常数输入是这个数值演示的条件，不意味着任意随机梯度序列都恒等于 10。',
        speechText: '第一步是一，第二步是一点九，第三步是二点七一。权重总和分别为零点一、零点一九、零点二七一。修正后都等于十。',
        boardBlocks: [{ id: 'ema-table', type: 'table', headers: ['t', 'Mₜ', '1 − βᵗ', '修正值'], rows: [['1', '1', '0.1', '10'], ['2', '1.9', '0.19', '10'], ['3', '2.71', '0.271', '10']] }],
        sourceIds: [], exampleOrigin: 'teacher_created',
      },
    ],
    checkQuestion: '演示检查题：为什么零初始化时，第一步 M₁ 是 1 而不是 10？',
  };
}
