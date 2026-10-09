import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { RunEvent, StageId } from '@sdlc-runner/shared';
import { symlinkEscape } from '../approval/symlink.ts';
import type { WitokPaths } from '../artifacts/paths.ts';

export interface FlowEntry {
  id: string;
  at: string;
  invocation: string | null;
  stage: string | null;
  kind: string;
  from: string;
  to: string;
  payload: unknown;
}
export interface FlowReport { version: 1; slug: string; runId: string; entries: FlowEntry[] }

/** Все копии данных для человека: текущий архив и архивы прежних сессий витка. */
export function flowReadDenied(paths: WitokPaths, currentRunId: string): string[] {
  const root = join(paths.runnerDir, 'flow');
  const ids = new Set([currentRunId]);
  if (symlinkEscape(paths.projectRoot, root, []) === null && existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) ids.add(entry.name);
  }
  return [join(paths.runnerDir, 'flow.html'), ...[...ids].flatMap(id =>
    [join(root, id, 'index.html'), join(root, id, 'trace.ndjson')])]
    .map(path => relative(paths.projectRoot, path).replace(/\\/g, '/'));
}
function actorsFor(kind: string): [string, string] {
  const actors: Record<string, [string, string]> = { prompt_prepared: ['Рантайм', 'Модель'], model_exchange: ['Рантайм', 'Модель'],
    tool_request: ['Модель', 'Политика'], tool_resolved: ['Политика / человек', 'Инструмент'], tool_result: ['Инструмент', 'Модель'],
    human_questions: ['Модель / рантайм', 'Человек'], human_answers: ['Человек', 'Рантайм'], question_validation: ['JSON ответа', 'Проверка рантайма'] };
  return actors[kind] ?? ['Рантайм', 'Рантайм'];
}
interface Snapshot { hash: string | null; text: string; bytes: number; truncated: boolean; mtimeMs?: number }

