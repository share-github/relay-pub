#!/usr/bin/env node
// relay: Leader と Worker の間に立つ proxy と記録装置。
// Leader (普通の claude) は Bash でこれを呼び、Worker (claude --bg) とは直接やり取りしない。
// 記録は作業ごとに .relay/<作業 id>/ に置き、2 層に分ける: state (workers/*.json と notes.md) と詳細 (log.jsonl と各 session の transcript)。
// 同じ repo で複数の Leader が別々の作業を進めても混ざらないように、Leader の session を作業に結びつける
// (.relay/sessions/<session id>)。作業 id は最初の spawn で自動で振る。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const SELF = new URL(import.meta.url).pathname;
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (name) => { const i = argv.indexOf(`--${name}`); if (i < 0) return false; argv.splice(i, 1); return true; };

// 親の Claude Code session から継承すると、子の transcript が保存されず claude agents にも出ない
const PARENT_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'CLAUDE_EFFORT'];
const cleanEnv = () => { const e = { ...process.env }; for (const k of PARENT_ENV) delete e[k]; return e; };
const claude = (args, o = {}) => execFileSync('claude', args, { encoding: 'utf8', env: cleanEnv(), ...o });
// git repo の中なら値を返し、git 管理外なら null
const git = (args, cwd) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

const WORKER_PROMPT = `あなたは relay 経由で Leader から指示を受ける Worker。Leader や他の Worker と直接やり取りしない。
指示の作業を終えたら、最後の返答を報告として指示と同じ言語で書く: 1 行目に結果の要約を 1 文、続けて変更したもの・判断したこと・未解決の点。
作業の途中で [relay] で始まる指示が届いたら、それも Leader からの指示として従う。中止や変更の指示なら、今の作業より優先する。
subagent に任せるかは、1 件を自分でやる速さではなく、次の 2 点で決める。
- 全体の待ち時間: 互いに独立した調査や作業が複数あれば、subagent に分けて同時に進める。1 件ずつは自分でやる方が速くても、順にこなすと全体は並列より遅い。
- 見落とし: 多くのファイルや箇所をもれなく確かめる作業 (全呼び出し元の確認、網羅的なレビュー・監査・調査など) は、範囲を分けて新しい文脈の subagent に任せる。自分の文脈で続けると、先に読んだ内容や見込みに引きずられ、後半ほど確認が粗くなる。
自分でやるのは、数回のツール実行で済む作業と、前の結果を見て次を決める逐次的な作業。subagent には目的・範囲・返す内容を明記して渡し、結果は自分で確かめてから報告に使う。`;

// オプションは位置引数 (指示の本文) より先に取り出す
const DIR_OPT = opt('dir'); // Worker の hook が作業の記録を直接指す
const O = { model: opt('model'), permissionMode: opt('permission-mode'), worker: opt('worker'), cwd: opt('cwd'), limit: opt('limit'), timeout: opt('timeout'), work: opt('work'), all: flag('all') };
const ROOT = DIR_OPT ? path.dirname(path.resolve(DIR_OPT)) : path.resolve(process.env.RELAY_DIR ?? findRoot());
function findRoot() {
  for (let p = process.cwd(); p !== path.dirname(p); p = path.dirname(p)) if (fs.existsSync(path.join(p, '.relay'))) return path.join(p, '.relay');
  return path.join(git(['rev-parse', '--show-toplevel'], process.cwd()) ?? process.cwd(), '.relay'); // git 管理外なら今のディレクトリに置く
}
const SID = process.env.CLAUDE_CODE_SESSION_ID;
const sessionFile = () => path.join(ROOT, 'sessions', SID);
const bound = () => { try { return fs.readFileSync(sessionFile(), 'utf8').trim(); } catch { return null; } };
// 今の作業: hook の --dir、--work か RELAY_WORK (人間が端末から見る時)、この session が結びついた作業の順
let WORK = DIR_OPT ? path.basename(path.resolve(DIR_OPT)) : O.work ?? process.env.RELAY_WORK ?? (SID ? bound() : null);
let DIR = WORK ? path.join(ROOT, WORK) : null;
const setWork = (id) => { WORK = id; DIR = path.join(ROOT, id); };
const units = () => { try { return fs.readdirSync(ROOT).filter((d) => fs.existsSync(path.join(ROOT, d, 'log.jsonl'))); } catch { return []; } };
const now = () => new Date().toISOString();
const first = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

