
// main.js — lógica do painel unificado (dados ao vivo + popups + gráficos)
const $ = (s,sc=document)=> sc.querySelector(s);
const $$ = (s,sc=document)=> Array.from(sc.querySelectorAll(s));
const fmtBR = new Intl.NumberFormat('pt-BR');
const fmtBR2 = new Intl.NumberFormat('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});

let charts = {}; // refs dos charts (sparks e modais)
let state = {
  empresa: null,
  periodo: null,
  cached: {} // cache por módulo { metas: {data, ts}, ... }
};

function savePrefs(){
  localStorage.setItem('dv.empresa', state.empresa || '');
  localStorage.setItem('dv.periodo', state.periodo || '');
}
function loadPrefs(){
  state.empresa = localStorage.getItem('dv.empresa') || (CONFIG.EMPRESAS?.[0] || 'MERCATTO DELICIA');
  const ym = new Date().toISOString().slice(0,7);
  state.periodo = localStorage.getItem('dv.periodo') || ym;
}

// ===== Utils de gráfico =====
function ensureChart(ctx, type, data, options){
  const id = ctx.id || Math.random().toString(36).slice(2);
  if(charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {type, data, options});
  return charts[id];
}
function sparkline(ctx, serie, color='#00d1ff'){
  const g = ctx.getContext('2d').createLinearGradient(0,0,0,60);
  g.addColorStop(0, 'rgba(0,209,255,.35)');
  g.addColorStop(1, 'rgba(255,46,136,.05)');
  return ensureChart(ctx, 'line', {
    labels: serie.map((_,i)=> i+1),
    datasets: [{ data: serie, borderWidth:2, pointRadius:0, tension:.35, fill:true, backgroundColor:g, borderColor:'#00d1ff'}]
  }, {plugins:{legend:{display:false}}, scales:{x:{display:false}, y:{display:false}}});
}

// ===== Fetch genérico =====
async function fetchJSON(url){
  const r = await fetch(url, {method:'GET'});
  if(!r.ok) throw new Error('Falha ao carregar: '+url);
  return r.json();
}

// ===== Adaptadores por módulo (convertendo para KPIs, séries e tabela) =====
const adapters = {
  async metas(empresa, periodo){
    // Esperado: array de objetos {Data, Empresa, Previsto, Realizado}
    const data = await fetchJSON(CONFIG.URLS.METAS);
    const ym = periodo; // 'YYYY-MM'
    const rows = data.filter(x => (!empresa || x.Empresa?.toUpperCase()===empresa) && String(x.Data||'').startsWith(ym));
    let previsto = 0, realizado = 0;
    const serie = [];
    const byDay = new Map();
    for(const r of rows){
      previsto += Number(r.Previsto||0);
      realizado += Number(r.Realizado||0);
      const day = String(r.Data).slice(-2);
      byDay.set(day,(byDay.get(day)||0) + Number(r.Realizado||0));
    }
    const days = Array.from({length:31}, (_,i)=> String(i+1).padStart(2,'0'));
    for(const d of days){
      if(byDay.has(d)) serie.push(byDay.get(d)); else if(serie.length) serie.push(0);
    }
    const perc = previsto>0 ? Math.round((realizado/previsto)*100) : 0;
    const kpis = [
      {label:'Previsto', val:'R$ '+fmtBR.format(previsto)},
      {label:'Realizado', val:'R$ '+fmtBR.format(realizado)},
      {label:'Atingido', val: perc+'%'}
    ];
    const tableHead = ['Data','Previsto','Realizado'];
    const tableRows = rows.slice(-15).map(r => [r.Data, 'R$ '+fmtBR.format(Number(r.Previsto||0)), 'R$ '+fmtBR.format(Number(r.Realizado||0))]);
    return {kpiMain: perc+'%', spark: serie.slice(-12), kpis, chart1:{labels:days, data:serie, label:'Realizado'}, chart2:{labels:['Previsto','Realizado'], data:[previsto,realizado], label:'Comparativo'}, table:{head:tableHead, rows:tableRows}};
  },

  async cancelamentos(empresa, periodo){
    // Esperado: array {empresa, data, item, valor}
    const data = await fetchJSON(CONFIG.URLS.CANCELAMENTOS);
    const ym = periodo;
    const rows = data.filter(x => (!empresa || x.empresa?.toUpperCase()===empresa) && String(x.data||'').startsWith(ym));
    let total = 0;
    const serie = [];
    const byDay = new Map();
    const byItem = new Map();
    for(const r of rows){
      const v = Number(r.valor||0); total += v;
      const day = String(r.data).slice(-2);
      byDay.set(day,(byDay.get(day)||0)+v);
      const item = String(r.item||'OUTROS');
      byItem.set(item,(byItem.get(item)||0)+v);
    }
    const days = Array.from({length:31}, (_,i)=> String(i+1).padStart(2,'0'));
    for(const d of days){ serie.push(byDay.get(d)||0); }
    // Top itens
    const top = Array.from(byItem.entries()).sort((a,b)=> b[1]-a[1]).slice(0,5);
    const kpis = [
      {label:'Total Cancelado', val:'R$ '+fmtBR.format(total)},
      {label:'Qtd Registros', val: fmtBR.format(rows.length)},
      {label:'Ticket Médio', val: 'R$ '+fmtBR.format(rows.length? total/rows.length:0)}
    ];
    const tableHead = ['Data','Item','Valor'];
    const tableRows = rows.slice(-20).map(r => [r.data, r.item, 'R$ '+fmtBR.format(Number(r.valor||0))]);
    return {kpiMain:'R$ '+fmtBR.format(total), spark: serie.slice(-12), kpis,
      chart1:{labels:days, data:serie, label:'Cancelamentos/dia'},
      chart2:{labels:top.map(x=>x[0]), data:top.map(x=>x[1]), label:'Top itens'},
      table:{head:tableHead, rows:tableRows}};
  },

  async travas(empresa, periodo){
    // Formato varia; considerar campos: Empresa/empresa, Data/data, Valor/valor, Categoria/Plano
    const data = await fetchJSON(CONFIG.URLS.TRAVAS);
    const ym = periodo;
    const rows = data.filter(x => (!empresa || (String(x.Empresa||x.empresa||'').toUpperCase()===empresa)) && String(x.Data||x.data||'').startsWith(ym));
    let comprado = 0;
    const byPlano = new Map();
    for(const r of rows){
      const v = Number(r.Valor || r.valor || 0); comprado += v;
      const p = String(r.Plano || r.categoria || r.Categoria || 'OUTROS');
      byPlano.set(p,(byPlano.get(p)||0)+v);
    }
    const top = Array.from(byPlano.entries()).sort((a,b)=> b[1]-a[1]).slice(0,6);
    const kpis = [
      {label:'Já comprado', val:'R$ '+fmtBR.format(comprado)},
      {label:'Planos ativos', val: fmtBR.format(byPlano.size)},
      {label:'Top plano', val: (top[0]?.[0] || '—')}
    ];
    const labels = top.map(x=>x[0]); const values = top.map(x=>x[1]);
    return {kpiMain:'R$ '+fmtBR.format(comprado), spark: values.slice(-12), kpis,
      chart1:{labels, data:values, label:'Compras por plano'},
      chart2:{labels, data:values, label:'Distribuição por plano', type:'doughnut'},
      table:{head:['Plano','Valor'], rows: top.map(t=>[t[0],'R$ '+fmtBR.format(t[1])])}};
  },

  async financeiro(empresa, periodo){
    // ENTRADAS: {Empresa, Data, Categoria, Valor}
    const data = await fetchJSON(CONFIG.URLS.ENTRADAS);
    const ym = periodo;
    const rows = data.filter(x => (!empresa || x.Empresa?.toUpperCase()===empresa) && String(x.Data||'').startsWith(ym));
    let entradas = 0;
    const byCat = new Map(), byDay = new Map();
    for(const r of rows){
      const v = Number(r.Valor||0); entradas += v;
      const c = String(r.Categoria||'OUTROS');
      byCat.set(c,(byCat.get(c)||0)+v);
      const d = String(r.Data).slice(-2);
      byDay.set(d,(byDay.get(d)||0)+v);
    }
    const days = Array.from({length:31}, (_,i)=> String(i+1).padStart(2,'0'));
    const serie = days.map(d => byDay.get(d)||0);
    const top = Array.from(byCat.entries()).sort((a,b)=> b[1]-a[1]).slice(0,6);
    const kpis = [
      {label:'Entradas', val:'R$ '+fmtBR.format(entradas)},
      {label:'Categorias', val: fmtBR.format(byCat.size)},
      {label:'Top categoria', val: (top[0]?.[0]||'—')}
    ];
    return {kpiMain:'R$ '+fmtBR.format(entradas), spark: serie.slice(-12), kpis,
      chart1:{labels:days, data:serie, label:'Entradas por dia'},
      chart2:{labels:top.map(t=>t[0]), data:top.map(t=>t[1]), label:'Por categoria'},
      table:{head:['Categoria','Valor'], rows: top.map(t=>[t[0],'R$ '+fmtBR.format(t[1])])}};
  },

  async delivery(empresa, periodo){
    // {plataforma, empresa, data, bruto, liquido, taxa, repassado, areceber}
    const data = await fetchJSON(CONFIG.URLS.DELIVERY);
    const ym = periodo;
    const rows = data.filter(x => (!empresa || x.empresa?.toUpperCase()===empresa) && String(x.data||'').startsWith(ym));
    let bruto=0, liquido=0;
    const byPlat = new Map(), byDay = new Map();
    for(const r of rows){
      bruto += Number(r.bruto||0); liquido += Number(r.liquido||0);
      const p = String(r.plataforma||'OUTROS');
      byPlat.set(p,(byPlat.get(p)||0)+Number(r.liquido||0));
      const d = String(r.data).slice(-2);
      byDay.set(d,(byDay.get(d)||0)+Number(r.liquido||0));
    }
    const days = Array.from({length:31}, (_,i)=> String(i+1).padStart(2,'0'));
    const serie = days.map(d => byDay.get(d)||0);
    const top = Array.from(byPlat.entries()).sort((a,b)=> b[1]-a[1]).slice(0,5);
    const kpis = [
      {label:'Bruto', val:'R$ '+fmtBR.format(bruto)},
      {label:'Líquido', val:'R$ '+fmtBR.format(liquido)},
      {label:'Plataformas', val: fmtBR.format(byPlat.size)}
    ];
    return {kpiMain:'R$ '+fmtBR.format(liquido), spark: serie.slice(-12), kpis,
      chart1:{labels:days, data:serie, label:'Líquido por dia'},
      chart2:{labels:top.map(t=>t[0]), data:top.map(t=>t[1]), label:'Top plataformas'},
      table:{head:['Plataforma','Líquido'], rows: top.map(t=>[t[0],'R$ '+fmtBR.format(t[1])])}};
  },

  async conciliacao(empresa, periodo){
    // Estrutura variável; considerar {empresa, data, valor, tipo/descricao}
    const data = await fetchJSON(CONFIG.URLS.CONCILIACOES);
    const ym = periodo;
    const rows = data.filter(x => (!empresa || (String(x.empresa||x.Empresa||'').toUpperCase()===empresa)) && String(x.data||x.Data||'').startsWith(ym));
    let mov = 0;
    const byTipo = new Map();
    for(const r of rows){
      const v = Number(r.valor||r.Valor||0); mov += v;
      const t = String(r.tipo||r.Tipo||r.descricao||'OUTROS');
      byTipo.set(t,(byTipo.get(t)||0)+v);
    }
    const top = Array.from(byTipo.entries()).sort((a,b)=> b[1]-a[1]).slice(0,6);
    const kpis = [
      {label:'Movimentado', val:'R$ '+fmtBR.format(mov)},
      {label:'Tipos', val: fmtBR.format(byTipo.size)},
      {label:'Maior tipo', val: (top[0]?.[0]||'—')}
    ];
    return {kpiMain:'R$ '+fmtBR.format(mov), spark: top.map(x=>x[1]).slice(-12), kpis,
      chart1:{labels: top.map(x=>x[0]), data: top.map(x=>x[1]), label:'Por tipo'},
      chart2:{labels: top.map(x=>x[0]), data: top.map(x=>x[1]), label:'Distribuição', type:'doughnut'},
      table:{head:['Tipo','Valor'], rows: top.map(t=>[t[0],'R$ '+fmtBR.format(t[1])])}};
  },

  async pesquisa(empresa, periodo){
    // {empresa, nome, ... notas por critério}
    const data = await fetchJSON(CONFIG.URLS.AVALIACOES);
    const rows = data.filter(x => (!empresa || x.empresa?.toUpperCase()===empresa));
    const count = rows.length;
    const campos = ['ambiente','iluminacao','comida','musica','estilo','atendimento','climatizacao','bebidas'];
    const medias = campos.map(c => {
      const vals = rows.map(r => Number(r[c]||0)).filter(v => !isNaN(v));
      const m = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
      return +m.toFixed(2);
    });
    const kpis = [
      {label:'Respostas', val: fmtBR.format(count)},
      {label:'Média geral', val: (+((medias.reduce((a,b)=>a+b,0)/(medias.length||1))||0)).toFixed(2)},
      {label:'Critérios', val: fmtBR.format(campos.length)}
    ];
    return {kpiMain: 'N/'+'A', spark: medias.slice(-12), kpis,
      chart1:{labels: campos.map(c=>c.toUpperCase()), data: medias, label:'Médias por critério'},
      chart2:{labels: campos.map(c=>c.toUpperCase()), data: medias, label:'Radar', type:'radar'},
      table:{head:['Nome','Cidade','Telefone'], rows: rows.slice(-15).map(r=>[r.nome||'—', r.cidade||'—', r.telefone||'—'])}};
  },

  async midias(empresa, periodo){
    // Usaremos ABC como apoio — ou mantenha Midias sem dados por ora
    const data = await fetchJSON(CONFIG.URLS.ABC);
    const ym = periodo;
    const rows = data.filter(x => (!empresa || x.empresa?.toUpperCase()===empresa) && String(x.data||'').startsWith(ym));
    let faturamento=0, lucro=0;
    const byProd = new Map();
    for(const r of rows){
      faturamento += Number(r.faturamento||0);
      lucro += Number(r.lucro||0);
      const p = String(r.produto||'OUTROS');
      byProd.set(p,(byProd.get(p)||0)+Number(r.faturamento||0));
    }
    const top = Array.from(byProd.entries()).sort((a,b)=> b[1]-a[1]).slice(0,6);
    const kpis = [
      {label:'Faturamento', val:'R$ '+fmtBR.format(faturamento)},
      {label:'Lucro', val:'R$ '+fmtBR.format(lucro)},
      {label:'Produtos', val: fmtBR.format(byProd.size)}
    ];
    return {kpiMain:'R$ '+fmtBR.format(faturamento), spark: top.map(x=>x[1]).slice(-12), kpis,
      chart1:{labels: top.map(t=>t[0]), data: top.map(t=>t[1]), label:'Top produtos'},
      chart2:{labels: ['Faturamento','Lucro'], data:[faturamento, lucro], label:'Resumo'},
      table:{head:['Produto','Faturamento'], rows: top.map(t=>[t[0],'R$ '+fmtBR.format(t[1])])}};
  }
};

// ===== Preenche filtros =====
function fillFilters(){
  const sel = $('#f-empresa');
  sel.innerHTML = CONFIG.EMPRESAS.map(e => `<option value="${e}">${e}</option>`).join('');
  sel.value = state.empresa;
  $('#f-periodo').value = state.periodo;
}

// ===== UI: KPIs no card + spark =====
function setCard(moduleKey, kpiText, sparkData){
  const kpiEl = $('#kpi-'+moduleKey);
  if(kpiEl) kpiEl.textContent = kpiText || '—';
  const sparkEl = $('#spark-'+moduleKey);
  if(sparkEl && sparkData && sparkData.length){
    sparkline(sparkEl, sparkData);
  }
}

// ===== Modal =====
let currentModule = null;
function openModal(modKey, title){
  currentModule = modKey;
  $('#modal-title').textContent = title;
  $('.modal').classList.add('show');
  document.body.style.overflow = 'hidden';

  // filtros do modal
  const sel = $('#m-empresa'); sel.innerHTML = CONFIG.EMPRESAS.map(e=> `<option value="${e}">${e}</option>`).join('');
  sel.value = state.empresa;
  $('#m-periodo').value = state.periodo;

  loadModule(modKey, true);
}
function closeModal(){
  $('.modal').classList.remove('show');
  $('.modal').classList.remove('fullscreen');
  document.body.style.overflow = '';
}

function toggleFull(){
  $('.modal').classList.toggle('fullscreen');
}

// ESC fecha
window.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape' && $('.modal').classList.contains('show')) closeModal();
});