/** One exact replacement hunk after trimming equal prefix/suffix lines. */
export function flowTextDiff(before: string, after: string): string {
  if (before === after) return '';
  const oldLines = before === '' ? [] : before.split('\n');
  const newLines = after === '' ? [] : after.split('\n');
  let from = 0;
  while (from < oldLines.length && from < newLines.length && oldLines[from] === newLines[from]) from++;
  let oldEnd = oldLines.length; let newEnd = newLines.length;
  while (oldEnd > from && newEnd > from && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const removed = oldLines.slice(from, oldEnd); const added = newLines.slice(from, newEnd);
  return [`@@ -${removed.length ? from + 1 : from},${removed.length} +${added.length ? from + 1 : from},${added.length} @@`,
    ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n');
}

/** Detailed local archive. API keys/HTTP headers never enter this recorder. */
export class RunFlowRecorder {
  readonly dir: string;
  private invocation: string | null = null;
  private stage: StageId | null = null;
  private entered = false;
  private readonly watched = new Map<string, Snapshot | null>();
  private readonly entries: FlowEntry[] = [];
  private readonly paths: WitokPaths;
  private readonly runId: string;
  constructor(paths: WitokPaths, runId: string) {
    this.paths = paths; this.runId = runId;
    this.dir = join(paths.dir, '.runner', 'flow', runId);
  }
  beginStage(stage: StageId, payload: unknown): void {
    this.invocation = randomUUID(); this.stage = stage; this.entered = true; this.watched.clear();
    this.record('stage_entered', payload);
  }
  record(kind: string, payload: unknown, from = 'Рантайм', to = 'Рантайм', stage: string | null = this.stage): void {
    try {
      const entry: FlowEntry = { id: randomUUID(), at: new Date().toISOString(), invocation: stage === this.stage ? this.invocation : null, stage, kind, from, to, payload };
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, 'trace.ndjson'), JSON.stringify(entry) + '\n');
      this.entries.push(entry);
    } catch (error) { console.error(`[flow] ${(error as Error).message}`); }
  }
  event(event: RunEvent): void {
    if (event.type === 'thinking' || event.type === 'assistant_text') return;
    if (event.type === 'stage_started') {
      if (!this.entered) { this.invocation = randomUUID(); this.stage = event.stage; this.watched.clear(); }
      this.entered = false;
    }
    const [from, to] = actorsFor(event.type);
    this.record(event.type, event, from, to, 'stage' in event ? event.stage ?? this.stage : this.stage);
  }
  private snapshot(path: string): Snapshot | null {
    const root = this.paths.projectRoot;
    const absolute = resolve(root, path);
    const back = relative(root, absolute);
    if (isAbsolute(back) || back === '..' || back.startsWith('..\\') || back.startsWith('../') || symlinkEscape(root, absolute, []) !== null) return null;
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
    const bytes = statSync(absolute).size;
    // Avoid loading binaries or huge files just to render a diagram.
    if (bytes > 1_000_000) return { hash: null, text: 'Файл больше 1 MB: содержимое и хэш не записаны; изменение отслеживается по размеру и времени записи.', bytes, truncated: true, mtimeMs: statSync(absolute).mtimeMs };
    const buffer = readFileSync(absolute);
    return { hash: createHash('sha256').update(buffer).digest('hex'), text: buffer.subarray(0, 128000).toString('utf8'), bytes, truncated: bytes > 128000 };
  }
  watch(files: readonly string[]): void {
    for (const file of files) {
      const path = resolve(this.paths.projectRoot, file);
      if (path.includes(`${join('.runner', 'flow')}`)) continue;
      if (!this.watched.has(path)) {
        try { this.watched.set(path, this.snapshot(path)); }
        catch (error) { this.record('snapshot_unavailable', { path: file, reason: (error as Error).message }); }
      }
    }
  }
  changes(requestId?: string): void {
    for (const [path, before] of this.watched) {
      try {
        const after = this.snapshot(path);
        if (before?.hash !== after?.hash || before?.bytes !== after?.bytes || before?.mtimeMs !== after?.mtimeMs) this.record('file_change', {
          path: relative(this.paths.projectRoot, path).replace(/\\/g, '/'), before, after,
          diff: flowTextDiff(before?.text ?? '', after?.text ?? ''), diffTruncated: before?.truncated === true || after?.truncated === true,
          ...(requestId === undefined ? {} : { requestId }), attribution: requestId ? 'Наблюдение после инструмента' : 'Наблюдение между снимками этапа',
        }, 'Файлы до', 'Файлы после');
        this.watched.set(path, after);
      } catch (error) { this.record('snapshot_unavailable', { path, reason: (error as Error).message }); }
    }
  }
  writeHtml(): string {
    const path = join(this.dir, 'index.html');
    mkdirSync(dirname(path), { recursive: true });
    const html = this.html();
    writeFileSync(path, html, 'utf8');
    writeFileSync(join(this.paths.dir, '.runner', 'flow.html'), html, 'utf8');
    return path;
  }
  html(): string {
    return renderRunFlow({ version: 1, slug: this.paths.slug, runId: this.runId, entries: this.entries });
  }
}

export function readFlowTrace(path: string, slug = 'run', runId = 'import'): FlowReport {
  const entries: FlowEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n').filter(line => line.trim())) {
    try { entries.push(JSON.parse(line) as FlowEntry); }
    catch { /* A crash may leave a partial final line; preserve complete records. */ }
  }
  return { version: 1, slug, runId, entries };
}

