#!/usr/bin/env node

// ============================================================================
// AI Daily — GitHub Actions 版本
//
// 与本地版差异：
//   - HTML 托管到 GitHub Pages（替代飞书妙搭）
//   - 飞书消息用 bot 身份发送（只需 App Secret，无需用户 OAuth）
//   - 运行在 Ubuntu runner 上，无 Windows 特殊处理
// ============================================================================

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// 配置（敏感值从 GitHub Secrets 环境变量注入）
// ============================================================================

const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL  = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL    = 'deepseek-chat';
const USER_OPEN_ID      = process.env.FEISHU_USER_OPEN_ID || '';

const FEED_URLS = {
  x:        'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json',
  podcasts: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json',
  blogs:    'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json'
};

const PUBLIC_DIR  = join(__dirname, 'public');
const HASH_FILE   = join(__dirname, '.last-hash');

// GitHub Pages URL 格式: https://<username>.github.io/<repo>/
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO     = process.env.GITHUB_REPOSITORY || '';
const GITHUB_ACTOR    = process.env.GITHUB_ACTOR || '';
const REPO_NAME       = GITHUB_REPO.split('/')[1] || '';
const PAGES_URL       = `https://${GITHUB_ACTOR}.github.io/${REPO_NAME}`;

// ============================================================================
// 工具函数
// ============================================================================

function sanitizeText(str) {
  if (!str) return '';
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF ||
        cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0xFEFF ||
        (cp < 0x20 && cp !== 0x0A && cp !== 0x09) ||
        (cp >= 0x7F && cp <= 0x9F)) continue;
    out += ch;
  }
  return out;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日 星期${weekdays[d.getDay()]}`;
}

function jsonEscape(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

// ============================================================================
// 步骤 1：获取 feed 数据
// ============================================================================

function fetchContent() {
  console.log('[1/4] 获取 AI 行业动态...');

  const fetchOne = (url) => {
    try {
      return execSync(`curl -sL --max-time 15 "${url}"`, { encoding: 'utf-8', timeout: 20000 });
    } catch (_) { return null; }
  };

  const [rawX, rawPod, rawBlog] = [
    fetchOne(FEED_URLS.x), fetchOne(FEED_URLS.podcasts), fetchOne(FEED_URLS.blogs)
  ];

  let feedX = null, feedPodcasts = null, feedBlogs = null;
  if (rawX) try { feedX = JSON.parse(rawX); } catch (_) {}
  if (rawPod) try { feedPodcasts = JSON.parse(rawPod); } catch (_) {}
  if (rawBlog) try { feedBlogs = JSON.parse(rawBlog); } catch (_) {}

  if (feedX || feedPodcasts) {
    const totalTweets = (feedX?.x || []).reduce((s, a) => s + a.tweets.length, 0);
    const podEpisodes = feedPodcasts?.podcasts?.length || 0;
    console.log(`  ✓ 最新 feed: ${totalTweets} 条推文, ${podEpisodes} 期播客`);
    return {
      status: 'ok',
      generatedAt: new Date().toISOString(),
      x: feedX?.x || [],
      podcasts: feedPodcasts?.podcasts || [],
      blogs: feedBlogs?.blogs || [],
      stats: { totalTweets, podcastEpisodes: podEpisodes, xBuilders: (feedX?.x || []).length, blogPosts: (feedBlogs?.blogs || []).length }
    };
  }

  console.error('  ✗ 无法获取 feed 数据');
  process.exit(1);
}

// ============================================================================
// 步骤 2：去重检查
// ============================================================================

function isDuplicate(data) {
  const hash = createHash('md5')
    .update(JSON.stringify({ x: data.x, podcasts: data.podcasts, blogs: data.blogs }))
    .digest('hex');

  let prevHash = '';
  if (existsSync(HASH_FILE)) {
    prevHash = readFileSync(HASH_FILE, 'utf-8').trim();
  }
  if (hash === prevHash) {
    console.log('  ⚠ 内容与上次相同，跳过推送');
    return true;
  }
  writeFileSync(HASH_FILE, hash);
  return false;
}

// ============================================================================
// 步骤 3：DeepSeek API
// ============================================================================

function buildSystemPrompt() {
  return `你是一位资深的 AI 行业中文编辑和前端设计师。你的任务是：