$('#btn-close')?.addEventListener('click', closeModal);
$('#btn-full')?.addEventListener('click', toggleFull);
$('#m-empresa')?.addEventListener('change', ()=> loadModule(currentModule, true));
$('#m-periodo')?.addEventListener('change', ()=> loadModule(currentModule, true));

// ===== Carregar módulo (cards e modal) =====
async function loadModule(modKey, intoModal=false){
  const empresa = intoModal ? $('#m-empresa').value : state.empresa;
  const periodo = intoModal ? $('#m-periodo').value : state.periodo;
  if(!adapters[modKey]) return;

  const start = performance.now();
  const payload = await adapters[modKey](empresa, periodo);
  const took = Math.round(performance.now() - start)+'ms';

  if(!intoModal){
    setCard(modKey, payload.kpiMain, payload.spark);
  }else{
    // KPIs
    const kpisEl = $('#m-kpis');
    kpisEl.innerHTML = (payload.kpis||[]).map(k=> `
      <div class="kpi-box">
        <div class="label">${k.label}</div>
        <div class="val">${k.val}</div>
      </div>
    `).join('');

    // Charts
    const c1 = $('#m-chart-1'), c2 = $('#m-chart-2');
    const type1 = (payload.chart1?.type) || 'line';
    const type2 = (payload.chart2?.type) || 'bar';

    ensureChart(c1, type1, {
      labels: payload.chart1.labels,
      datasets: [{ label: payload.chart1.label, data: payload.chart1.data, borderWidth:2, pointRadius:0, tension:.35 }]
    }, {plugins:{legend:{labels:{color:'#9aa3b8'}}}, scales:{x:{ticks:{color:'#8b93a7'}}, y:{grid:{color:'rgba(255,255,255,.06)'}}}});

    ensureChart(c2, type2, {
      labels: payload.chart2.labels,
      datasets: [{ label: payload.chart2.label, data: payload.chart2.data }]
    }, {plugins:{legend:{labels:{color:'#9aa3b8'}}}, scales:{y:{grid:{color:'rgba(255,255,255,.06)'}}}});

    // Table
    const thead = $('#m-table thead'), tbody = $('#m-table tbody');
    thead.innerHTML = `<tr>${(payload.table?.head||[]).map(h=> `<th>${h}</th>`).join('')}</tr>`;
    tbody.innerHTML = (payload.table?.rows||[]).map(row => `<tr>${row.map(c=> `<td>${c}</td>`).join('')}</tr>`).join('');

    $('#m-update').textContent = new Date().toLocaleString('pt-BR') + ` • ${took}`;
  }
}