/** Import old event logs honestly: capped exchanges and missing snapshots stay labelled. */
export function flowFromEvents(events: readonly RunEvent[], slug: string): FlowReport {
  let active: { id: string; stage: string; runId: string; started: boolean; closed: boolean } | null = null;
  const entries: FlowEntry[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'thinking' || event.type === 'assistant_text') continue;
    if (event.type === 'run_started') active = null;
    const stage = 'stage' in event ? event.stage ?? null : null;
    if (stage !== null && (active === null || active.stage !== stage || active.runId !== event.runId || active.closed ||
      (event.type === 'stage_started' && active.started))) {
      active = { id: `stage-${index}`, stage, runId: event.runId, started: false, closed: false };
    }
    const invocation = stage === null ? null : active!.id;
    if (stage !== null && (event.type === 'stage_done' || event.type === 'error') && !active!.started) {
      entries.push({ id: `entry-${index}`, at: '', invocation, stage, kind: 'stage_entered', from: 'Архив', to: 'Рантайм',
        payload: { note: 'Исход до stage_started: пропуск или блокировка входа' } });
    }
    if (event.type === 'stage_started') active!.started = true;
    const [from, to] = actorsFor(event.type);
    entries.push({ id: `event-${index}`, at: 'at' in event ? String(event.at) : '', invocation, stage,
      kind: event.type, from, to, payload: event });
    if (stage !== null && (event.type === 'stage_done' || event.type === 'error')) active!.closed = true;
  }
  entries.unshift({ id: 'archive-limit', at: '', invocation: null, stage: null, kind: 'archive_limit', from: 'Архив', to: 'Отчёт',
    payload: { note: 'Импорт старой ленты: обмены могут быть обрезаны. Полные HTTP-запросы и снимки файлов отсутствуют, если их не записывали во время прогона.' } });
  return { version: 1, slug, runId: events[0]?.runId ?? 'events-import', entries };
}

