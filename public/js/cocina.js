// JS de Cocina: muestra cola y permite avanzar estados
// Relacionado con: views/cocina.ejs, routes/cocina.js, routes/mesas.js

$(function(){
  let allItems = Array.isArray(window.__COCINA_ITEMS__) ? window.__COCINA_ITEMS__ : [];
  let autoRefreshTimer = null;

  function setText(id, value){
    const el = document.getElementById(id);
    if(el) el.textContent = String(value);
  }

  function escapeHtml(s){
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function parseDate(val){
    if(!val) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }

  function timeAgo(date){
    if(!date) return '';
    const diffMs = Date.now() - date.getTime();
    const mins = Math.max(0, Math.floor(diffMs / 60000));
    if(mins < 1) return 'justo ahora';
    if(mins < 60) return `hace ${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `hace ${hrs} h ${rem} min` : `hace ${hrs} h`;
  }

  // Permitir abrir directamente pestaña con ?tab=listos|preparando|enviados
  function activarTabDesdeQuery(){
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const map = {
      enviados: '#tabEnviados-tab',
      preparando: '#tabPreparando-tab',
      listos: '#tabListos-tab'
    };
    const sel = map[String(tab || '').toLowerCase()];
    if(!sel) return;
    const triggerEl = document.querySelector(sel);
    if(triggerEl) new bootstrap.Tab(triggerEl).show();
  }

  async function cargarCola(){
    const resp = await fetch('/api/cocina/cola');
    const items = await resp.json();
    allItems = Array.isArray(items) ? items : [];
    render();
  }

  function estadoUI(estado){
    if(estado === 'enviado') return { border:'primary', badge:'primary', label:'Enviado', icon:'bi-send' };
    if(estado === 'preparando') return { border:'warning', badge:'warning', label:'Preparando', icon:'bi-fire' };
    if(estado === 'listo') return { border:'success', badge:'success', label:'Listo', icon:'bi-check2-circle' };
    return { border:'secondary', badge:'secondary', label:estado || '—', icon:'bi-question-circle' };
  }

  function cardItem(it){
    const ui = estadoUI(it.estado);
    const ref = parseDate(it.enviado_at) || parseDate(it.created_at);
    const hora = ref ? ref.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const mesa = escapeHtml(it.mesa_numero);
    const producto = escapeHtml(it.producto_nombre);
    const nota = (it.nota || '').trim();
    const qty = Number(it.cantidad || 0);

    const actions = `
      <div class="d-flex gap-2 flex-wrap justify-content-end mt-2">
        ${it.estado==='enviado' ? `<button class="btn btn-sm btn-primary" data-action="prep" data-id="${it.id}"><i class="bi bi-play me-1"></i>Preparar</button>`:''}
        ${it.estado==='preparando' ? `<button class="btn btn-sm btn-success" data-action="listo" data-id="${it.id}"><i class="bi bi-check2 me-1"></i>Marcar listo</button>`:''}
        ${it.estado==='listo' ? `<button class="btn btn-sm btn-outline-dark" data-action="servido" data-id="${it.id}"><i class="bi bi-box-seam me-1"></i>Entregado</button>`:''}
      </div>`;

    return `
      <div class="card cocina-card border-start border-4 border-${ui.border}">
        <div class="card-body">
          <div class="d-flex justify-content-between gap-2">
            <div class="flex-grow-1">
              <div class="d-flex align-items-center gap-2 flex-wrap mb-1">
                <span class="badge text-bg-dark"><i class="bi bi-grid-3x3-gap me-1"></i>Mesa ${mesa}</span>
                <span class="badge text-bg-${ui.badge}"><i class="bi ${ui.icon} me-1"></i>${ui.label}</span>
                <span class="meta">${hora ? `${hora} · ${timeAgo(ref)}` : timeAgo(ref)}</span>
              </div>
              <div class="product-name">${producto}</div>
              ${nota ? `<div class="cocina-note mt-2"><i class="bi bi-exclamation-triangle me-1"></i>${escapeHtml(nota)}</div>` : ''}
            </div>
            <div class="text-end">
              <div class="fs-6 fw-bold">
                <span class="badge text-bg-secondary">x${qty}</span>
              </div>
            </div>
          </div>
          ${actions}
        </div>
      </div>`;
  }

  function getBusqueda(){
    const q = (document.getElementById('buscarCocina')?.value || '').trim().toLowerCase();
    return q;
  }

  function filtrar(items){
    const q = getBusqueda();
    if(!q) return items;
    return items.filter(it => {
      const mesa = String(it.mesa_numero || '').toLowerCase();
      const prod = String(it.producto_nombre || '').toLowerCase();
      const nota = String(it.nota || '').toLowerCase();
      return mesa.includes(q) || prod.includes(q) || nota.includes(q);
    });
  }

  function setEmpty(id, show){
    const el = document.getElementById(id);
    if(!el) return;
    el.classList.toggle('d-none', !show);
  }

  function render(){
    const enviadosEl = $('#listaEnviados').empty();
    const preparandoEl = $('#listaPreparando').empty();
    const listosEl = $('#listaListos').empty();

    const items = filtrar(allItems);
    const enviados = items.filter(it => it.estado === 'enviado');
    const preparando = items.filter(it => it.estado === 'preparando');
    const listos = items.filter(it => it.estado === 'listo');

    // KPIs (contadores globales sin filtro, más útiles)
    const cEnviados = allItems.filter(it => it.estado === 'enviado').length;
    const cPreparando = allItems.filter(it => it.estado === 'preparando').length;
    const cListos = allItems.filter(it => it.estado === 'listo').length;
    setText('countEnviados', cEnviados);
    setText('countPreparando', cPreparando);
    setText('countListos', cListos);
    setText('pillEnviados', cEnviados);
    setText('pillPreparando', cPreparando);
    setText('pillListos', cListos);

    enviados.forEach(it => enviadosEl.append(cardItem(it)));
    preparando.forEach(it => preparandoEl.append(cardItem(it)));

    // Listos: agrupar por mesa (más intuitivo para entrega)
    const porMesa = new Map();
    listos.forEach(it => {
      const k = String(it.mesa_numero ?? '');
      if(!porMesa.has(k)) porMesa.set(k, []);
      porMesa.get(k).push(it);
    });
    [...porMesa.entries()].sort((a,b)=> String(a[0]).localeCompare(String(b[0]))).forEach(([mesa, arr]) => {
      const header = `
        <div class="d-flex align-items-center justify-content-between mt-2">
          <div class="fw-semibold"><i class="bi bi-grid-3x3-gap me-1"></i>Mesa ${escapeHtml(mesa)}</div>
          <span class="badge text-bg-success">Listos: ${arr.length}</span>
        </div>`;
      listosEl.append(header);
      arr.forEach(it => listosEl.append(cardItem(it)));
    });

    setEmpty('emptyEnviados', enviados.length === 0);
    setEmpty('emptyPreparando', preparando.length === 0);
    setEmpty('emptyListos', listos.length === 0);
  }

  // Acciones
  $(document).on('click','[data-action="prep"]', async function(){
    const id = this.dataset.id;
    await fetch(`/api/cocina/item/${id}/estado`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ estado:'preparando' }) });
    await cargarCola();
  });
  $(document).on('click','[data-action="listo"]', async function(){
    const id = this.dataset.id;
    await fetch(`/api/cocina/item/${id}/estado`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ estado:'listo' }) });
    await cargarCola();
  });

  $(document).on('click','[data-action="servido"]', async function(){
    const id = this.dataset.id;
    await fetch(`/api/mesas/items/${id}/estado`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ estado:'servido' }) });
    await cargarCola();
  });

  function startAutoRefresh(){
    stopAutoRefresh();
    autoRefreshTimer = setInterval(cargarCola, 5000);
  }
  function stopAutoRefresh(){
    if(autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  // UI: buscador + refresh + auto
  $('#buscarCocina').on('input', function(){ render(); });
  $('#btnRefreshCocina').on('click', async function(){ await cargarCola(); });
  $('#toggleAutoRefresh').on('change', function(){
    const enabled = !!this.checked;
    localStorage.setItem('cocina:autoRefresh', enabled ? '1' : '0');
    if(enabled) startAutoRefresh(); else stopAutoRefresh();
  });

  // Estado inicial auto-refresh
  const saved = localStorage.getItem('cocina:autoRefresh');
  if(saved === '0'){
    const el = document.getElementById('toggleAutoRefresh');
    if(el) el.checked = false;
    stopAutoRefresh();
  } else {
    startAutoRefresh();
  }

  // Render inicial + refresh
  render();
  cargarCola();
  activarTabDesdeQuery();
});


