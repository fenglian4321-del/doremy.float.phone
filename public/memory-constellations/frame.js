// Float glue for the MIT MemoryConstellations renderer. See LICENSE and UPSTREAM.md.
// This document has no network or storage access; summaries arrive from its parent.
const send = (type, extra = {}) => parent.postMessage({ type, ...extra }, location.origin);
window.MEMORY_UI_CONFIG = { user: { name: '此刻', color: '#efd3ac' }, ai: { name: '回忆', color: '#b5b9f0' } };

try {
    const data = await import('./data.js');
    const render = await import('./render.js');
    const state = await import('./state.js');
    const canvas = document.getElementById('mc');
    const tooltip = document.getElementById('tooltip');
    const choice = document.getElementById('choice');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let active = true, dirty = true, lastDraw = -Infinity, raf = 0, hovered = null;
    let picks = [];
    render.initRender(document.getElementById('bg'), canvas);

    function redraw() { dirty = true; if (!raf && active && !document.hidden) raf = requestAnimationFrame(loop); }
    function loop(now) {
        raf = 0;
        if (!active || document.hidden) return;
        if (now - lastDraw >= 1000 / 30 && (!reduced.matches || dirty)) {
            if (reduced.matches) {
                state.view.transition = 1;
                const c = render.camera;
                c.scale = c.tScale; c.panX = c.tPanX; c.panY = c.tPanY;
            }
            render.drawFrame(reduced.matches ? 0 : now / 1000, hovered);
            canvas.dataset.level = state.view.level;
            canvas.dataset.settled = String(state.view.transition >= 1 && Math.abs(render.camera.scale - render.camera.tScale) < .01);
            lastDraw = now; dirty = false;
        }
        if (!reduced.matches || dirty) raf = requestAnimationFrame(loop);
    }
    function navigation() {
        const v = state.view;
        document.getElementById('back').disabled = v.level === 'universe';
        document.getElementById('path').textContent = v.level === 'universe' ? '记忆宇宙' : v.level === 'galaxy' ? v.galaxyId + '星系' : data.conById(v.conId)?.label || '记忆星座';
        picks = v.level === 'universe' ? data.GALAXIES.filter(g => data.consOfGalaxy(g.id).length).map(g => ({ label: g.id + '星系', open: () => state.gotoGalaxy(g.id) }))
            : v.level === 'galaxy' ? data.consOfGalaxy(v.galaxyId).map(c => ({ label: c.label + ' · ' + c.stars.length + ' 条', open: () => state.gotoConstellation(c.id) }))
            : (data.conById(v.conId)?.stars || []).map(s => ({ label: s.title || '一段记忆', open: () => selectStar(s.id, v.conId) }));
        choice.replaceChildren(new Option(v.level === 'universe' ? '选择一个星系，开始翻阅' : v.level === 'galaxy' ? '选择一个星座' : '选择一段记忆', ''));
        picks.forEach((p, index) => choice.add(new Option(p.label, String(index))));
        tooltip.hidden = true;
        redraw();
    }
    function selectStar(id, conId) { state.gotoStar(id, conId); send('float-memory-map-select', { id }); }
    state.onViewChange(() => { render.resetCamera(); render.rebuildLayouts(); hovered = null; navigation(); });
    choice.addEventListener('change', () => { if (choice.value !== '') picks[Number(choice.value)]?.open(); });
    document.getElementById('back').onclick = state.goUp;
    document.getElementById('plus').onclick = () => { render.zoomBy(1.2); redraw(); };
    document.getElementById('minus').onclick = () => { render.zoomBy(1 / 1.2); redraw(); };
    document.getElementById('reset').onclick = () => { render.resetCamera(); redraw(); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') state.goUp(); });
    canvas.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); render.zoomBy(e.deltaY < 0 ? 1.11 : 0.9); redraw(); } }, { passive: false });

    const pointers = new Map();
    let moved = false, pinchDistance = 0, pinchScale = 1;
    canvas.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
        canvas.setPointerCapture(e.pointerId);
        if (pointers.size === 1) moved = false;
        if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDistance = Math.hypot(a.x - b.x, a.y - b.y); pinchScale = render.camera.tScale; moved = true; }
    });
    canvas.addEventListener('pointermove', e => {
        const p = pointers.get(e.pointerId);
        if (p) {
            const dx = e.clientX - p.x, dy = e.clientY - p.y;
            if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 4) moved = true;
            p.x = e.clientX; p.y = e.clientY;
            if (pointers.size === 2) { const [a, b] = [...pointers.values()]; if (pinchDistance) render.camera.tScale = Math.min(4, Math.max(.4, pinchScale * Math.hypot(a.x - b.x, a.y - b.y) / pinchDistance)); }
            else if (moved) render.panBy(dx, dy);
        }
        hovered = render.hitTest(e.clientX, e.clientY);
        tooltip.textContent = hovered?.type === 'star' ? hovered.star.title || '记忆碎片' : hovered?.type === 'con' ? hovered.con.label : hovered?.type === 'galaxy' ? hovered.id + '星系' : hovered?.type === 'core' ? '画面中心的装饰双星' : '';
        tooltip.hidden = !tooltip.textContent;
        canvas.style.cursor = hovered ? 'pointer' : 'grab';
        redraw();
    });
    canvas.addEventListener('pointerup', e => {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        if (moved) return;
        const hit = render.hitTest(e.clientX, e.clientY);
        if (hit?.type === 'galaxy') state.gotoGalaxy(hit.id);
        else if (hit?.type === 'con') state.gotoConstellation(hit.id);
        else if (hit?.type === 'star') selectStar(hit.id, state.view.conId);
    });
    canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); moved = true; });
    canvas.addEventListener('pointerleave', () => { if (!pointers.size) { hovered = null; tooltip.hidden = true; redraw(); } });

    window.addEventListener('message', event => {
        if (event.source !== parent || event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
        if (event.data.type === 'float-memory-map-active') { active = event.data.active === true; if (!active) { cancelAnimationFrame(raf); raf = 0; pointers.clear(); } else redraw(); return; }
        if (event.data.type !== 'float-memory-map-data' || !Array.isArray(event.data.entries)) return;
        const entries = event.data.entries.slice(0, 200).filter(e => e && typeof e.id === 'string' && typeof e.name === 'string' && e.id.length <= 512 && e.name.length <= 300 && Array.isArray(e.tags) && Array.isArray(e.domains) && [...e.tags, ...e.domains].every(s => typeof s === 'string' && s.length <= 80));
        data.setEntries(entries); state.gotoUniverse(); render.resetCamera(); render.onDataLoaded(); navigation();
    });
    window.addEventListener('resize', () => { render.resizeRender(); redraw(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else redraw(); });
    reduced.addEventListener('change', redraw);
    navigation(); send('float-memory-map-ready'); redraw();
} catch {
    send('float-memory-map-error');
}