export function renderRunFlow(report: FlowReport): string {
  const data = JSON.stringify(report).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Схема прогона SDLC</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#10151e;color:#e8eef7}*{box-sizing:border-box}body{margin:0}header{padding:24px;border-bottom:1px solid #354258}h1{font-size:23px;margin:0 0 10px}p{color:#b7c6db}main{display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px;padding:24px}nav{position:sticky;top:12px;align-self:start;max-height:92vh;overflow:auto}button,input,select{font:inherit;color:inherit;background:#202b3c;border:1px solid #455572;border-radius:6px;padding:8px}button{cursor:pointer;text-align:left}nav button{display:block;width:100%;margin:8px 0}button.active{border-color:#7bbcff;background:#284065}.edge{color:#91aed0;text-align:center;margin:5px}.node{border:1px solid #43516b;border-left:4px solid #78aef4;border-radius:7px;padding:12px;background:#182130}.node.bad{border-left-color:#f28b82}.node.changed{border-left-color:#ffc266}.node.ready{border-left-color:#74d6aa}.node small{color:#9fb2ce}.node summary{cursor:pointer;font-weight:600}.node pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,Consolas,monospace;max-height:650px;overflow:auto;background:#101620;padding:12px;border-radius:5px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.muted{color:#9fb2ce}.stats{display:flex;gap:16px;flex-wrap:wrap}a{color:#8cc4ff}.chain{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pill{background:#243249;border-radius:5px;padding:7px}#timeline{max-width:1400px}.empty{padding:16px}@media(max-width:850px){main{grid-template-columns:1fr}nav{position:static;max-height:none}.columns{grid-template-columns:1fr}}
</style>
<header><h1 id="title"></h1><div id="meta" class="muted"></div><p>Слева — фактические входы в этапы. Выберите этап, чтобы увидеть передачи данных, решения и изменения файлов. Стрелки внутри карточки показывают отправителя и получателя; порядок карточек — порядок записи, параллельные вызовы связываются по requestId.</p><div id="stats" class="stats"></div></header>
<main><nav id="stages"></nav><section><div class="toolbar"><input id="search" placeholder="Поиск по данным, пути, requestId"><select id="filter"><option value="all">Все передачи</option><option value="decision">Решения</option><option value="model">Модель</option><option value="tool">Инструменты</option><option value="file">Изменения файлов</option><option value="problem">Проблемы</option></select><button id="expand">Раскрыть данные</button></div><div id="chain" class="chain"></div><div id="timeline"></div></section></main>
<script id="flow-data" type="application/json">${data}</script>
<script>
'use strict';
const report=JSON.parse(document.getElementById('flow-data').textContent);const entries=report.entries;let selected='all';
const names={bench_command:'Команда запуска стенда',bench_validation:'Итог проверок стенда',stage_entered:'Вход в этап',stage_started:'Начало исполнения',stage_done:'Исход этапа',executor_result:'Ответ исполнителя этапа',prompt_prepared:'Подготовленный вход этапа',model_request:'Передача запроса модели',model_http:'Ответ модели / HTTP-результат',model_exchange:'Краткий обмен с моделью',tool_request:'Предложение вызова',tool_resolved:'Решение политики / человека',tool_result:'Результат инструмента',tool_data:'Полные данные результата инструмента',decision_check:'Проверка решения',file_change:'Изменение файла',warning:'Предупреждение',error:'Ошибка',human_questions:'Вопрос человеку',human_answers:'Ответ человека',archive_limit:'Ограничение старого архива'};
const json=x=>JSON.stringify(x,null,2);const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
names.question_validation='Проверка JSON ответа';
document.getElementById('title').textContent='Схема прогона: '+report.slug;document.getElementById('meta').textContent='Run '+report.runId+' · автономный HTML · данные сохранены локально';
const bad=e=>e.kind==='error'||e.kind==='archive_limit'||e.payload?.ok===false||e.payload?.accepted===false||e.payload?.status==='blocked'||e.payload?.decision?.allowed===false||(e.kind==='model_http'&&(e.payload.status>=400||e.payload.status===0));
const counts=[['Передач',entries.length],['Запросов модели',entries.filter(e=>e.kind==='model_request').length],['Пересмотров',entries.filter(e=>e.kind==='decision_check'&&e.payload.changed).length],['Изменений файлов',entries.filter(e=>e.kind==='file_change').length],['Проблем',entries.filter(bad).length]];
counts.forEach(([name,n])=>document.getElementById('stats').append(el('span',name+': '+n)));
const groups=[];for(const e of entries)if(['stage_entered','stage_started'].includes(e.kind)&&!groups.some(g=>g.id===e.invocation))groups.push({id:e.invocation,name:e.stage,chunk:e.payload.chunk,attempt:e.payload.attempt});
const nav=document.getElementById('stages');function navButton(id,label){const b=el('button',label);b.dataset.group=id;b.onclick=()=>{selected=id;render()};nav.append(b)}navButton('all','Весь прогон');groups.forEach((g,i)=>{const done=entries.findLast(e=>e.invocation===g.id&&e.kind==='stage_done');const failed=entries.some(e=>e.invocation===g.id&&e.kind==='error');navButton(g.id,(i+1)+'. '+g.name+' '+(done?(done.payload.ok?'✓':'✗'):failed?'✗':'…')+' · '+(g.chunk||1)+'/'+(g.attempt||1))});
function accepts(e){const f=document.getElementById('filter').value;const q=document.getElementById('search').value.toLowerCase();if(selected!=='all'&&e.invocation!==selected)return false;if(q&&!json(e).toLowerCase().includes(q))return false;if(f==='all')return true;if(f==='problem')return bad(e)||e.kind==='warning';if(f==='decision')return e.kind==='decision_check';if(f==='file')return e.kind==='file_change';if(f==='model')return ['model_request','model_http','model_exchange','prompt_prepared'].includes(e.kind);if(f==='tool')return e.kind.startsWith('tool_')||e.kind.startsWith('human_');return false}
function section(node,title,data){node.append(el('h4',title));node.append(el('pre',typeof data==='string'?data:json(data)))}
function questionOf(request){try{const message=request?.messages?.findLast(m=>m.role==='user');return JSON.parse(message?.content)}catch{return null}}
function questionView(node,request,entry){const q=questionOf(request);if(!q?.questionId)return;
  node.append(el('p','Вопрос → Данные → Ответ JSON → Проверка рантайма → Документ','edge'));
  section(node,'Вопрос '+q.questionId,q.question||q.questionId);
  const {questionId,question,version,...rest}=q;section(node,'Данные для этого решения',q.data??rest);
  if(request?.response_format)section(node,'Схема ожидаемого ответа',request.response_format);
  const responseIndex=entries.findIndex(e=>e.kind==='model_http'&&e.payload?.requestId===entry.payload?.requestId);
  const nextResponse=entries.findIndex((e,i)=>i>responseIndex&&e.kind==='model_http'&&e.invocation===entry.invocation&&questionOf(e.payload?.request)?.questionId===q.questionId);
  const validations=entries.filter((e,i)=>responseIndex>=0&&i>responseIndex&&(nextResponse<0||i<nextResponse)&&e.kind==='question_validation'&&e.payload?.questionId===q.questionId&&e.invocation===entry.invocation);
  validations.forEach(e=>section(node,e.payload.accepted?'Проверка JSON пройдена':'Ответ отклонён',e.payload.reason));
}
function render(){
  nav.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.group===selected));
  const chain=document.getElementById('chain');chain.replaceChildren();
  groups.filter(g=>selected==='all'||g.id===selected).forEach((g,i)=>{
    if(i)chain.append(el('span','→'));const b=el('button',g.name,'pill');
    b.onclick=()=>{selected=g.id;render()};chain.append(b);
  });
  const timeline=document.getElementById('timeline');timeline.replaceChildren();const list=entries.filter(accepts);
  if(!list.length)timeline.append(el('div','Нет записей для выбранного фильтра','empty'));
  list.forEach(entry=>{
    const p=entry.payload||{};timeline.append(el('div',entry.from+' → '+entry.to,'edge'));
    const node=el('details',undefined,'node'+(bad(entry)?' bad':p.changed?' changed':p.status==='ready'?' ready':''));
    node.id='entry-'+entry.id;const title=names[entry.kind]||entry.kind;
    node.dataset.invocation=entry.invocation||'';
    const extra=entry.kind==='decision_check'?': '+p.decision:entry.kind==='file_change'?': '+p.path:
      entry.kind==='tool_result'?': '+p.summary:entry.kind==='model_http'||entry.kind==='model_request'?': '+p.model+' / '+p.mode:'';
    node.append(el('summary',title+extra));
    node.append(el('small',(entry.stage||'прогон')+' · '+(entry.at||'время не записано')+' · '+(p.requestId||entry.id)));
    if(entry.kind==='file_change'){
      node.append(el('p',p.attribution+'; показаны реальные снимки.'));
      if(p.diff)section(node,p.diffTruncated?'Изменение показанного фрагмента (снимок обрезан)':'Изменённые строки',p.diff);
      const cols=el('div',undefined,'columns');
      for(const [name,snapshot]of [['До',p.before],['После',p.after]]){
        const column=el('div');section(column,name,snapshot===null?'Файл отсутствует':snapshot?.text??'Снимок недоступен');
        if(snapshot?.truncated)column.append(el('p','Содержимое обрезано; полный размер '+snapshot.bytes+' байт'));
        if(snapshot?.hash)column.append(el('small','hash: '+snapshot.hash));cols.append(column);
      }
      node.append(cols);
    }else if(entry.kind==='model_http'){
      questionView(node,p.request,entry);
      section(node,'Фактическое тело запроса (после сборки параметров)',p.request);
      let response=p.response;try{response=JSON.parse(response)}catch{}
      section(node,'Фактический ответ сервера',response);
      const content=response?.choices?.[0]?.message?.content;if(content){let answer=content;try{answer=JSON.parse(content)}catch{}section(node,'Ответ модели на вопрос',answer)}
      section(node,'Маршрут и HTTP-результат',{provider:p.provider,model:p.model,status:p.status,durationMs:p.durationMs,mode:p.mode});
    }else if(entry.kind==='model_request'){questionView(node,p.request,entry);section(node,'Фактический запрос',p)}
    else if(entry.kind==='question_validation'){section(node,p.accepted?'JSON принят по схеме':'JSON отклонён',p);node.append(el('p','Приём JSON по схеме не заменяет проверки содержимого и результата этапа.'))}
    else section(node,'Переданные данные',p);
    if(p.requestId){
      const related=entries.filter(e=>e.id!==entry.id&&e.payload?.requestId===p.requestId);
      if(related.length){
        node.append(el('h4','Связанные передачи этого вызова'));
        related.forEach(e=>{
          const a=el('a',(names[e.kind]||e.kind)+' ');a.href='#entry-'+e.id;
          a.onclick=()=>{
            document.getElementById('filter').value='all';document.getElementById('search').value='';render();
            const target=document.getElementById('entry-'+e.id);if(target)target.open=true;
          };node.append(a);
        });
      }
    }
    timeline.append(node);
  });
}
document.getElementById('search').oninput=render;document.getElementById('filter').onchange=render;document.getElementById('expand').onclick=()=>document.querySelectorAll('#timeline details').forEach(d=>d.open=true);render();
</script></html>`;
}
