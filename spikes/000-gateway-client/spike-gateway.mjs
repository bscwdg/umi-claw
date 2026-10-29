#!/usr/bin/env node
/**
 * Commit 00 SPIKE —— OpenClaw Gateway HTTP 客户端可行性验证
 *
 * 零依赖（Node 18+ 全局 fetch），单文件可跑。
 * 目的：验证 Umi Claw 2.0 主路线（Gateway HTTP → agent run）是否可用，
 *       并产出 Primary / Fallback / Unsupported 结论所需的全部证据。
 *
 * 用法：
 *   node spike-gateway.mjs --token <GATEWAY_TOKEN> \
 *        [--base http://127.0.0.1:3213] [--model <id>] \
 *        [--image <path.png>] [--out result.json] [--json]
 *
 * 场景（对应 PLAN 第七节 Commit 00 验收）：
 *   S0 health            GET /health
 *   S1 models            GET /v1/models（404=端点未开；200=已开并列模型）
 *   S2 nonstream         POST /v1/chat/completions（非流式）
 *   S3 sse               POST stream:true —— 首字延迟 / 分片数 / 总时长
 *   S4 abort             S3 中途 AbortController 取消 → 客户端能否正确结束
 *   S5 error_bad_token   鉴权失败是否返回结构化错误码（非超时）
 *   S6 error_bad_model   坏 model 是否返回结构化错误码（非超时）
 *   S7 multimodal        image_url 多模态输入（需 --image）
 *   S8 history_replay    同一 user= 串接：第二轮能否复述第一轮的事实（⑥）
 *   S9 isolation         不同 user= 是否互相看不到（⑤）
 */

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const BASE = String(arg('base', 'http://127.0.0.1:3213')).replace(/\/+$/, '');
const TOKEN = arg('token', process.env.GATEWAY_TOKEN || '');
const MODEL = arg('model', '');
const IMAGE = arg('image', '');
const OUT = arg('out', '');
const QUIET = has('json');

const R = { base: BASE, startedAt: new Date().toISOString(), node: process.version, scenarios: {} };
const say = (...a) => { if (!QUIET) console.log(...a); };
const rec = (k, v) => { R.scenarios[k] = v; return v; };

function headers(extra = {}) {
  return { 'Content-Type': 'application/json', ...(MODEL ? { 'x-openclaw-model': MODEL } : {}), ...extra };
}

async function getJson(path, hdrs = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, { method: 'GET', headers: hdrs });
    const body = await res.text();
    return { ms: Date.now() - t0, status: res.status, body: body.slice(0, 2000) };
  } catch (e) {
    return { ms: Date.now() - t0, error: String(e?.message || e) };
  }
}

async function post(path, payload, hdrs = {}, signal) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: headers(hdrs), body: JSON.stringify(payload), signal,
    });
    const body = await res.text();
    return { ms: Date.now() - t0, status: res.status, body };
  } catch (e) {
    return { ms: Date.now() - t0, error: String(e?.message || e), aborted: e?.name === 'AbortError' };
  }
}

async function postSse(path, payload, hdrs = {}) {
  const t0 = Date.now();
  const ctl = new AbortController();
  try {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: headers(hdrs), body: JSON.stringify(payload), signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      return { status: res.status, ms: Date.now() - t0, error: 'no_stream', body: txt.slice(0, 800) };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', chunks = 0, ttfb = null, done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      if (d) break;
      if (ttfb === null) ttfb = Date.now() - t0;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const data = l.slice(5).trim();
        if (data === '[DONE]') { done = true; continue; }
        chunks++;
        try {
          const j = JSON.parse(data);
          const d0 = j?.choices?.[0]?.delta?.content;
          if (typeof d0 === 'string') text += d0;
        } catch { /* 非 JSON 分片，忽略 */ }
      }
    }
    return { status: res.status, ms: Date.now() - t0, ttfbMs: ttfb, sseChunks: chunks, textLen: text.length, text: text.slice(0, 400) };
  } catch (e) {
    return { ms: Date.now() - t0, error: String(e?.message || e), aborted: e?.name === 'AbortError' };
  }
}

async function abortMidStream(path, payload, hdrs = {}, abortAfterChunks = 1) {
  const t0 = Date.now();
  const ctl = new AbortController();
  try {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: headers(hdrs), body: JSON.stringify(payload), signal: ctl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let chunks = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { ms: Date.now() - t0, chunksBeforeAbort: chunks, endedNaturally: true };
      chunks += (dec.decode(value).match(/data:/g) || []).length;
      if (chunks >= abortAfterChunks) { ctl.abort(); return { ms: Date.now() - t0, chunksBeforeAbort: chunks, abortedByClient: true }; }
    }
  } catch (e) {
    return { ms: Date.now() - t0, aborted: e?.name === 'AbortError', error: String(e?.message || e) };
  }
}

const msgs = (t) => [{ role: 'user', content: t }];

