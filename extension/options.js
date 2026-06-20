const DEFAULT_ROUTES = [
  { name: 'Payroll dev', urlPattern: 'http://{workspace}.payroll.localhost/*', tabName: 'main', paneName: 'agent' },
];

let routes = [];

const listEl = document.getElementById('routes');
const savedEl = document.getElementById('saved');

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Pull current input values back into the `routes` array (so edits survive add/remove).
function collect() {
  const cards = listEl.querySelectorAll('.route');
  routes = Array.from(cards).map((card) => ({
    name: card.querySelector('.f-name').value.trim(),
    urlPattern: card.querySelector('.f-url').value.trim(),
    tabName: card.querySelector('.f-tab').value.trim() || 'main',
    paneName: card.querySelector('.f-pane').value.trim() || 'agent',
  }));
}

function render() {
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

document.getElementById('add').addEventListener('click', () => {
  collect();
  routes.push({ name: '', urlPattern: '', tabName: 'main', paneName: 'agent' });
  render();
  const last = listEl.querySelector('.route:last-child .f-name');
  if (last) last.focus();
});

document.getElementById('save').addEventListener('click', async () => {
  collect();
  // Drop fully-empty rows.
  routes = routes.filter((r) => r.name || r.urlPattern);
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), routes } });
  render();
  savedEl.classList.add('show');
  setTimeout(() => savedEl.classList.remove('show'), 1500);
});

(async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  routes = settings && Array.isArray(settings.routes) ? settings.routes.slice() : DEFAULT_ROUTES.slice();
  render();
})();