// ---- 記録 ----
const wfile = (n) => path.join(DIR, 'workers', `${n}.json`);
const load = (n) => { try { return JSON.parse(fs.readFileSync(wfile(n), 'utf8')); } catch { return null; } };
const workers = () => { try { return fs.readdirSync(path.join(DIR, 'workers')).filter((f) => f.endsWith('.json')).map((f) => load(f.slice(0, -5))).filter(Boolean); } catch { return []; } };
function save(w) {
  w.updatedAt = now();
  fs.mkdirSync(path.dirname(wfile(w.name)), { recursive: true });
  const tmp = `${wfile(w.name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(w, null, 1));
  fs.renameSync(tmp, wfile(w.name));
}
// hook (Worker 側) と CLI (Leader 側) が同じファイルを書くので、lock を取って読み直してから変える
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function update(n, fn) {
  const lock = `${wfile(n)}.lock`;
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch { /* 他が書いている */ }
    if (i === 300) fs.rmSync(lock, { recursive: true, force: true }); // 3 秒取れなければ、持ち主が落ちて残った lock とみなす
    nap(10);
  }
  try { const w = load(n); fn(w); save(w); return w; } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
// 詳細記録。line があるものは Leader への 1 行通知 (relay wait) にも使う
function log(e) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(path.join(DIR, 'log.jsonl'), JSON.stringify({ ts: now(), ...e }) + '\n');
}
const readLog = () => { try { return fs.readFileSync(path.join(DIR, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// relay wait の読み始め。Leader がこの作業に結びついた時点の末尾にする
// (wait を始める前に届いた報告を取りこぼさず、後任の Leader には過去の通知を流さない)
const cursorFile = () => path.join(DIR, 'cursor', SID ?? 'default');
const leadersOf = (id) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, id, 'leaders.json'), 'utf8')); } catch { return {}; } };
// Leader の session を作業に結びつけ、作業の Leader として覚えておく (交代後の Leader が前任の会話を検索できるように)
function bind(id) {
  setWork(id);
  fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
  fs.writeFileSync(sessionFile(), id);
  if (!fs.existsSync(cursorFile())) {
    fs.mkdirSync(path.dirname(cursorFile()), { recursive: true });
    fs.writeFileSync(cursorFile(), String(readLog().length));
  }
  const m = leadersOf(id);
  if (m[SID]) return;
  m[SID] = now();
  fs.writeFileSync(path.join(DIR, 'leaders.json'), JSON.stringify(m, null, 1));
}

// 動いている bg session (id → claude agents の項目。status は idle / busy / waiting、waitingFor は待っているもの)
const agents = () => new Map(JSON.parse(claude(['agents', '--json'])).filter((e) => e.pid).map((e) => [e.id, e]));
// 動いている session を --resume すると copy ができるので、止めてから再開する。
// claude stop の後もプロセスはしばらく終了処理を続け、その間の --resume は copy になるので、プロセスが消えるまで待つ。
// 止められなかった時は投げる (止まっていない Worker を stopped と記録しない)
function stopAndWait(id) {
  const pid = JSON.parse(claude(['agents', '--json'])).find((e) => e.id === id)?.pid;
  if (!pid) return; // 動いていない
  claude(['stop', id]);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 60 && alive(); i++) spawnSync('sleep', ['0.5']);
  if (alive()) throw new Error(`session ${id} が 30 秒経っても終了しない`);
}

// ---- Worker の起動 ----
function start(w, text, resume) {
  const hook = (sub) => `'${process.execPath}' '${SELF}' --dir '${DIR}' _hook ${sub} ${w.name}`;
  // Leader・他の Worker との session 間のやり取りは relay を通す (Leader の文脈に Worker の会話を流さないため)。
  // 受信は crossSessionInbound で断り、送信は hook で止める。自分の subagent とのやり取りは session 内なので制限しない
  const settings = {
    worktree: { bgIsolation: 'none' },
    crossSessionInbound: 'refuse',
    statusLine: { type: 'command', command: hook('ctx') }, // Claude Code が計算した context の使用率を受け取る
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook('start') }] }],
      Stop: [{ hooks: [{ type: 'command', command: hook('stop') }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: hook('tool') }] }],
      PreToolUse: [{ matcher: 'SendMessage', hooks: [{ type: 'command', command: hook('send') }] }],
    },
  };
  const flags = ['-n', `relay-${WORK}-${w.name}`, '--settings', JSON.stringify(settings), '--append-system-prompt', WORKER_PROMPT,
    ...(w.model ? ['--model', w.model] : []), ...(w.permissionMode ? ['--permission-mode', w.permissionMode] : [])];
  // resume: 'saved' は job に保存した起動時のオプションで同じ session を起こす (フラグを渡すと会話の copy (別 session) になる)。
  // 'flags' は job が消えて保存したオプションが無い時。フラグを付けて起こし、会話を引き継いだ copy になる
  const args = resume === 'saved' ? ['--bg', '--resume', w.sessionId, text] : ['--bg', ...(resume ? ['--resume', w.sessionId] : []), ...flags, text];
  const r = spawnSync('claude', args, { cwd: w.cwd, encoding: 'utf8', env: cleanEnv() });
  const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''); // 色の制御文字を除く
  const id = out.match(/backgrounded\s+·\s+([0-9a-f]{8})/)?.[1];
  if (r.status !== 0 || !id) throw new Error(`claude --bg に失敗: ${first(out, 300)}`);
  if (resume === 'saved' && /started a copy/.test(out)) { // オプションの無い copy を残さない
    try { claude(['stop', id]); claude(['rm', id]); } catch { /* 片付け失敗は無視 */ }
    // 前の session が終了しきっていないか、process だけ消えて job の記録が動作中のまま残っている (コンテナの再起動など)。
    // 記録を消し、フラグ付きで会話を引き継いだ copy を起こす (記録を消した後にフラグ無しで起こすと、hook などの保存したオプションを失う)
    claude(['rm', w.shortId]);
    return start(w, text, 'flags');
  }
  return id;
}

function spawnWorker(name, text) {
  if (!name || !text) throw new Error('使い方: relay spawn <name> "<指示>" [--cwd dir] [--model m] [--permission-mode p]');
  const old = load(name);
  if (old && !['removed', 'retired'].includes(old.status)) throw new Error(`${name} は既にある (${old.status})。relay send で指示するか relay rm で消す`);
  if (old?.status === 'retired') stop(name, true); // context 上限で止めた前任を片付けて、同じ名前で後任を起こす
  const { model, permissionMode } = O;
  const cwd = path.resolve(O.cwd ?? process.cwd()); // Worker の作業ディレクトリ。既定は spawn を実行したディレクトリ
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${cwd} はディレクトリではない`);
  // 同じ名前で起こし直した後任でも、前任の会話を relay search で辿れるように transcript は引き継ぐ
  const w = { name, status: 'active', cwd, model, permissionMode, shortId: null, sessionId: null, transcripts: old?.transcripts ?? [], instruction: first(text, 200), lastReport: null, pending: [] };
  save(w);
  log({ worker: name, kind: 'instruct', text });
  w.shortId = start(w, text, false);
  update(name, (x) => { x.shortId = w.shortId; }); // 起動中に hook が書いた session id を消さない
  console.log(`${name} を起動した (claude attach ${w.shortId})`);
}