(async () => {
  say(`\n=== Commit 00 SPIKE @ ${BASE} ===`);
  if (!TOKEN) { console.error('缺少 --token（或 GATEWAY_TOKEN）'); process.exit(2); }
  const auth = { Authorization: `Bearer ${TOKEN}` };

  // S0 health（无需鉴权）
  const s0 = await getJson('/health');
  rec('S0_health', s0);
  say(`S0 health              ${s0.status ?? 'ERR'}  ${s0.ms}ms`);

  // S1 models
  const s1 = await getJson('/v1/models', auth);
  rec('S1_models', { ...s1, body: s1.body?.slice(0, 800) });
  say(`S1 models              ${s1.status ?? 'ERR'}  (404=端点未开)`);

  const enabled = s1.status === 200;
  if (!enabled) {
    say('\n端点未开启 —— 后续场景跳过。请先开 gateway.http.endpoints.chatCompletions.enabled');
    finish();
    return;
  }

  // S2 非流式
  const s2 = await post('/v1/chat/completions', { messages: msgs('只回复两个字：收到'), stream: false }, auth);
  rec('S2_nonstream', { ...s2, body: s2.body?.slice(0, 1200) });
  say(`S2 non-stream          ${s2.status ?? 'ERR'}  ${s2.ms}ms  body=${(s2.body || '').slice(0, 120)}`);

  // S3 SSE
  const s3 = await postSse('/v1/chat/completions', { messages: msgs('用一句话介绍你自己'), stream: true }, auth);
  rec('S3_sse', s3);
  say(`S3 SSE                 ${s3.status ?? 'ERR'}  ttfb=${s3.ttfbMs}ms  chunks=${s3.sseChunks}  total=${s3.ms}ms`);

  // S4 中途中止
  const s4 = await abortMidStream('/v1/chat/completions', { messages: msgs('从1数到100，每行一个数字'), stream: true }, auth, 2);
  rec('S4_abort', s4);
  say(`S4 abort mid-stream    ${s4.abortedByClient ? 'aborted by client' : (s4.aborted ? 'AbortError' : 'ended naturally')}  after=${s4.chunksBeforeAbort} chunks`);

  // S5 坏 token
  const s5 = await post('/v1/chat/completions', { messages: msgs('hi'), stream: false }, { Authorization: 'Bearer WRONG-TOKEN' });
  rec('S5_error_bad_token', { ...s5, body: s5.body?.slice(0, 800) });
  say(`S5 bad token           ${s5.status ?? 'ERR'}  body=${(s5.body || '').slice(0, 120)}`);

  // S6 坏 model
  const s6 = await post('/v1/chat/completions', { model: 'no-such-model-xyz', messages: msgs('hi'), stream: false }, auth);
  rec('S6_error_bad_model', { ...s6, body: s6.body?.slice(0, 800) });
  say(`S6 bad model           ${s6.status ?? 'ERR'}  body=${(s6.body || '').slice(0, 120)}`);

  // S7 多模态
  if (IMAGE) {
    try {
      const fs = await import('node:fs');
      const b64 = fs.readFileSync(IMAGE).toString('base64');
      const ext = IMAGE.toLowerCase().endsWith('.jpg') || IMAGE.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';
      const s7 = await post('/v1/chat/completions', {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这张图里写的是什么？只输出图中的文字。' },
            { type: 'image_url', image_url: { url: `data:image/${ext};base64,${b64}` } },
          ],
        }],
        stream: false,
      }, auth);
      rec('S7_multimodal', { ...s7, imageBytes: b64.length, body: s7.body?.slice(0, 1200) });
      say(`S7 multimodal          ${s7.status ?? 'ERR'}  body=${(s7.body || '').slice(0, 160)}`);
    } catch (e) {
      rec('S7_multimodal', { error: String(e?.message || e) });
      say(`S7 multimodal          ERR ${e?.message || e}`);
    }
  } else {
    say('S7 multimodal          skipped (未提供 --image)');
  }

  // S8 / S9 会话：回放 + 隔离（同一/不同 user=）
  const keyA = `conv:spike:${Date.now()}-a`;
  const keyB = `conv:spike:${Date.now()}-b`;
  const secret = 'UMI-ZEBRA-42';
  const w1 = await post('/v1/chat/completions', { messages: msgs(`请记住暗号 ${secret}，只回复 OK`), stream: false, user: keyA }, auth);
  const r1 = await post('/v1/chat/completions', { messages: msgs('我刚才给你的暗号是什么？只输出暗号本身'), stream: false, user: keyA }, auth);
  const r2 = await post('/v1/chat/completions', { messages: msgs('我刚才给你的暗号是什么？只输出暗号本身'), stream: false, user: keyB }, auth);
  const hitA = (r1.body || '').includes(secret);
  const hitB = (r2.body || '').includes(secret);
  rec('S8_history_replay', { write: { status: w1.status }, recallSameUser: { status: r1.status, body: r1.body?.slice(0, 600) }, recalled: hitA, userKey: keyA });
  rec('S9_isolation', { recallOtherUser: { status: r2.status, body: r2.body?.slice(0, 600) }, leaked: hitB, userKey: keyB });
  say(`S8 history replay      同 user 复述暗号: ${hitA ? 'YES（可回放）' : 'NO（不可回放→需回灌）'}`);
  say(`S9 isolation           跨 user 泄漏: ${hitB ? 'LEAKED' : 'no leak'}`);

  finish();

  function finish() {
    R.finishedAt = new Date().toISOString();
    if (OUT) {
      import('node:fs').then((fs) => {
        fs.writeFileSync(OUT, JSON.stringify(R, null, 2), 'utf8');
        say(`\n结果已写入 ${OUT}`);
      });
    } else if (QUIET) {
      console.log(JSON.stringify(R, null, 2));
    }
    say('=== SPIKE 结束 ===\n');
  }
})();
