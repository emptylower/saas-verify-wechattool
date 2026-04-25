const state = {
  tenants: [],
  activeTenantId: ''
};

const elements = {
  adminToken: document.querySelector('#adminToken'),
  saveTokenButton: document.querySelector('#saveTokenButton'),
  refreshButton: document.querySelector('#refreshButton'),
  tenantForm: document.querySelector('#tenantForm'),
  tenantId: document.querySelector('#tenantId'),
  clientId: document.querySelector('#clientId'),
  clientSecret: document.querySelector('#clientSecret'),
  wechatToken: document.querySelector('#wechatToken'),
  wechatAppId: document.querySelector('#wechatAppId'),
  wechatAppSecret: document.querySelector('#wechatAppSecret'),
  accountVerifyUrl: document.querySelector('#accountVerifyUrl'),
  verificationWebhookUrl: document.querySelector('#verificationWebhookUrl'),
  webhookSecret: document.querySelector('#webhookSecret'),
  tenantList: document.querySelector('#tenantList'),
  webhookUrl: document.querySelector('#webhookUrl'),
  publicBaseUrl: document.querySelector('#publicBaseUrl'),
  copyWebhookButton: document.querySelector('#copyWebhookButton'),
  statusForm: document.querySelector('#statusForm'),
  queryTenantId: document.querySelector('#queryTenantId'),
  queryPlatformAccountId: document.querySelector('#queryPlatformAccountId'),
  bindingResults: document.querySelector('#bindingResults'),
  refreshAttemptsButton: document.querySelector('#refreshAttemptsButton'),
  attemptResults: document.querySelector('#attemptResults'),
  toast: document.querySelector('#toast')
};