// ---- Leader → Worker ----
function send(name, text) {
  const w = load(name);
  if (!w || w.status === 'removed') throw new Error(`${name} は無い`);
  if (!text) throw new Error('使い方: relay send <name> "<指示>"');
  const e = agents().get(w.shortId), alive = !!e;
  if (w.handover) { // context が上限に達した Worker には新しい指示を渡さない
    if (w.status === 'retired' || e?.status === 'busy' || !w.pending.length) throw new Error(`${name} は context が上限に達したので指示を受け付けない。引き継ぎ報告 (relay show ${name}) を渡して後任を relay spawn する`);
    // 引き継ぎの指示が届く前に idle になった。指示の代わりにそれを渡す
    console.log(`${name} は context が上限。指示は渡さず、引き継ぎ報告を書かせる。報告が届いたら後任を relay spawn して渡す`);
    text = relayMsg(w.pending);
    update(name, (x) => { x.pending = []; });
  }
  log({ worker: name, kind: 'instruct', text });
  if (e?.status === 'busy') {
    // 作業中の session には直接割り込めないので、次のツール実行の後 (PostToolUse) か区切り (Stop) で渡す
    // simplified: 判定と hook の間の競合で次のターンまで残ることがある。relay state の pending で見える
    update(name, (x) => { x.pending.push(text); x.instruction = first(text, 200); });
    return console.log(`${name} は作業中。次のツール実行の後に渡す (pending ${load(name).pending.length})。今すぐ止めるなら relay stop の後に relay send`);
  }
  // simplified: idle でも subagent や background の結果を待っていることがあり、止めて再開するとその待ちは切れる。
  // 待っているかは直前の報告に出るので、送るか待つかは Leader が決める
  // hook が一度も走らずに止まった session でも、一覧から session id を引ける
  const job = JSON.parse(claude(['agents', '--json', '--all'])).find((e) => e.id === w.shortId);
  w.sessionId ??= job?.sessionId;
  if (!w.sessionId) throw new Error(`${name} の session id が分からない。起動直後なら少し待つ`);
  if (alive) stopAndWait(w.shortId);
  const old = w.shortId;
  update(name, (x) => { x.status = 'active'; x.instruction = first(text, 200); x.sessionId = w.sessionId; });
  const id = start(w, text, job ? 'saved' : 'flags');
  update(name, (x) => { x.shortId = id; });
  if (old && old !== id) try { claude(['rm', old]); } catch { /* 既に無い */ }
  console.log(`${name} に送った (claude attach ${id})`);
}