1. 将输入中的所有英文推文 / 播客内容翻译成专业、通顺的中文
2. 以「中英对照」方式呈现：英文原文在上，中文翻译紧接其下
3. 将所有内容结构化输出为一篇完整的、极简杂志风格的 HTML 文档

你必须严格遵循以下 HTML 设计规范：

【布局】
- 单栏布局，max-width: 680px，水平居中
- 大量留白，padding 充裕
- 移动端响应式：@media (max-width: 600px) 时缩小 padding

【色彩】
- 页面背景: #fafaf8（暖色纸张感）
- 卡片背景: #ffffff，边框 1px solid #e8e8e4，圆角 8px
- 正文色: #1a1a1a
- 次要文字: #6b6b6b
- 强调色（标题下划线、按钮）: #8b5e3c
- 链接色: #2c6bae
- 推文引用块左边框: 3px solid #e8e0d0，背景 #fdfdfb

【字体】
- 刊头大标题: Georgia 或 serif 衬线字体
- 正文: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif

【内容结构】
- 刊头（居中）: 中文日期 + "AI 日报" 大字标题 + 统计摘要
- Builder 卡片: 姓名 + @handle + bio → 每条推文中英对照
- 每条推文需保留原始 X.com 可点击链接
- 播客区（如有）: 播客名 + 标题 + 要点列表中英对照
- 页脚: "由 AI Daily Bot 自动生成 · 每日 10:00 (北京时间)"

【HTML 输出规则】
- 输出从 <!DOCTYPE html> 开始到 </html> 结束的完整文档
- 所有 CSS 内联在 <style> 标签中
- 不要包裹在 \`\`\`html 代码块中
- 不要输出任何解释性文字，只输出 HTML 本身
- 每个 Builder 的推文控制在 5 条以内`;
}

function buildUserPrompt(preprocessed, dateStr) {
  const parts = [];
  parts.push(`今天的日期是 ${dateStr}。请根据以下内容生成 AI 日报 HTML。\n`);
  parts.push('## Builders & Tweets\n');
  for (const b of preprocessed.builders) {
    parts.push(`### ${b.name} (@${b.handle})`);
    if (b.bio) parts.push(`Bio: ${b.bio}`);
    parts.push('');
    for (const t of b.tweets) {
      parts.push(`- [${t.text}](${t.url})`);
    }
    parts.push('');
  }
  if (preprocessed.podcasts.length > 0) {
    parts.push('## Podcasts\n');
    for (const p of preprocessed.podcasts) {
      parts.push(`### ${p.name} — ${p.title}`);
      if (p.url) parts.push(`URL: ${p.url}`);
      for (const h of p.highlights) parts.push(`- ${h}`);
      parts.push('');
    }
  }
  parts.push('请输出完整 HTML：');
  return parts.join('\n');
}

