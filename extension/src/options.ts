import { RouteSchema, type Route } from '../../shared/config-schema';

const DEFAULT_ROUTES: Route[] = [
  { name: 'Payroll dev', urlPattern: 'http://{workspace}.payroll.localhost/*', tabName: 'main', paneName: 'agent' },
];

let routes: Route[] = [];

const listEl = document.getElementById('routes')!;
const savedEl = document.getElementById('saved')!;

function escAttr(s: string | null | undefined): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function val(card: Element, sel: string): string {
  return (card.querySelector(sel) as HTMLInputElement).value.trim();
}

// Pull current input values back into `routes` (so edits survive add/remove).
function collect(): void {
  routes = Array.from(listEl.querySelectorAll('.route')).map((card) => ({
    name: val(card, '.f-name'),
    urlPattern: val(card, '.f-url'),
    tabName: val(card, '.f-tab') || 'main',
    paneName: val(card, '.f-pane') || 'agent',
  }));
}

function render(): void {
  if (!routes.length) {
    listEl.innerHTML = '<div class="empty">No routes yet — add one below.</div>';
    return;
  }
  listEl.innerHTML = routes
    .map(
      (r) => `
    <div class="route">
      <div class="route-head">
        <input type="text" class="f-name" placeholder="Name" value="${escAttr(r.name)}" />
        <button class="del" title="Remove route">✕</button>
      </div>
      <label>URL pattern
        <input type="text" class="f-url" placeholder="http://{workspace}.payroll.localhost/*" value="${escAttr(r.urlPattern)}" />
      </label>
      <div class="two">
        <label>Tab<input type="text" class="f-tab" placeholder="main" value="${escAttr(r.tabName)}" /></label>
        <label>Pane<input type="text" class="f-pane" placeholder="agent" value="${escAttr(r.paneName)}" /></label>
      </div>
    </div>`
    )
    .join('');

  listEl.querySelectorAll('.del').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      collect();
      routes.splice(i, 1);
      render();
    });
  });
}

document.getElementById('add')!.addEventListener('click', () => {
  collect();
  routes.push({ name: '', urlPattern: '', tabName: 'main', paneName: 'agent' });
  render();
  const last = listEl.querySelector('.route:last-child .f-name') as HTMLInputElement | null;
  if (last) last.focus();
});

document.getElementById('save')!.addEventListener('click', async () => {
  collect();
  routes = routes.filter((r) => r.name || r.urlPattern);
  // Validate against the shared schema before storing (background re-validates before POST).
  const parsed = RouteSchema.array().safeParse(routes);
  const toStore = parsed.success ? parsed.data : routes;
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings ?? {}), routes: toStore } });
  render();
  savedEl.classList.add('show');
  setTimeout(() => savedEl.classList.remove('show'), 1500);
});

(async function load() {
  const stored = (await chrome.storage.local.get('settings')).settings as { routes?: Route[] } | undefined;
  routes = stored && Array.isArray(stored.routes) ? stored.routes.slice() : DEFAULT_ROUTES.slice();
  render();
})();