// ===== Carregar todos os módulos nos cards =====
async function loadAllModules(){
  await Promise.all([
    loadModule('metas'), loadModule('cancelamentos'), loadModule('travas'),
    loadModule('financeiro'), loadModule('delivery'), loadModule('conciliacao'),
    loadModule('pesquisa'), loadModule('midias')
  ]);
}

// ===== Eventos dos cards =====
function bindCards(){
  $$('.mod').forEach(btn => {
    btn.addEventListener('click', ()=>{
      const key = btn.getAttribute('data-module');
      const map = {
        metas: 'Metas', cancelamentos:'Cancelamentos', travas:'Travas de Compras',
        financeiro:'Resumo Financeiro', delivery:'Vendas em Delivery', conciliacao:'Conciliação Bancária',
        pesquisa:'Pesquisa de Satisfação', midias:'Mídias / ABC'
      };
      openModal(key, map[key]||'Módulo');
    });
  });
}

// ===== Timeline e dias (gráficos gerais vazios até termos uma fonte) =====
function initGeneralCharts(){
  ensureChart($('#line-global'), 'line', { labels: [], datasets: [{label:'Série', data:[], borderWidth:2, pointRadius:0, tension:.35}]},
    {plugins:{legend:{labels:{color:'#9aa3b8'}}}, scales:{x:{ticks:{color:'#8b93a7'}}, y:{grid:{color:'rgba(255,255,255,.06)'}}}});
  ensureChart($('#bar-days'), 'bar', { labels: ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'], datasets: [{label:'Eventos', data:[0,0,0,0,0,0,0]}]},
    {plugins:{legend:{labels:{color:'#9aa3b8'}}}, scales:{y:{grid:{color:'rgba(255,255,255,.06)'}}}});
}

// ===== Boot =====
window.addEventListener('DOMContentLoaded', async ()=>{
  loadPrefs();
  fillFilters();
  initGeneralCharts();

  // Atualizar preferências
  $('#f-empresa').addEventListener('change', (e)=>{ state.empresa = e.target.value; savePrefs(); loadAllModules(); });
  $('#f-periodo').addEventListener('change', (e)=>{ state.periodo = e.target.value; savePrefs(); loadAllModules(); });
  $('#btn-refresh').addEventListener('click', ()=> loadAllModules());

  // Vincula cards
  bindCards();

  // Carrega todos os módulos ao abrir
  await loadAllModules();
  $('#last-update').textContent = new Date().toLocaleString('pt-BR');

  // Exibe app e oculta loader
  $('#app').style.display = '';
  $('#loader').style.display = 'none';
});
