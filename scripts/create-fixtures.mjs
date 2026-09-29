import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>@page{size:A4;margin:22mm}body{font-family:'Microsoft YaHei',sans-serif;color:#222;font-size:14px;line-height:2}h1{font-size:26px}h2{font-size:20px}.tag{font-size:11px;color:#888;letter-spacing:2px}.formula{background:#f4f5f3;padding:16px;font-family:'Cambria Math',serif;font-size:20px}.page{break-after:page}footer{margin-top:70px;color:#777;font-size:11px}</style><section class="page"><p class="tag">PDF AI TEACHER / 自制练习材料</p><h1>理解指数移动平均</h1><p>这是一份用于测试阅读器的自制练习，不来自商业教材。</p><h2>01 为什么需要偏差修正？</h2><p>指数移动平均将过去的梯度按权重累积。初始值为零时，早期估计会偏小。偏差修正通过除以权重总和，使估计回到合适的尺度。</p><div class="formula">Mₜ = β Mₜ₋₁ + (1 − β) gₜ</div><p>取 β = 0.9，初始值 M₀ = 0，连续三次梯度均为 10。</p><p>第一步得到 1，第二步得到 1.9，第三步得到 2.71。对应权重总和为 0.1、0.19、0.271。</p><div class="formula">M̂ₜ = Mₜ / (1 − βᵗ)</div><p>这里 βᵗ 表示 β 的 t 次方，并不是 β 乘以 t。这个例子用于说明零初始化的影响，不代表任意梯度序列都相同。</p><footer>自制测试材料 · 书面页码 1 · 可以自由使用与分发</footer></section><section><p class="tag">PDF AI TEACHER / 自制练习材料</p><h1>参数更新与学习位置</h1><h2>02 AdamW 的一个数字例子</h2><p>设参数初始值为 10，任务损失是 0.5 × (θ − 8)²。此时任务梯度为 2。</p><p>学习率取 0.1，衰减系数取 0.1。从零初始化开始，忽略极小常数后，第一步 Adam 更新量为 0.1，额外衰减量为 0.1。</p><div class="formula">θ₁ = 10 − 0.1 − 0.1 = 9.8</div><p>下一次在新参数位置计算任务梯度，得到 1.8。没有衰减时，参数为 9.9，下一次任务梯度为 1.9。</p><p>可以在第一页发起提问，然后翻到此页，观察讲解目标仍锁定在第一页。</p><footer>自制测试材料 · 书面页码 2 · 可以自由使用与分发</footer></section></html>`);
  await page.evaluate(()=>document.fonts.ready);
  await mkdir('public',{recursive:true});
  await page.pdf({path:'public/sample.pdf',printBackground:true});
  await mkdir('tests/fixtures',{recursive:true});
  await writeFile('tests/fixtures/README.md','自制测试 PDF 由 scripts/create-fixtures.mjs 使用本机 Edge 生成，位于 public/sample.pdf。内容可自由分发，无商业教材。\n');
  console.log('Created public/sample.pdf (2 pages, selectable Chinese text).');
} finally { await browser.close(); }