async function callDeepSeek(preprocessed, dateStr) {
  console.log('[2/4] 调用 DeepSeek API...');
  if (!DEEPSEEK_API_KEY) {
    console.log('  ⚠ 未配置 API Key');
    return null;
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt   = buildUserPrompt(preprocessed, dateStr);

  console.log(`  → 发送请求 (system: ${systemPrompt.length} chars, user: ${userPrompt.length} chars)...`);

  const body = [
    '{',
    '"model":"' + DEEPSEEK_MODEL + '",',
    '"temperature":0.7,',
    '"max_tokens":16384,',
    '"stream":false,',
    '"messages":[',
    '{"role":"system","content":"' + jsonEscape(systemPrompt) + '"},',
    '{"role":"user","content":"'   + jsonEscape(userPrompt)   + '"}',
    ']',
    '}'
  ].join('');

  try {
    const resp = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
      body
    });
    if (!resp.ok) {
      console.log(`  ✗ API 错误 ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return null;
    }
    const json = await resp.json();
    let content = json.choices?.[0]?.message?.content || '';
    const codeBlock = content.match(/```html?\s*([\s\S]*?)```/i);
    if (codeBlock) content = codeBlock[1].trim();
    if (/^\s*<(!DOCTYPE|html)/i.test(content)) {
      console.log(`  ✓ 生成 HTML (${content.length} chars)`);
      return content;
    }
    return null;
  } catch (err) {
    console.log(`  ✗ API 异常: ${err.message}`);
    return null;
  }
}

// ============================================================================
// 步骤 4：发送飞书交互式卡片（bot 身份）
// ============================================================================

function sendInteractiveCard(url, stats, dateStr) {
  console.log('[3/4] 发送飞书卡片...');

  if (!USER_OPEN_ID) {
    console.log('  ⚠ 未配置 FEISHU_USER_OPEN_ID，跳过消息推送');
    return;
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📰 AI 日报' },
      template: 'wathet'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**${dateStr}**`,
            '',
            `追踪 ${stats.xBuilders} 位 AI Builders · ${stats.totalTweets} 条推文${stats.podcastEpisodes > 0 ? ` · ${stats.podcastEpisodes} 期播客` : ''}`,
            '',
            '由 DeepSeek 翻译为中文，中英对照呈现'
          ].join('\n')
        }
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '📰 打开完整日报' },
          type: 'primary',
          url: url
        }]
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '由 AI Daily Bot 自动推送 · 每日 10:00 (北京时间)' }]
      }
    ]
  };

  // 用 lark-cli 发送（bot 身份，无需用户 OAuth）
  try {
    const cardJson = JSON.stringify(card).replace(/'/g, "'\\''");
    execSync(
      `lark-cli im +messages-send --as bot --user-id ${USER_OPEN_ID} --msg-type interactive --content '${cardJson}' --format json`,
      { timeout: 30000, encoding: 'utf-8' }
    );
    console.log('  ✓ 交互式卡片发送成功');
    return true;
  } catch (err) {
    console.error(`  ✗ 发送失败: ${err.message}`);

    // 降级：纯文本
    try {
      execSync(
        `lark-cli im +messages-send --as bot --user-id ${USER_OPEN_ID} --text "📰 AI 日报 — ${dateStr}\\n👉 ${url}" --format json`,
        { timeout: 15000, encoding: 'utf-8' }
      );
      console.log('  ✓ 降级文本发送成功');
    } catch (_) {}
    return false;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════');
  console.log('  AI Daily — GitHub Actions 版');
  console.log('═══════════════════════════════════\n');

  // 1. 获取内容
  const rawData = fetchContent();
  if (rawData.stats.totalTweets === 0 && rawData.stats.podcastEpisodes === 0) {
    console.log('\n今天没有新的 AI 行业动态，跳过一次。');
    return;
  }

  // 2. 去重
  if (isDuplicate(rawData)) return;

  // 3. 预处理 + DeepSeek
  const builders = (rawData.x || []).map(b => ({
    name: sanitizeText(b.name), handle: sanitizeText(b.handle),
    bio: sanitizeText((b.bio || '').slice(0, 120)),
    tweets: (b.tweets || []).slice(0, 5).map(t => ({ text: sanitizeText(t.text), url: t.url }))
  })).filter(b => b.tweets.length > 0);

  const podcasts = (rawData.podcasts || []).map(p => ({
    name: sanitizeText(p.name), title: sanitizeText(p.title || ''),
    url: p.url || '', highlights: (p.highlights || []).slice(0, 8).map(sanitizeText)
  }));

  const preprocessed = { builders, podcasts, blogs: [], stats: rawData.stats, generatedAt: rawData.generatedAt };
  const dateStr = formatDate(rawData.generatedAt);

  let html = await callDeepSeek(preprocessed, dateStr);

  // 回退模板
  if (!html) {
    console.log('[2/4] 回退到模板渲染...');
    html = fallbackHtml(rawData, dateStr);
  }

  // 4. 写入 public 目录（GitHub Pages 会从此目录部署）
  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeFileSync(join(PUBLIC_DIR, 'index.html'), html, 'utf-8');
  console.log(`  ✓ HTML 已写入 ${PUBLIC_DIR}/index.html`);

  // 5. 发送飞书消息（HTML 会被 gh-pages action 部署）
  const url = PAGES_URL;
  console.log(`[4/4] 页面将部署到: ${url}`);
  sendInteractiveCard(url, rawData.stats, dateStr);

  console.log('\n═══════════════════════════════════');
  console.log('  完成!');
  console.log(`  页面地址: ${url}`);
  console.log('═══════════════════════════════════');
}

// 回退模板
function fallbackHtml(data, dateStr) {
  const stats = data.stats;
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const buildersHTML = (data.x || []).map(b => {
    const tweets = (b.tweets || []).slice(0, 5);
    if (!tweets.length) return '';
    return `<article class="builder"><header><h3>${esc(b.name)} <span class="handle">@${esc(b.handle)}</span></h3>${b.bio ? `<p class="bio">${esc(b.bio.slice(0,120))}</p>` : ''}</header>${tweets.map(t => `<blockquote class="tweet"><p>${esc(t.text)}</p><footer><a href="${esc(t.url)}" target="_blank">X.com</a></footer></blockquote>`).join('')}</article>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>AI 日报</title>
<style>
:root{--bg:#fafaf8;--card:#fff;--text:#1a1a1a;--muted:#6b6b6b;--border:#e8e8e4;--accent:#8b5e3c;--link:#2c6bae;--quote:#e8e0d0}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);line-height:1.8}
.magazine{max-width:680px;margin:0 auto;padding:60px 32px 80px}
.masthead{text-align:center;padding-bottom:48px;margin-bottom:48px;border-bottom:1px solid var(--border)}
.masthead .date{font-size:14px;color:var(--muted);letter-spacing:.08em;margin-bottom:16px}
.masthead h1{font-family:Georgia,serif;font-size:40px;color:var(--accent);margin-bottom:12px}
.masthead .lede{font-size:15px;color:var(--muted);max-width:400px;margin:0 auto}
.section-title{font-family:Georgia,serif;font-size:20px;color:var(--accent);margin:48px 0 24px;padding-bottom:8px;border-bottom:2px solid var(--accent);display:inline-block}
.builder{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:28px 28px 12px;margin-bottom:24px}
.builder h3{font-size:18px;font-weight:600}.builder .handle{font-weight:400;color:var(--muted);font-size:14px}
.builder .bio{font-size:13px;color:var(--muted);margin-bottom:16px;font-style:italic}
.tweet{margin:16px 0;padding:14px 18px;border-left:3px solid var(--quote);background:#fdfdfb;border-radius:0 6px 6px 0;font-size:15px;line-height:1.7}
.tweet p{margin-bottom:8px;white-space:pre-wrap;word-break:break-word}
.tweet footer{font-size:12px;color:var(--muted)}.tweet footer a{color:var(--link);text-decoration:none}
.page-footer{margin-top:64px;padding-top:24px;border-top:1px solid var(--border);text-align:center;font-size:12px;color:var(--muted)}
@media(max-width:600px){.magazine{padding:32px 16px 48px}.masthead h1{font-size:28px}.builder{padding:20px 16px 8px}}
</style></head><body><div class="magazine">
<header class="masthead"><div class="date">${dateStr}</div><h1>AI 日报</h1><p class="lede">追踪 AI builders — ${stats.xBuilders} 位开发者 · ${stats.totalTweets} 条推文</p></header>
${buildersHTML}
<footer class="page-footer"><p>由 AI Daily Bot 自动生成 · 每日 10:00 (北京时间)</p></footer>
</div></body></html>`;
}

main().catch(err => { console.error('流水线异常:', err.message); process.exit(1); });