function getAdminToken() {
  return elements.adminToken.value.trim();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  window.setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, 2800);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function api(path, options = {}) {
  const headers = {
    ...(options.headers ?? {})
  };
  const adminToken = getAdminToken();

  if (adminToken) {
    headers['x-admin-token'] = adminToken;
  }

  if (options.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(path, {
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message ?? `Request failed: ${response.status}`);
  }

  return payload;
}

function updateWebhookPreview() {
  const tenantId = elements.tenantId.value.trim() || '{tenantId}';
  const baseUrl = elements.publicBaseUrl.value.trim().replace(/\/$/, '');
  const path = `/wechat/${tenantId}/webhook`;
  elements.webhookUrl.textContent = baseUrl ? `${baseUrl}${path}` : path;
}

function renderTenants() {
  if (!state.tenants.length) {
    elements.tenantList.innerHTML = '<p class="muted">还没有配置租户。</p>';
    return;
  }

  const rows = [
    '<div class="row header"><span>Tenant</span><span>微信 AppID</span><span>凭据</span><span>操作</span></div>'
  ];

  for (const tenant of state.tenants) {
    const credentialText = [
      tenant.has_client_secret ? 'Host OK' : 'Host 缺失',
      tenant.has_wechat_token ? 'Token OK' : 'Token 缺失',
      tenant.has_wechat_appsecret ? 'AppSecret OK' : 'AppSecret 缺失',
      tenant.account_verify_url ? '校验 OK' : '未接校验',
      tenant.verification_webhook_url ? '通知 OK' : '未接通知'
    ].join(' · ');

    rows.push(`<div class="row">
      <span>${escapeHtml(tenant.tenant_id)}</span>
      <span>${tenant.wechat_appid ? escapeHtml(tenant.wechat_appid) : '<span class="muted">未填写</span>'}</span>
      <span>${escapeHtml(credentialText)}</span>
      <button type="button" data-tenant-id="${escapeHtml(tenant.tenant_id)}">编辑</button>
    </div>`);
  }

  elements.tenantList.innerHTML = rows.join('');
  elements.tenantList.querySelectorAll('button[data-tenant-id]').forEach((button) => {
    button.addEventListener('click', () => selectTenant(button.dataset.tenantId));
  });
}

function selectTenant(tenantId) {
  const tenant = state.tenants.find((item) => item.tenant_id === tenantId);

  if (!tenant) {
    return;
  }

  state.activeTenantId = tenant.tenant_id;
  elements.tenantId.value = tenant.tenant_id;
  elements.clientId.value = tenant.client_id;
  elements.clientSecret.value = '';
  elements.wechatToken.value = '';
  elements.wechatAppId.value = tenant.wechat_appid;
  elements.wechatAppSecret.value = '';
  elements.accountVerifyUrl.value = tenant.account_verify_url ?? '';
  elements.verificationWebhookUrl.value = tenant.verification_webhook_url ?? '';
  elements.webhookSecret.value = '';
  elements.queryTenantId.value = tenant.tenant_id;
  updateWebhookPreview();
  refreshBindings();
  refreshAttempts();
}

async function refreshTenants() {
  const payload = await api('/v1/admin/tenants');
  state.tenants = payload.tenants;
  renderTenants();

  if (!state.activeTenantId && state.tenants.length) {
    selectTenant(state.tenants[0].tenant_id);
  }
}

async function saveTenant(event) {
  event.preventDefault();
  const tenantId = elements.tenantId.value.trim();

  if (!tenantId) {
    showToast('请先填写 Tenant ID');
    return;
  }

  await api(`/v1/admin/tenants/${encodeURIComponent(tenantId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      clientId: elements.clientId.value,
      clientSecret: elements.clientSecret.value,
      wechatToken: elements.wechatToken.value,
      wechatAppId: elements.wechatAppId.value,
      wechatAppSecret: elements.wechatAppSecret.value,
      accountVerifyUrl: elements.accountVerifyUrl.value,
      verificationWebhookUrl: elements.verificationWebhookUrl.value,
      webhookSecret: elements.webhookSecret.value
    })
  });

  state.activeTenantId = tenantId;
  elements.queryTenantId.value = tenantId;
  showToast('配置已保存');
  await refreshTenants();
}

function renderBindings(bindings) {
  if (!bindings.length) {
    elements.bindingResults.innerHTML = '<p class="muted">没有找到绑定记录。</p>';
    return;
  }

  const rows = [
    '<div class="row header"><span>平台账号</span><span>状态</span><span>公众号</span><span>绑定时间</span></div>'
  ];

  for (const binding of bindings) {
    rows.push(`<div class="row">
      <span>${escapeHtml(binding.platform_account_id)}</span>
      <span>${escapeHtml(binding.binding_status)}</span>
      <span>${binding.wechat_official_account_appid ? escapeHtml(binding.wechat_official_account_appid) : '<span class="muted">未记录</span>'}</span>
      <span>${binding.bound_at ? escapeHtml(binding.bound_at) : '<span class="muted">未绑定</span>'}</span>
    </div>`);
  }

  elements.bindingResults.innerHTML = rows.join('');
}

async function refreshBindings(event) {
  event?.preventDefault();
  const tenantId = elements.queryTenantId.value.trim();
  const platformAccountId = elements.queryPlatformAccountId.value.trim();

  if (!tenantId) {
    elements.bindingResults.innerHTML = '<p class="muted">请先填写 tenantId。</p>';
    return;
  }

  const params = new URLSearchParams({ tenantId, limit: '100' });

  if (platformAccountId) {
    params.set('platformAccountId', platformAccountId);
  }

  const payload = await api(`/v1/admin/bindings?${params.toString()}`);
  renderBindings(payload.bindings);
}

function renderAttempts(attempts) {
  if (!attempts.length) {
    elements.attemptResults.innerHTML = '<p class="muted">没有验证尝试记录。</p>';
    return;
  }

  const rows = [
    '<div class="row header"><span>平台账号</span><span>结果</span><span>原因</span><span>时间</span></div>'
  ];

  for (const attempt of attempts) {
    const reason = attempt.reasonCode ?? 'ok';
    rows.push(`<div class="row">
      <span>${attempt.candidatePlatformAccountId ? escapeHtml(attempt.candidatePlatformAccountId) : '<span class="muted">空消息</span>'}</span>
      <span>${escapeHtml(attempt.outcome)}</span>
      <span class="${reason === 'ok' ? '' : 'danger'}">${escapeHtml(reason)}</span>
      <span>${escapeHtml(attempt.attemptAt)}</span>
    </div>`);
  }

  elements.attemptResults.innerHTML = rows.join('');
}

async function refreshAttempts() {
  const tenantId = elements.queryTenantId.value.trim() || state.activeTenantId;
  const platformAccountId = elements.queryPlatformAccountId.value.trim();

  if (!tenantId) {
    elements.attemptResults.innerHTML = '<p class="muted">请先选择租户。</p>';
    return;
  }

  const params = new URLSearchParams({ tenantId, limit: '100' });

  if (platformAccountId) {
    params.set('platformAccountId', platformAccountId);
  }

  const payload = await api(`/v1/admin/attempts?${params.toString()}`);
  renderAttempts(payload.attempts);
}

async function copyWebhookUrl() {
  updateWebhookPreview();
  await navigator.clipboard.writeText(elements.webhookUrl.textContent);
  showToast('Webhook URL 已复制');
}

function wireEvents() {
  elements.adminToken.value = localStorage.getItem('wvb_admin_token') ?? '';
  elements.saveTokenButton.addEventListener('click', () => {
    localStorage.setItem('wvb_admin_token', getAdminToken());
    showToast('Admin token 已保存到本机浏览器');
  });
  elements.refreshButton.addEventListener('click', () => refreshTenants().catch((error) => showToast(error.message)));
  elements.tenantForm.addEventListener('submit', (event) => saveTenant(event).catch((error) => showToast(error.message)));
  elements.tenantId.addEventListener('input', updateWebhookPreview);
  elements.publicBaseUrl.addEventListener('input', updateWebhookPreview);
  elements.copyWebhookButton.addEventListener('click', () => copyWebhookUrl().catch((error) => showToast(error.message)));
  elements.statusForm.addEventListener('submit', (event) =>
    refreshBindings(event)
      .then(refreshAttempts)
      .catch((error) => showToast(error.message))
  );
  elements.refreshAttemptsButton.addEventListener('click', () =>
    refreshAttempts().catch((error) => showToast(error.message))
  );
}

wireEvents();
updateWebhookPreview();
refreshTenants().catch((error) => showToast(error.message));
