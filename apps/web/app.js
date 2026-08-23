const $ = (selector) => document.querySelector(selector);
const languageKey = 'workbench-language';
const copy = {
  en: {
    title: 'Workbench Dashboard', eyebrow: 'Agent Workbench', subtitle: 'Reading local workspace state', language: 'Language', refresh: 'Refresh status',
    healthTitle: 'Workspace health', planTitle: 'Plan', resourcesTitle: 'Environment resources', stepsTitle: 'Execution preview',
    evalTitle: 'Evaluation', applyFilters: 'Apply filters', runId: 'Run', noRuns: 'No runs match the filters',
    resource: 'Resource', version: 'Version', status: 'Status', pass: 'PASS', loading: 'Loading', missing: 'missing',
    steps: (count) => `${count} step(s)`, from: (version) => `from ${version}`, error: (status) => `Status request failed (${status})`,
    summary: (s) => `${s.total} run(s) · success ${s.successRate} · avg cost $${s.avgCostUsd ?? '—'} · avg latency ${s.avgLatencyMs ?? '—'} ms`,
    action: { INSTALL: 'INSTALL', UPDATE: 'UPDATE', SKIP: 'SKIP' },
  },
  'zh-CN': {
    title: '工作台仪表盘', eyebrow: '智能体工作台', subtitle: '正在读取本地工作区状态', language: '语言', refresh: '刷新状态',
    healthTitle: '工作区健康度', planTitle: '执行计划', resourcesTitle: '环境资源', stepsTitle: '执行预览',
    evalTitle: '评估', applyFilters: '应用筛选', runId: '运行', noRuns: '没有符合筛选条件的运行',
    resource: '资源', version: '版本', status: '状态', pass: '通过', loading: '加载中', missing: '缺失',
    steps: (count) => `${count} 个步骤`, from: (version) => `原版本 ${version}`, error: (status) => `状态请求失败（${status}）`,
    summary: (s) => `${s.total} 次运行 · 成功率 ${s.successRate} · 平均成本 $${s.avgCostUsd ?? '—'} · 平均延迟 ${s.avgLatencyMs ?? '—'} ms`,
    action: { INSTALL: '安装', UPDATE: '更新', SKIP: '跳过' },
  },
};

let language = localStorage.getItem(languageKey) === 'zh-CN' ? 'zh-CN' : 'en';
const t = () => copy[language];
const text = (value) => document.createTextNode(value == null ? '' : String(value));

function applyLanguage() {
  const words = t();
  document.documentElement.lang = language;
  document.title = words.title;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = words[element.dataset.i18n];
  $('#language-select').value = language;
  $('#language-select').setAttribute('aria-label', words.language);
}

function stepLabel(step) {
  const words = t();
  return `${words.action[step.action] ?? step.action} ${step.resource} ${step.version ?? ''}`.trim();
}

function render(data) {
  const words = t();
  $('#workspace').replaceChildren(text(data.workspace.name));
  $('#subtitle').replaceChildren(text(`${words.subtitle} · ${data.workspace.id}`));
  $('#health').replaceChildren(text(data.health === 'PASS' ? words.pass : data.health));
  $('#plan-count').replaceChildren(text(words.steps(data.plan.steps.length)));
  const resources = $('#resources');
  resources.replaceChildren(...data.resources.map((resource) => {
    const row = document.createElement('tr');
    for (const value of [resource.resource, resource.version ?? words.missing, resource.status]) {
      const cell = document.createElement('td');
      cell.append(text(value));
      row.append(cell);
    }
    return row;
  }));
  const steps = $('#steps');
  steps.replaceChildren(...data.plan.steps.map((step) => {
    const item = document.createElement('div');
    item.className = 'step';
    item.append(text(stepLabel(step)));
    if (step.previous != null) item.append(text(words.from(step.previous)));
    return item;
  }));
}

function renderEvaluation(data) {
  const words = t();
  $('#eval-summary').replaceChildren(text(words.summary(data.summary)));
  const body = $('#eval-rows');
  if (data.rows.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 9;
    cell.append(text(words.noRuns));
    row.append(cell);
    body.replaceChildren(row);
    return;
  }
  body.replaceChildren(...data.rows.map((run) => {
    const row = document.createElement('tr');
    const cells = [
      run.runId, run.workflowId, run.finalStatus ?? '', run.failureClass ?? '',
      (run.agentIds ?? []).join(','), run.cost ?? '', run.latencyMs ?? '', '',
    ];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.append(text(value));
      row.append(cell);
    }
    return row;
  }));
}

async function loadEvaluation() {
  const params = new URLSearchParams();
  for (const [key, selector] of [
    ['agent', '#f-agent'], ['workflow', '#f-workflow'], ['status', '#f-status'],
    ['failureClass', '#f-failure'], ['evaluatorVersion', '#f-evalver'],
    ['minCost', '#f-mincost'], ['maxCost', '#f-maxcost'], ['maxLatencyMs', '#f-maxlat'],
  ]) {
    const value = $(selector).value.trim();
    if (value) params.set(key, value);
  }
  const response = await fetch(`/api/evaluation?${params.toString()}`);
  if (!response.ok) throw new Error(`evaluation request failed (${response.status})`);
  renderEvaluation(await response.json());
}

async function load() {
  $('#error').hidden = true;
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error(t().error(response.status));
    render(await response.json());
    await loadEvaluation();
  } catch (error) {
    $('#error').hidden = false;
    $('#error').textContent = error.message;
  }
}

$('#language-select').addEventListener('change', (event) => {
  language = event.target.value === 'zh-CN' ? 'zh-CN' : 'en';
  localStorage.setItem(languageKey, language);
  applyLanguage();
  load();
});
$('#refresh').addEventListener('click', load);
$('#eval-refresh').addEventListener('click', loadEvaluation);
applyLanguage();
load();