// ---- Worker → Leader (Worker の hook から呼ばれる) ----
const relayMsg = (msgs) => `[relay] Leader からの指示 (終えたら、報告は指示と同じ言語で書く):\n${msgs.join('\n---\n')}`;
function hook(sub, name) {
  const h = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (sub === 'send') return guardSend(h);
  if (sub === 'ctx') return context(h, name);
  if (!load(name)) return;
  let msgs = [];
  if (sub === 'tool') { // ツールを 1 回使うたびに、作業中に届いた指示を渡す
    if (h.agent_id || !load(name).pending.length) return; // subagent のツール実行では渡さない (subagent が指示を受け取ってしまう)。大半のツール実行はここで終わる (lock を取らない)
    update(name, (x) => { msgs = x.pending.splice(0); });
    if (msgs.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: relayMsg(msgs) } }));
    return;
  }
  const seen = (x) => {
    x.sessionId = h.session_id ?? x.sessionId;
    if (h.transcript_path && !x.transcripts.includes(h.transcript_path)) x.transcripts.push(h.transcript_path);
  };
  if (sub === 'start') return update(name, seen);
  // 区切りの返答はすべて報告にする。作業が終わったかどうかは判定しない (Worker が subagent や background の結果を
  // 待っていればその旨の報告になり、結果が届くとまた区切りが来る)。Leader が報告を読んで決める
  const report = h.last_assistant_message ?? '';
  let retired = false;
  const w = update(name, (x) => {
    seen(x);
    msgs = x.pending.splice(0);
    if (msgs.length) return; // ツールを使わずに区切りまで来た時は、止めずにここで渡す
    x.lastReport = first(report.split('\n').find((l) => /[\p{L}\p{N}]/u.test(l)), 200); // 文字を含む最初の行 (区切り線などを飛ばす)
    if (x.handover) { retired = true; x.status = 'retired'; } // 引き継ぎの指示の後の区切りが引き継ぎ報告
  });
  if (msgs.length) return process.stdout.write(JSON.stringify({ decision: 'block', reason: relayMsg(msgs) }));
  log({ worker: name, kind: 'report', text: report, session: w.sessionId,
    line: retired ? `${name} 引き継ぎ報告 (context 上限で止めた。後任を relay spawn して渡す): ${first(report, 140)}` : `${name} 報告: ${first(report, 140)}` });
}

// statusLine から context の使用量を受け取って記録する。上限 (使用率 CTX_LIMIT % か CTX_TOKENS tokens の早い方) に達したら、
// Worker に引き継ぎ報告を書かせて止め (指示は pending で渡す)、Leader に relay wait で知らせる。
// 上限は Leader の判断に任せない: 大きな context の Worker は 1 ターンごとの token 消費が重く、compact の後は質も落ちる
const CTX_LIMIT = 70, CTX_TOKENS = 250000;
const HANDOVER = 'context の使用量が上限に達した。今の作業を安全に区切れるところで止め、この session の最後の返答として後任の Worker への引き継ぎ報告を書く: '
  + '進み具合、変更したもの、判断したことと理由、残りの作業と注意点。新しい作業は始めない。';
function context(h, name) {
  const pct = h.context_window?.used_percentage, tokens = h.context_window?.total_input_tokens ?? 0;
  process.stdout.write(`relay ${name}${pct == null ? '' : ` · context ${pct}% (${Math.round(tokens / 1000)}k)`}`);
  const w = load(name), over = pct >= CTX_LIMIT || tokens >= CTX_TOKENS;
  if (!w || pct == null || (w.ctx === pct && (w.handover || !over))) return; // statusLine は頻繁に呼ばれる。変化が無ければ書かない
  let warn = false;
  update(name, (x) => {
    x.ctx = pct;
    x.ctxTokens = tokens;
    if (over && !x.handover) { warn = x.handover = true; x.pending.push(HANDOVER); }
  });
  if (warn) log({ worker: name, kind: 'context', text: `${pct}% ${tokens} tokens`,
    line: `${name} context ${pct}% (${Math.round(tokens / 1000)}k tokens): 区切りで引き継ぎ報告を書かせて止める。届いたら後任を relay spawn して渡す` });
}

// 最後のツール実行 (何を待っているのかを Leader に伝える。Bash の timeout は、正常な長時間実行を待つのにも使う)
function lastTool(tp) {
  let lines; try { lines = fs.readFileSync(tp, 'utf8').split('\n'); } catch { return {}; }
  for (const line of lines.reverse()) {
    if (!line.includes('tool_use')) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.isSidechain || m.type !== 'assistant') continue;
    const t = (m.message?.content ?? []).filter((x) => x.type === 'tool_use').at(-1);
    if (t) return { text: first(`${t.name} ${t.input?.command ?? t.input?.description ?? t.input?.file_path ?? ''}`, 100), timeout: Number(t.input?.timeout) || 0 };
  }
  return {};
}

// Worker の SendMessage の宛先が他の session (claude agents に出るもの) なら止める。subagent 宛ては通す
function guardSend(h) {
  const to = String(h.tool_input?.to ?? '').replace(/\s*\[[^\]]*\]$/, '');
  let peers = [];
  // simplified: 一覧が取れない時は止めない (subagent 宛てまで止めないため)。取りこぼしが問題になったら宛先の形式でも判定する
  try { peers = JSON.parse(claude(['agents', '--json', '--all'])).flatMap((e) => [e.name, e.id, e.sessionId]); } catch { return; }
  if (!peers.includes(to)) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: '[relay] Leader や他の Worker の session とは直接やり取りしない。伝えることは最後の返答 (報告) に書く' } }));
}

// ---- Leader が見るもの ----
function state() {
  let live = null;
  try { live = agents(); } catch { /* claude が使えない時は生存を出さない */ }
  const ws = workers().filter((w) => w.status !== 'removed');
  const lines = ws.map((w) => {
    const e = live?.get(w.shortId);
    const st = w.status === 'retired' ? 'retired (context 上限。後任を relay spawn して引き継ぎ報告を渡す)' : w.status !== 'active' ? w.status : !live ? '?'
      : !e ? 'session が無い (落ちた可能性。relay send で再開)'
      : e.status === 'waiting' ? `waiting: ${e.waitingFor ?? '?'} (relay attach ${w.name} で応答)` : e.status;
    const handover = w.handover && w.status === 'active' ? ' · context 上限、引き継ぎ報告待ち' : '';
    return `${w.name} ${st}${handover}${w.pending.length ? ` pending ${w.pending.length}` : ''}${w.ctx == null ? '' : ` · context ${w.ctx}% (${Math.round((w.ctxTokens ?? 0) / 1000)}k)`} · ${ago(w.updatedAt)} 前\n  指示: ${w.instruction}\n  報告: ${w.lastReport ?? '-'}`;
  });
  const notes = path.join(DIR, 'notes.md');
  console.log(`作業 ${WORK} (管理メモ ${path.relative(process.cwd(), notes)})\n\n${lines.join('\n') || '(Worker なし)'}`);
  if (fs.existsSync(notes)) console.log(`\n## notes\n${fs.readFileSync(notes, 'utf8').trim()}`);
}

// 作業の一覧。引き継ぎ候補は、Leader がいなくなっていて Worker が片付けられずに残っている作業
function list() {
  let live = [];
  try { live = JSON.parse(claude(['agents', '--json'])).filter((e) => e.pid); } catch { /* 生存は出さない */ }
  const rows = units().map((id) => {
    setWork(id);
    const ws = workers().filter((w) => w.status !== 'removed');
    const leaders = Object.keys(leadersOf(id)).map((s) => live.find((e) => e.sessionId === s)).filter(Boolean);
    const lead = leaders.length ? `Leader 稼働中 (${leaders.map((e) => e.name ?? e.sessionId.slice(0, 8)).join(', ')})` : 'Leader 不在';
    const candidate = !leaders.length && ws.length > 0;
    let topic = '';
    try { topic = fs.readFileSync(path.join(DIR, 'notes.md'), 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? ''; } catch { /* メモなし */ }
    const t = fs.statSync(path.join(DIR, 'log.jsonl')).mtime.toISOString();
    return `${id}${candidate ? ' [引き継ぎ候補]' : ''} · ${lead} · Worker ${ws.length} (${ws.map((w) => `${w.name} ${w.status}`).join(', ') || '-'}) · ${ago(t)} 前\n  ${first(topic, 160) || '(管理メモなし)'}`;
  });
  console.log(rows.join('\n') || '(作業なし)');
}

// この session を既存の作業に結びつける (Leader の交代)
function use(id) {
  if (!id || !units().includes(id)) throw new Error(`作業 ${id ?? ''} は無い。relay list で一覧を見る`);
  if (!SID) throw new Error('Claude Code の session の中で実行する (Leader の session を作業に結びつけるため)');
  bind(id);
  console.log(`作業 ${id} を引き継いだ。relay state で現状を見る`);
}

// 人間が端末から Worker を覗く時は、Worker の名前から作業を探す
function byWorker(name) {
  const hits = units().filter((u) => fs.existsSync(path.join(ROOT, u, 'workers', `${name}.json`)));
  if (hits.length !== 1) throw new Error(hits.length ? `${name} は複数の作業にある (${hits.join(', ')})。--work で選ぶ` : `${name} は無い`);
  setWork(hits[0]);
}

function show(name) {
  const w = load(name);
  if (!w) throw new Error(`${name} は無い`);
  const { all } = O;
  const { pending, ...rest } = w;
  console.log(Object.entries(rest).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v ?? '-'}`).join('\n'));
  if (pending.length) console.log(`pending: ${pending.length} 件`);
  const entries = readLog().filter((e) => e.worker === name);
  for (const e of all ? entries : entries.slice(-4)) console.log(`\n--- ${e.ts} ${e.kind}\n${e.text}`);
  if (!all && entries.length > 4) console.log(`\n(古い ${entries.length - 4} 件は --all)`);
}

// 詳細記録の検索: 指示・報告の全文と、Worker と Leader (交代済みも) の transcript
function search(q) {
  if (!q) throw new Error('使い方: relay search <語> [--worker name] [--limit n]');
  const only = O.worker, limit = Number(O.limit ?? 20);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const hits = [];
  const hit = (src, ts, text) => {
    const m = re.exec(text);
    if (m) hits.push(`[${src} ${String(ts ?? '').slice(0, 16)}] …${first(text.slice(Math.max(0, m.index - 100), m.index + 200), 300)}…`);
  };
  for (const e of readLog()) if (!only || e.worker === only) hit(`${e.worker} ${e.kind}`, e.ts, e.text);
  const sources = workers().filter((w) => !only || w.name === only).flatMap((w) => w.transcripts.map((t) => [w.name, t]));
  if (!only) {
    let leaders = {};
    try { leaders = JSON.parse(fs.readFileSync(path.join(DIR, 'leaders.json'), 'utf8')); } catch { /* なし */ }
    const root = path.join(os.homedir(), '.claude', 'projects');
    for (const id of Object.keys(leaders)) {
      for (const d of fs.readdirSync(root)) if (fs.existsSync(path.join(root, d, `${id}.jsonl`))) sources.push([`leader ${id.slice(0, 8)}`, path.join(root, d, `${id}.jsonl`)]);
    }
  }
  // transcript は Claude Code の内部形式。user / assistant の本文だけを見る
  for (const [src, t] of sources) {
    if (!fs.existsSync(t)) continue;
    for (const line of fs.readFileSync(t, 'utf8').split('\n')) {
      if (!line.includes('"message"')) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.isSidechain || !['user', 'assistant'].includes(m.type)) continue;
      const c = m.message?.content;
      const text = typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? (typeof x.content === 'string' ? x.content : '')).join('\n');
      hit(`${src} ${m.type}`, m.timestamp, text);
    }
  }
  console.log(hits.slice(-limit).join('\n') || '(該当なし)');
  if (hits.length > limit) console.log(`(${hits.length} 件中、新しい ${limit} 件。--limit で増やす)`);
}

// 新しい報告か Worker の異常が出るまで待ち、1 行ずつ出して終わる。Leader は background で実行して通知を受ける
async function wait() {
  const cur = cursorFile();
  // Leader が `> /dev/null` で捨てると通知が失われる。cursor を進める前に断る (書けなかった時も進めない)
  const st = fs.fstatSync(1);
  if (st.isCharacterDevice() && st.rdev === fs.statSync('/dev/null').rdev) throw new Error('出力が /dev/null に捨てられている。relay wait は run_in_background で実行し、出力を捨てない');
  const timeout = Number(O.timeout ?? 1800) * 1000;
  let seen = Number(fs.existsSync(cur) ? fs.readFileSync(cur, 'utf8') : readLog().length);
  const t0 = Date.now();
  for (let tick = 0; Date.now() - t0 < timeout; tick++) {
    const all = readLog();
    const lines = all.slice(seen).filter((e) => e.line).map((e) => e.line);
    if (lines.length) {
      fs.writeSync(1, lines.join('\n') + '\n'); // 閉じた pipe なら投げる
      fs.mkdirSync(path.dirname(cur), { recursive: true });
      return fs.writeFileSync(cur, String(all.length));
    }
    seen = all.length;
    if (tick % 15 === 14) checkWorkers(); // 落ちた・承認待ちの Worker は Stop を出さないので、一覧も見る
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('(変化なし)');
}
// Worker の最後の動き。relay 自身の書き込み (updatedAt) では進んだことにならないので、transcript が伸びた時刻を見る
// 前面のコマンドは既定 120 秒で background に移される (Worker は作業を続ける) ので、指示の後に報告が無いまま 2 分 30 秒
// 動きが無ければ、background の処理や subagent が終わらない状態を示す。Bash に長い timeout を指定した実行は正常なので、
// その分は待つ。正当に時間が掛かっているのかは外から見分けられないので、知らせるだけで止めるかどうかは Leader が決める。
// 待たせ続けないよう、止まったままなら同じ間隔で知らせ直す。報告の後の無反応は知らせない (待っているなら報告に書いてある)
const STALL = 150000;
function activityAt(w) {
  try { return new Date(fs.statSync(w.transcripts.at(-1)).mtimeMs).toISOString(); } catch { return w.updatedAt; } // transcript が出る前は起動時刻
}
function stalled(w, tool) {
  const quiet = Date.now() - Date.parse(activityAt(w));
  if (quiet < Math.max(STALL, (tool.timeout ?? 0) + 30000)) return false;
  return !w.stalledAt || Date.now() - Date.parse(w.stalledAt) > STALL;
}

function checkWorkers() {
  let live;
  try { live = agents(); } catch { return; }
  const entries = readLog();
  const unreported = (w) => entries.findLast((e) => e.worker === w.name && ['instruct', 'report'].includes(e.kind))?.kind === 'instruct';
  for (const w of workers()) {
    if (w.status !== 'active') continue;
    const e = live.get(w.shortId);
    if (!e) {
      if (Date.now() - Date.parse(w.updatedAt) < 60000) continue; // 起動直後・supervisor の再起動待ち
      update(w.name, (x) => { x.status = 'dead'; });
      log({ worker: w.name, kind: 'dead', text: 'session が見当たらない', line: `${w.name} dead: session が見当たらない (relay send で再開できる)` });
    } else if (e.status === 'waiting' && w.waitingFor !== e.waitingFor) { // 同じ待ちは 1 回だけ知らせる
      update(w.name, (x) => { x.waitingFor = e.waitingFor; });
      log({ worker: w.name, kind: 'waiting', text: e.waitingFor ?? '', line: `${w.name} waiting: ${e.waitingFor ?? '?'} (relay attach ${w.name} で応答)` });
    } else if (unreported(w) && stalled(w, lastTool(w.transcripts.at(-1)))) { // 進んでいない Worker を知らせる (止めるかどうかは Leader が決める)
      const t = lastTool(w.transcripts.at(-1)).text;
      update(w.name, (x) => { x.stalledAt = now(); });
      log({ worker: w.name, kind: 'stalled', text: t ?? '', line: `${w.name} 反応なし ${ago(activityAt(w))}: 最後のツール実行は ${t || '不明'}`
        + ` (relay show ${w.name} で確認。問い合わせるなら relay stop の後に relay send)` });
    } else {
      if (w.waitingFor) update(w.name, (x) => { delete x.waitingFor; });
      if (w.stalledAt && Date.parse(activityAt(w)) > Date.parse(w.stalledAt)) update(w.name, (x) => { delete x.stalledAt; }); // また動き出した
    }
  }
}

function stop(name, remove) {
  const w = load(name);
  if (!w) throw new Error(`${name} は無い`);
  stopAndWait(w.shortId); // 直後の send で copy にならないよう終了まで待つ
  if (remove) try { claude(['rm', w.shortId]); } catch { /* 既に無い */ }
  const status = remove ? 'removed' : 'stopped';
  update(name, (x) => { x.status = status; });
  log({ worker: name, kind: status, text: '' });
  console.log(`${name} ${status}`);
}

const USAGE = `relay - Leader と Worker の間の proxy と記録装置

  relay list                     作業の一覧と引き継ぎ候補
  relay use <作業>               この session を既存の作業に結びつける (Leader の交代)
  relay spawn <name> "<指示>" [--cwd dir] [--model m] [--permission-mode p]   Worker を起動 (作業が無ければ作る)
  relay send <name> "<指示>"     指示を送る (作業中なら次のツール実行の後に渡す)
  relay state                    Worker の状態 (busy / idle / waiting)・指示・報告の要約と notes.md
  relay show <name> [--all]      Worker の詳細 (指示と報告の全文)
  relay search <語> [--worker n] 詳細記録を検索 (指示・報告・Worker と Leader の会話)
  relay wait [--timeout 秒]      新しい報告か異常まで待って 1 行ずつ出す (background で使う)
  relay attach <name>            Worker の画面に入る (claude attach)
  relay stop <name> | rm <name>  止める / 止めて片付ける

  Leader の session は作業に結びつき、どのコマンドもその作業だけを扱う。
  端末から見る時は --work <作業> で選ぶ (state は省くと全作業、show と attach は Worker の名前から探す)。`;

async function main() {
  const [cmd, a, ...rest] = argv;
  if (cmd === '_hook') return hook(a, rest[0]);
  if (!['list', 'use', 'spawn', 'send', 'state', 'show', 'search', 'wait', 'attach', 'stop', 'rm'].includes(cmd)) return console.log(USAGE);
  if (cmd === 'list') return list();
  if (cmd === 'use') return use(a);
  if (cmd === 'spawn') { // git repo の中なら、記録を git から外す (Leader が先に .relay/ を作ることもある)
    const repo = path.dirname(ROOT), common = git(['rev-parse', '--git-common-dir'], repo);
    const exclude = common && path.resolve(repo, common, 'info', 'exclude');
    if (exclude && !(fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '').split('\n').includes('.relay/')) fs.appendFileSync(exclude, '\n.relay/\n');
    if (!DIR) { // 新しい作業。id を振り、この session を結びつける
      const id = randomUUID().slice(0, 8);
      fs.mkdirSync(path.join(ROOT, id), { recursive: true });
      fs.writeFileSync(path.join(ROOT, id, 'log.jsonl'), '');
      if (SID) bind(id); else setWork(id);
      console.log(`新しい作業 ${id} を始めた${SID ? '' : ` (端末からは --work ${id} で指す)`}`);
    }
  }
  if (!DIR && cmd === 'state') {
    if (SID) console.log('この session はまだ作業に結びついていない。新しい作業なら relay spawn、引き継ぐなら relay use <作業>\n');
    const ids = units();
    if (!SID || !ids.length) return ids.length ? ids.forEach((id, i) => { setWork(id); if (i) console.log('\n'); state(); }) : console.log('(作業なし)');
    return list();
  }
  if (!DIR && ['show', 'attach'].includes(cmd)) byWorker(a);
  if (!DIR) throw new Error('この session はまだ作業に結びついていない。relay list で一覧を見て、新しい作業なら relay spawn、引き継ぐなら relay use <作業>');
  if (cmd === 'spawn') return spawnWorker(a, rest.join(' '));
  if (cmd === 'send') return send(a, rest.join(' '));
  if (cmd === 'state') return state();
  if (cmd === 'show') return show(a);
  if (cmd === 'search') return search([a, ...rest].join(' '));
  if (cmd === 'wait') return wait();
  if (cmd === 'attach') { const w = load(a); if (!w) throw new Error(`${a} は無い`); return spawnSync('claude', ['attach', w.shortId], { stdio: 'inherit', env: cleanEnv() }); }
  if (cmd === 'stop' || cmd === 'rm') return stop(a, cmd === 'rm');
  console.log(USAGE);
}
main().catch((e) => { console.error(`relay: ${e.message}`); process.exit(1); });
