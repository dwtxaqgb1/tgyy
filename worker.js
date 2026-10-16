// ============================================================
// 天光云影 · Cloudflare Worker
// Part 1/11 - KV兼容 / 常量 / 默认配置 / 加载保存 / 密码
// ============================================================

// KV 绑定兼容（本地开发用模拟KV）
if (typeof globalThis.CONFIG_KV === 'undefined') {
  console.warn('使用本地模拟KV存储（生产环境请绑定真实KV命名空间）');
  globalThis.CONFIG_KV = {
    _data: new Map(),
    async get(key) { return this._data.get(key) || null; },
    async put(key, value) { this._data.set(key, value); },
    async delete(key) { this._data.delete(key); }
  };
}

// ============ 常量 ============
const CONFIG_KEY = 'all_configs';
const PASSWORD_KEY = 'access_password';
const YYKM_KEY = 'yykm_config';
const MERGED_INDEX_KEY = 'merged_m3u_index';
const MERGED_PREFIX = 'merged_m3u_';
const REPLACE_RULES_KEY = 'merge_replace_rules';
const UPLOADED_FILES_KEY = 'worker_uploaded_files';
const MAX_SOURCES = 5;
const DEFAULT_VERSION = '3.3.10';
const DEFAULT_SYNC_FROM = 'CloudWorker';

// ============ 默认配置（严格对齐 App 导出格式）============
const getDefaultConfig = () => ({
  version: DEFAULT_VERSION,
  syncAt: Date.now(),
  syncFrom: DEFAULT_SYNC_FROM,
  configs: {
    iptvSourceCurrent: { name: '', url: '', isLocal: false, transformJs: null },
    iptvSourceList: { value: [] },
    iptvChannelGroups: { value: [] },
    iptvChannelGroupHiddenList: [],
    iptvHybridMode: 'DISABLE',
    epgEnable: true,
    epgSourceCurrent: { name: '', url: '' },
    epgRefreshTimeThreshold: 2,
    videoPlayerUserAgent: 'okHttp/Mod-1.4.0.0',
    cloudSyncAutoPull: true
  }
});

// 白名单：configs 里允许保留的字段，其它一律丢弃
const ALLOWED_CONFIG_KEYS = [
  'iptvSourceCurrent',
  'iptvSourceList',
  'iptvHybridMode',
  'iptvChannelGroups',
  'iptvChannelGroupHiddenList',
  'epgEnable',
  'epgSourceCurrent',
  'epgRefreshTimeThreshold',
  'videoPlayerUserAgent',
  'cloudSyncAutoPull'
];

// ============ 加载配置 ============
const loadConfig = async () => {
  try {
    const raw = await globalThis.CONFIG_KV.get(CONFIG_KEY);
    const base = getDefaultConfig();
    if (!raw) return base;

    let saved;
    try { saved = JSON.parse(raw); } catch { return base; }

    // version / syncFrom / syncAt 保留原值
    if (saved.version) base.version = saved.version;
    if (saved.syncFrom) base.syncFrom = saved.syncFrom;
    if (saved.syncAt) base.syncAt = saved.syncAt;

    // configs 只保留白名单字段
    if (saved.configs && typeof saved.configs === 'object') {
      for (const k of ALLOWED_CONFIG_KEYS) {
        if (saved.configs[k] !== undefined) {
          base.configs[k] = saved.configs[k];
        }
      }
    }
    return base;
  } catch (e) {
    console.error('加载配置失败', e);
    return getDefaultConfig();
  }
};

// ============ 保存配置 ============
const saveConfig = async (config) => {
  try {
    config.syncAt = Date.now();
    await globalThis.CONFIG_KV.put(CONFIG_KEY, JSON.stringify(config));
    return true;
  } catch (e) {
    console.error('保存配置失败', e);
    return false;
  }
};

// ============ 密码 ============
const loadPassword = async () => {
  try { return await globalThis.CONFIG_KV.get(PASSWORD_KEY); } catch { return null; }
};
const savePassword = async (password) => {
  try { await globalThis.CONFIG_KV.put(PASSWORD_KEY, password); return true; } catch { return false; }
};
const validatePassword = (password) =>
  password && password.length >= 6 && password.length <= 12;

// ============ 工具函数 ============
const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// 生成 iptv + 日期 + 时间 格式的名称，例：iptv2026-10-16 15:15:10
const generateIptvName = () => {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date();
  return 'iptv' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
};

// ============ 解析 M3U 分组（用于检测/解析频道列表）============
const parseM3uGroups = async (iptvUrl) => {
  try {
    const headers = new Headers();
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
    const response = await fetchWithTimeout(iptvUrl, { headers }, 15000);
    if (!response.ok) throw new Error('HTTP错误 ' + response.status + '（播放源链接无效或无法访问）');
    const content = await response.text();
    const groups = new Set();
    const groupRegex = /#EXTINF:.*?group-title="([^"]*)"/g;
    let match;
    while ((match = groupRegex.exec(content)) !== null) {
      groups.add(match[1] || '未分组');
    }
    return Array.from(groups).map(name => ({ name }));
  } catch (e) {
    console.error('解析M3U失败', e);
    throw e;
  }
};

// ============ 检测播放源 ============
const checkIptvSource = async () => {
  const config = await loadConfig();
  const { iptvSourceCurrent, videoPlayerUserAgent } = config.configs;
  if (!iptvSourceCurrent || !iptvSourceCurrent.url) {
    return { success: false, error: '未配置有效的播放源链接，无法进行检查' };
  }
  let currentStatus = 'unknown';
  let statusMessage = '';
  let responseTime = 0;
  try {
    const headers = new Headers();
    headers.set('User-Agent', videoPlayerUserAgent || 'Mozilla/5.0');
    if (iptvSourceCurrent.url.includes('ottiptv.cc') || iptvSourceCurrent.url.includes('live.') || iptvSourceCurrent.url.includes('iptv')) {
      headers.set('Accept', '*/*');
      headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
      try {
        const u = new URL(iptvSourceCurrent.url);
        headers.set('Referer', u.protocol + '//' + u.host + '/');
      } catch (e) {}
    }
    const startTime = performance.now();
    const response = await fetchWithTimeout(iptvSourceCurrent.url, { method: 'GET', headers: headers, redirect: 'follow' }, 20000);
    responseTime = Math.round(performance.now() - startTime);
    if (response.ok) {
      const content = await response.text();
      if (content.includes('#EXTM3U')) {
        currentStatus = 'up';
        statusMessage = '正常（有效M3U内容，响应时间：' + responseTime + 'ms）';
      } else {
        currentStatus = 'down';
        statusMessage = '无效内容（状态码：' + response.status + '，非M3U格式）';
      }
    } else {
      currentStatus = 'down';
      statusMessage = '请求失败（状态码：' + response.status + '）';
    }
  } catch (e) {
    currentStatus = 'down';
    responseTime = 0;
    statusMessage = '连接错误：' + e.message;
    if (e.name === 'TypeError') statusMessage = '连接错误：无效的URL或网络问题';
    else if (e.name === 'AbortError' || e.message.includes('timeout')) statusMessage = '连接超时：服务器无响应';
  }
  return { success: true, status: currentStatus, message: statusMessage, responseTime: responseTime };
};

// ============ 解析 M3U 内容（返回分组+频道）============
const parseM3uContent = async (sourceUrl, content, userAgent) => {
  let m3uContent = content;
  if (!m3uContent) {
    try { new URL(sourceUrl); } catch (e) { throw new Error('无效的URL格式: ' + sourceUrl); }
    const headers = new Headers();
    headers.set('User-Agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
    const response = await fetchWithTimeout(sourceUrl, { headers: headers }, 15000);
    if (!response.ok) throw new Error('HTTP错误 ' + response.status + '（播放源链接无效或无法访问）');
    m3uContent = await response.text();
  }
  const groups = new Set();
  const channelsByGroup = {};
  const groupRegex = /#EXTINF:.*?group-title="([^"]*)"/g;
  const channelRegex = /#EXTINF:(.*?),(.*?)\r?\n(.*?)(?=\r?\n#|$)/gs;
  let match;
  while ((match = groupRegex.exec(m3uContent)) !== null) {
    const groupName = match[1] || '未分组';
    groups.add(groupName);
    if (!channelsByGroup[groupName]) channelsByGroup[groupName] = [];
  }
  let channelMatch;
  while ((channelMatch = channelRegex.exec(m3uContent)) !== null) {
    const infoline = channelMatch[1];
    const channelName = channelMatch[2];
    const url = channelMatch[3];
    const groupMatch = infoline.match(/group-title="([^"]*)"/);
    const groupName = groupMatch ? (groupMatch[1] || '未分组') : '未分组';
    if (!channelsByGroup[groupName]) channelsByGroup[groupName] = [];
    channelsByGroup[groupName].push({
      infoline: '#EXTINF:' + infoline + ',' + channelName,
      url: url,
      originalGroup: groupName
    });
  }
  return {
    groups: Array.from(groups).map(name => ({ name })),
    channelsByGroup: channelsByGroup
  };
};

// ============ 合并 M3U 文件 ============
// groupMap: { 处理名: { originalName, source } }，用于精确还原原始分组名
const mergeM3uFiles = async (sources, selectedGroups, groupOrder, groupMap, userAgent, replaceRules) => {
  try {
    const validSources = sources.filter(src => src.url || src.content || src.file);
    if (validSources.length < 1) throw new Error('至少需要一个有效的源');
    const parsePromises = validSources.map(async src => {
      let data;
      if (src.isLocal && src.content) {
        data = await parseM3uContent('local_' + src.index, src.content, userAgent);
      } else if (src.isLocal && src.file) {
        const fileContent = await src.file.text();
        data = await parseM3uContent('local_' + src.index, fileContent, userAgent);
      } else {
        data = await parseM3uContent(src.url, null, userAgent);
      }
      return { sourceIndex: src.index, groups: data.groups, channelsByGroup: data.channelsByGroup };
    });
    const sourcesData = await Promise.all(parsePromises);

    const allGroups = new Set();
    Object.values(selectedGroups).forEach(groups => {
      groups.forEach(group => allGroups.add(group));
    });

    let mergedContent = '#EXTM3U\n';

    const applyReplace = (url) => {
      if (!replaceRules || replaceRules.length === 0) return url;
      let result = url;
      for (const rule of replaceRules) {
        if (!rule || !rule.from || !rule.to) continue;
        const from = rule.from.toLowerCase();
        const to = rule.to;
        let lower = result.toLowerCase();
        let idx = lower.indexOf(from);
        while (idx !== -1) {
          result = result.substring(0, idx) + to + result.substring(idx + from.length);
          lower = result.toLowerCase();
          idx = lower.indexOf(from, idx + to.length);
        }
      }
      return result;
    };

    const groupsToProcess = groupOrder.length > 0
      ? groupOrder.filter(g => allGroups.has(g))
      : Array.from(allGroups).sort();

    for (const targetGroupName of groupsToProcess) {
      for (let i = 0; i < validSources.length; i++) {
        const sourceIndex = validSources[i].index;
        if (selectedGroups[sourceIndex] && selectedGroups[sourceIndex].includes(targetGroupName)) {
          // 从 groupMap 精确取原始分组名，不再靠正则去数字后缀
          const entry = groupMap && groupMap[targetGroupName];
          const originalGroupName = entry ? entry.originalName : targetGroupName;
          const sourceData = sourcesData.find(s => s.sourceIndex === sourceIndex);
          if (sourceData && sourceData.channelsByGroup[originalGroupName]) {
            sourceData.channelsByGroup[originalGroupName].forEach(channel => {
              let line = channel.infoline.replace('group-title="' + originalGroupName + '"', 'group-title="' + targetGroupName + '"');
              line = line.replace("group-title='" + originalGroupName + "'", 'group-title="' + targetGroupName + '"');
              mergedContent += line + '\n' + applyReplace(channel.url) + '\n';
            });
          }
        }
      }
    }
    return { success: true, message: 'M3U文件合并成功', content: mergedContent };
  } catch (e) {
    console.error('合并M3U失败', e);
    return { success: false, error: e.message };
  }
};

// ============ 合并文件索引管理 ============
const loadMergedIndex = async () => {
  try {
    const raw = await globalThis.CONFIG_KV.get(MERGED_INDEX_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
};
const saveMergedIndex = async (list) => {
  try { await globalThis.CONFIG_KV.put(MERGED_INDEX_KEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }
};
const sanitizeFileName = (name) => (name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');

// ============ 密码验证中间件 ============
const requirePassword = (handler) => {
  return async (request, url) => {
    const publicPaths = ['/all_configs.json', '/yykm.json', '/verify-password'];
    if (publicPaths.includes(url.pathname)) return handler(request, url);
    const storedPassword = await loadPassword();
    if (!storedPassword && url.pathname === '/') return showPasswordSetupPage(request.url);
    const cookieHeader = request.headers.get('Cookie') || '';
    const cookies = Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=')));
    if (cookies.auth === 'true') return handler(request, url);
    return showPasswordPage(request.url, !!storedPassword);
  };
};

// ============ 密码页面 ============
const showPasswordPage = (requestUrl, hasPassword) => {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>访问验证 - 天光云影配置管理</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
        body { margin: 0; padding: 20px; line-height: 1.6; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #333; font-size: 14px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .login-container { background: white; padding: 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2); width: 100%; max-width: 400px; }
        .logo { text-align: center; margin-bottom: 30px; }
        .logo h1 { color: #2c3e50; font-size: 24px; font-weight: 600; margin-bottom: 8px; }
        .logo p { color: #7f8c8d; font-size: 14px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; color: #2c3e50; font-size: 14px; }
        input { width: 100%; padding: 14px 16px; border: 2px solid #e9ecef; border-radius: 8px; font-size: 16px; transition: all 0.3s ease; background: #f8f9fa; }
        input:focus { outline: none; border-color: #667eea; background: white; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1); }
        button { width: 100%; padding: 16px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; transition: all 0.3s ease; background: linear-gradient(135deg, #667eea, #764ba2); color: white; margin-top: 10px; }
        button:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
        .error { color: #e74c3c; font-size: 13px; margin-top: 8px; text-align: center; display: none; }
        .info { color: #7f8c8d; font-size: 13px; text-align: center; margin-top: 20px; line-height: 1.5; }
    
        /* ===== 内联表单紧凑布局 ===== */
        .form-group.inline {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }
        .form-group.inline > label {
            flex: 0 0 58px;
            margin-bottom: 0;
            font-size: 13px;
            font-weight: 600;
            color: #2c3e50;
            white-space: nowrap;
        }
        .form-group.inline > input,
        .form-group.inline > select {
            flex: 1;
            min-width: 0;
            padding: 9px 12px;
            font-size: 15px;
            border-width: 1px;
            height: 40px;
        }
        .form-group.inline > small {
            flex-basis: 100%;
            margin-left: 66px;
            margin-top: 2px;
            font-size: 11px;
            color: #888;
        }
        @media (max-width: 768px) {
            .form-group.inline > input,
            .form-group.inline > select {
                font-size: 16px;
                height: 42px;
            }
        }
    
</style>
</head>
<body>
    <div class="login-container">
        <div class="logo">
            <h1>天光云影配置管理</h1>
            <p>${hasPassword ? '请输入访问密码' : '首次使用，请设置访问密码'}</p>
        </div>
        <form id="passwordForm">
            <div class="form-group inline">
                <label for="password">${hasPassword ? '访问密码' : '设置密码（6-12位）'}</label>
                <input type="password" id="password" name="password" placeholder="${hasPassword ? '请输入密码...' : '请设置6-12位密码...'}" required>
            </div>
            ${!hasPassword ? `
            <div class="form-group inline">
                <label for="confirmPassword">确认密码</label>
                <input type="password" id="confirmPassword" name="confirmPassword" placeholder="请再次输入密码..." required>
            </div>
            ` : ''}
            <div id="errorMessage" class="error"></div>
            <button type="submit">${hasPassword ? '进入系统' : '设置密码并进入'}</button>
        </form>
        <div class="info">${hasPassword ? '密码长度为6-12位' : '首次访问需要设置密码，请妥善保管'}</div>
    </div>
    <script>
        document.getElementById('passwordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('password').value;
            const confirmPassword = document.getElementById('confirmPassword') ? document.getElementById('confirmPassword').value : null;
            const errorElement = document.getElementById('errorMessage');
            if (password.length < 6 || password.length > 12) { errorElement.textContent = '密码长度必须为6-12位'; errorElement.style.display = 'block'; return; }
            if (confirmPassword !== null && password !== confirmPassword) { errorElement.textContent = '两次输入的密码不一致'; errorElement.style.display = 'block'; return; }
            try {
                const response = await fetch('/verify-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: password, action: confirmPassword !== null ? 'setup' : 'login' })
                });
                const data = await response.json();
                if (data.success) { window.location.href = '/'; }
                else { errorElement.textContent = data.error || '密码错误'; errorElement.style.display = 'block'; }
            } catch (error) { errorElement.textContent = '网络错误，请重试'; errorElement.style.display = 'block'; }
        });
        document.getElementById('password').addEventListener('input', () => { document.getElementById('errorMessage').style.display = 'none'; });
        if (document.getElementById('confirmPassword')) {
            document.getElementById('confirmPassword').addEventListener('input', () => { document.getElementById('errorMessage').style.display = 'none'; });
        }
    </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
};

const showPasswordSetupPage = (requestUrl) => showPasswordPage(requestUrl, false);

// ============ 首页 ============
const getIndexHtml = async (requestUrl) => {
  const config = await loadConfig();
  const { iptvSourceCurrent, epgSourceCurrent, videoPlayerUserAgent, iptvHybridMode, iptvChannelGroupHiddenList } = config.configs;
  const hiddenGroups = iptvChannelGroupHiddenList || [];
  const urlObj = new URL(requestUrl);
  const fullConfigUrl = urlObj.protocol + '//' + urlObj.host + '/all_configs.json';

  const pageScript = `
    window.hiddenGroups = ${JSON.stringify(hiddenGroups)};
    let currentTab = 'source';

    function initTabs() {
        const tabs = document.querySelectorAll('.tab');
        const tabContents = document.querySelectorAll('.tab-content');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                const tabId = tab.getAttribute('data-tab');
                currentTab = tabId;
                const content = document.getElementById(tabId + '-content');
                if (content) content.classList.add('active');
                updateConfigUrlDisplay();
                if (tabId === 'file-upload') loadFileList();
                if (tabId === 'channel-merge') loadMergedFileList();
            });
        });
        if (tabs.length > 0) {
            tabs[0].classList.add('active');
            const firstTabId = tabs[0].getAttribute('data-tab');
            currentTab = firstTabId;
            const firstContent = document.getElementById(firstTabId + '-content');
            if (firstContent) firstContent.classList.add('active');
        }
        updateConfigUrlDisplay();
    }

    function updateConfigUrlDisplay() {
        const configUrlContainer = document.getElementById('config-url-container');
        if (configUrlContainer) configUrlContainer.style.display = currentTab === 'source' ? 'block' : 'none';
    }

    document.getElementById('copy_url_btn').addEventListener('click', () => {
        const urlInput = document.getElementById('config_file_url');
        const copyBtn = document.getElementById('copy_url_btn');
        const originalText = copyBtn.textContent;
        urlInput.select();
        document.execCommand('copy');
        copyBtn.textContent = '✓ 已复制';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = originalText; copyBtn.classList.remove('copied'); }, 2000);
    });

    document.getElementById('change_password_btn').addEventListener('click', () => { showPasswordModal('change'); });

    function showPasswordModal(action) {
        const modal = document.getElementById('password_modal');
        const title = document.getElementById('modal_title');
        const form = document.getElementById('password_modal_form');
        if (action === 'change') {
            title.textContent = '修改访问密码';
            form.innerHTML = \`
                <div class="form-group inline"><label for="current_password">当前密码</label><input type="password" id="current_password" name="current_password" placeholder="请输入当前密码..." required></div>
                <div class="form-group inline"><label for="new_password">新密码（6-12位）</label><input type="password" id="new_password" name="new_password" placeholder="请输入新密码..." required></div>
                <div class="form-group inline"><label for="confirm_new_password">确认新密码</label><input type="password" id="confirm_new_password" name="confirm_new_password" placeholder="请再次输入新密码..." required></div>
                <div class="modal-actions"><button type="button" class="btn-secondary" onclick="closePasswordModal()">取消</button><button type="submit" class="btn-primary">确认修改</button></div>
            \`;
        }
        modal.style.display = 'flex';
        form.onsubmit = async (e) => { e.preventDefault(); await handlePasswordChange(e); };
    }

    function closePasswordModal() {
        document.getElementById('password_modal').style.display = 'none';
        document.getElementById('password_modal_form').reset();
        document.getElementById('modal_error').style.display = 'none';
    }

    async function handlePasswordChange(e) {
        const formData = new FormData(e.target);
        const currentPassword = formData.get('current_password');
        const newPassword = formData.get('new_password');
        const confirmNewPassword = formData.get('confirm_new_password');
        const errorElement = document.getElementById('modal_error');
        if (newPassword.length < 6 || newPassword.length > 12) { errorElement.textContent = '新密码长度必须为6-12位'; errorElement.style.display = 'block'; return; }
        if (newPassword !== confirmNewPassword) { errorElement.textContent = '两次输入的新密码不一致'; errorElement.style.display = 'block'; return; }
        try {
            const response = await fetch('/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const data = await response.json();
            if (data.success) { alert('密码修改成功！'); closePasswordModal(); }
            else { errorElement.textContent = data.error || '密码修改失败'; errorElement.style.display = 'block'; }
        } catch (error) { errorElement.textContent = '网络错误，请重试'; errorElement.style.display = 'block'; }
    }

    document.getElementById('manual_check_btn').addEventListener('click', async () => {
        const btn = document.getElementById('manual_check_btn');
        btn.disabled = true; btn.textContent = '检查中...';
        try {
            const res = await fetch('/manual_check', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('✅ 检测成功，' + data.message);
            } else {
                alert('❌ 检测失败，' + (data.error || data.message || '未知错误'));
            }
        } catch (e) { alert('❌ 检测出错，' + e.message); }
        finally { btn.disabled = false; btn.textContent = '检测播放源'; }
    });

    document.getElementById('parse_groups_btn').addEventListener('click', async () => {
        const btn = document.getElementById('parse_groups_btn');
        btn.disabled = true; btn.textContent = '解析中...';
        const resultDiv = document.getElementById('group_parse_result');
        const checkboxContainer = document.getElementById('group_checkbox_container');
        const checkboxList = document.getElementById('group_checkbox_list');
        const saveBtn = document.getElementById('save_hide_groups_btn');
        try {
            const parseRes = await fetch('/parse_channels', { method: 'POST' });
            const parseData = await parseRes.json();
            if (parseData.success) {
                resultDiv.className = 'parse-result success';
                resultDiv.textContent = '解析成功！共发现 ' + parseData.count + ' 个频道分组';
                resultDiv.style.display = 'block';
                checkboxContainer.style.display = 'block';
                saveBtn.style.display = 'inline-block';
                checkboxList.innerHTML = '';
                parseData.groups.forEach(group => {
                    const isChecked = window.hiddenGroups.includes(group.name);
                    checkboxList.innerHTML += '<div class="group-checkbox-item">'
                        + '<input type="checkbox" class="group-checkbox" value="' + group.name + '" ' + (isChecked ? 'checked' : '') + '>'
                        + '<label>' + group.name + '</label>'
                        + '</div>';
                });
            } else {
                resultDiv.className = 'parse-result error';
                resultDiv.textContent = '解析失败：' + parseData.error;
                resultDiv.style.display = 'block';
            }
        } catch (e) {
            resultDiv.className = 'parse-result error';
            resultDiv.textContent = '操作失败：' + e.message;
            resultDiv.style.display = 'block';
        } finally { btn.disabled = false; btn.textContent = '解析频道分组'; }
    });

    document.getElementById('save_hide_groups_btn').addEventListener('click', async () => {
        const checkedGroups = Array.from(document.querySelectorAll('.group-checkbox:checked')).map(cb => cb.value);
        const res = await fetch('/batch_hide_groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selected_groups: checkedGroups })
        });
        const data = await res.json();
        if (data.success) { alert('保存成功！共隐藏 ' + data.hidden_count + ' 个分组'); window.hiddenGroups = checkedGroups; }
        else { alert('保存失败：' + data.error); }
    });

    document.getElementById('source-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = Object.fromEntries(new FormData(e.target));
        try {
            const res = await fetch('/save_source_config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            const data = await res.json();
            if (data.success) {
                if (data.refresh) { alert('配置保存成功！页面将刷新...'); setTimeout(() => window.location.reload(), 1000); }
                else { alert('配置保存成功！'); }
            } else { alert('保存失败：' + data.error); }
        } catch (e) { alert('保存过程出错：' + e.message); }
    });

    // ============ 云影空蒙配置 ============
    async function loadYykm() {
        const res = await fetch("/get_yykm");
        const data = await res.json();
        if (data.success && data.config.configs.channelSourceList.length > 0) {
            const s = data.config.configs.channelSourceList[0];
            document.getElementById("yykm_name").value = s.name || "";
            document.getElementById("yykm_uri").value = s.uri || "";
            document.getElementById("yykm_epg").value = (s.epgUriList && s.epgUriList[0]) || "";
        }
        document.getElementById("yykm_ua").value = data.config.configs.videoPlayerUserAgent || "okHttp/Mod-1.4.0.0";
        document.getElementById("yykm_config_url").value = location.origin + "/yykm.json";
    }

    document.getElementById("yykm_save_btn").onclick = async function() {
        await fetch("/save_yykm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: document.getElementById("yykm_name").value.trim(),
                uri: document.getElementById("yykm_uri").value.trim(),
                epg: document.getElementById("yykm_epg").value.trim(),
                ua: document.getElementById("yykm_ua").value.trim()
            })
        });
        alert("保存成功！");
    };

    const copyYykmBtn = document.getElementById('copy_yykm_url_btn');
    if (copyYykmBtn) {
        copyYykmBtn.addEventListener('click', () => {
            const urlInput = document.getElementById('yykm_config_url');
            if (!urlInput || !urlInput.value) return;
            urlInput.select();
            document.execCommand('copy');
            const originalText = copyYykmBtn.textContent;
            copyYykmBtn.textContent = '✓ 已复制';
            copyYykmBtn.classList.add('copied');
            setTimeout(() => {
                copyYykmBtn.textContent = originalText;
                copyYykmBtn.classList.remove('copied');
            }, 2000);
        });
    }

    // ============ 频道合并工具 ============
    let currentSourceCount = 0;
    let selectedGroupsOrder = [];
    let groupNameMap = new Map();

    document.getElementById('add_url_source_btn').addEventListener('click', () => {
        if (currentSourceCount >= ${MAX_SOURCES}) { alert('最多只能添加${MAX_SOURCES}个源'); return; }
        currentSourceCount++;
        const newSourceHtml = \`
            <div class="source-item" data-source="\${currentSourceCount}" data-type="url">
                <div class="source-header">
                    <h4>URL源 \${currentSourceCount}</h4>
                    <div class="source-header-actions">
                        <button type="button" class="parse-source-btn" data-source="\${currentSourceCount}">解析</button>
                        <button type="button" class="remove-source-btn" data-source="\${currentSourceCount}">删除</button>
                    </div>
                </div>
                <div class="form-group inline">
                    <label for="source\${currentSourceCount}_url">M3U URL地址</label>
                    <input type="text" name="source\${currentSourceCount}_url" id="source\${currentSourceCount}_url" placeholder="例如: http://example.com/playlist.m3u" required>
                </div>
                <div class="source-groups" id="source_groups_\${currentSourceCount}" style="display:none;"></div>
            </div>
        \`;
        document.getElementById('sources_container').insertAdjacentHTML('beforeend', newSourceHtml);
        bindSourceEvents();
    });

    document.getElementById('add_local_source_btn').addEventListener('click', () => {
        if (currentSourceCount >= ${MAX_SOURCES}) { alert('最多只能添加${MAX_SOURCES}个源'); return; }
        currentSourceCount++;
        const newSourceHtml = \`
            <div class="source-item" data-source="\${currentSourceCount}" data-type="local">
                <div class="source-header">
                    <h4>本地源 \${currentSourceCount}</h4>
                    <div class="source-header-actions">
                        <button type="button" class="parse-source-btn" data-source="\${currentSourceCount}">解析</button>
                        <button type="button" class="remove-source-btn" data-source="\${currentSourceCount}">删除</button>
                    </div>
                </div>
                <div class="form-group inline">
                    <label for="source\${currentSourceCount}_file">M3U文件</label>
                    <input type="file" name="source\${currentSourceCount}_file" id="source\${currentSourceCount}_file" accept=".m3u,.m3u8" required>
                    <small>支持M3U格式文件，最大1MB</small>
                </div>
                <div class="source-groups" id="source_groups_\${currentSourceCount}" style="display:none;"></div>
            </div>
        \`;
        document.getElementById('sources_container').insertAdjacentHTML('beforeend', newSourceHtml);
        bindSourceEvents();
    });

    function bindSourceEvents() {
        document.querySelectorAll('.remove-source-btn').forEach(btn => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', function() {
                const sourceIndex = parseInt(this.dataset.source);
                const item = document.querySelector(\`.source-item[data-source="\${sourceIndex}"]\`);
                if (item) item.remove();
                removeSourceFromSelection(sourceIndex);
                renumberSources();
            });
        });
        document.querySelectorAll('.parse-source-btn').forEach(btn => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', function() { parseSingleSource(parseInt(this.dataset.source)); });
        });
    }

    function removeSourceFromSelection(sourceIndex) {
        const toRemove = [];
        groupNameMap.forEach((entry, processedName) => { if (entry.source === sourceIndex.toString()) toRemove.push(processedName); });
        toRemove.forEach(name => {
            const idx = selectedGroupsOrder.indexOf(name);
            if (idx !== -1) selectedGroupsOrder.splice(idx, 1);
            groupNameMap.delete(name);
            const item = document.querySelector(\`.order-item[data-group="\${name}"]\`);
            if (item) item.remove();
        });
        updateOrderNumbers();
    }

    function renumberSources() {
        const sourceItems = Array.from(document.querySelectorAll('.source-item'));
        currentSourceCount = sourceItems.length;
        sourceItems.forEach((item, index) => {
            const newIndex = index + 1;
            const sourceType = item.dataset.type;
            item.dataset.source = newIndex;
            item.querySelector('.source-header h4').textContent = \`\${sourceType === 'url' ? 'URL源' : '本地源'} \${newIndex}\`;
            if (sourceType === 'url') {
                const input = item.querySelector('input[type="text"]');
                input.name = \`source\${newIndex}_url\`;
                input.id = \`source\${newIndex}_url\`;
            } else {
                const input = item.querySelector('input[type="file"]');
                input.name = \`source\${newIndex}_file\`;
                input.id = \`source\${newIndex}_file\`;
            }
            const removeBtn = item.querySelector('.remove-source-btn');
            if (removeBtn) removeBtn.dataset.source = newIndex;
            const parseBtn = item.querySelector('.parse-source-btn');
            if (parseBtn) parseBtn.dataset.source = newIndex;
            const groupsDiv = item.querySelector('.source-groups');
            if (groupsDiv) groupsDiv.id = \`source_groups_\${newIndex}\`;
        });
    }

    async function parseSingleSource(sourceIndex) {
        const item = document.querySelector(\`.source-item[data-source="\${sourceIndex}"]\`);
        if (!item) return;
        const sourceType = item.dataset.type;
        const groupsDiv = document.getElementById(\`source_groups_\${sourceIndex}\`);
        const parseBtn = item.querySelector('.parse-source-btn');
        const originalText = parseBtn.textContent;
        parseBtn.disabled = true; parseBtn.textContent = '解析中...';
        groupsDiv.style.display = 'block';
        groupsDiv.innerHTML = '<div style="color:#6c757d;padding:8px;">解析中，请稍候...</div>';
        try {
            const formData = new FormData();
            formData.append('sourceIndex', sourceIndex);
            formData.append('sourceType', sourceType);
            if (sourceType === 'url') {
                const url = item.querySelector('input[type="text"]').value.trim();
                if (!url) throw new Error('请先填写URL地址');
                try { new URL(url); } catch (e) { throw new Error('URL格式无效'); }
                formData.append('url', url);
            } else {
                const fileInput = item.querySelector('input[type="file"]');
                if (!fileInput.files.length) throw new Error('请先选择M3U文件');
                const file = fileInput.files[0];
                if (file.size > 1 * 1024 * 1024) throw new Error('文件超过1MB限制');
                if (!file.name.toLowerCase().endsWith('.m3u') && !file.name.toLowerCase().endsWith('.m3u8')) throw new Error('文件必须是M3U格式');
                formData.append('file', file);
            }
            const res = await fetch('/parse_merge_source', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) renderSourceGroups(sourceIndex, data.groups);
            else groupsDiv.innerHTML = \`<div class="parse-result error" style="display:block;">解析失败：\${data.error}</div>\`;
        } catch (e) {
            groupsDiv.innerHTML = \`<div class="parse-result error" style="display:block;">解析出错：\${e.message}</div>\`;
        } finally { parseBtn.disabled = false; parseBtn.textContent = originalText; }
    }

    function renderSourceGroups(sourceIndex, groups) {
        const groupsDiv = document.getElementById(\`source_groups_\${sourceIndex}\`);
        if (!groups.length) { groupsDiv.innerHTML = '<div style="color:#6c757d;padding:8px;">该源没有解析到分组</div>'; return; }
        let html = '<div class="source-groups-title">频道分组（勾选加入合并）</div><div class="source-groups-list">';
        groups.forEach(group => {
            const isChecked = groupNameMap.size > 0 && Array.from(groupNameMap.values()).some(entry => entry.originalName === group.name && entry.source === sourceIndex.toString());
            html += \`
                <div class="group-checkbox-item">
                    <input type="checkbox" class="source-group-checkbox" data-source="\${sourceIndex}" value="\${group.name}" \${isChecked ? 'checked' : ''}>
                    <label>\${group.name}</label>
                </div>
            \`;
        });
        html += '</div>';
        groupsDiv.innerHTML = html;
        bindCheckboxEvents();
    }

    function bindCheckboxEvents() {
        document.querySelectorAll('.source-group-checkbox').forEach(checkbox => {
            if (checkbox.dataset.bound) return;
            checkbox.dataset.bound = '1';
            checkbox.addEventListener('change', function() {
                const originalGroupName = this.value;
                const sourceIndex = this.dataset.source;
                if (this.checked) {
                    let newGroupName = originalGroupName;
                    let counter = 1;
                    while (selectedGroupsOrder.some(g => g === newGroupName)) { newGroupName = \`\${originalGroupName}\${counter}\`; counter++; }
                    selectedGroupsOrder.push(newGroupName);
                    groupNameMap.set(newGroupName, { originalName: originalGroupName, source: sourceIndex });
                    const orderItem = document.createElement('div');
                    orderItem.className = 'order-item';
                    orderItem.dataset.group = newGroupName;
                    orderItem.innerHTML = \`
                        <span class="order-number">\${selectedGroupsOrder.length}</span>
                        <span class="order-source">源\${sourceIndex}</span>
                        <span class="order-name">\${newGroupName}</span>
                        <button class="remove-btn" data-group="\${newGroupName}">×</button>
                    \`;
                    document.getElementById('selected_order_list').appendChild(orderItem);
                    orderItem.querySelector('.remove-btn').addEventListener('click', function() {
                        const groupToRemove = this.dataset.group;
                        const mapEntry = groupNameMap.get(groupToRemove);
                        if (mapEntry) {
                            const checkboxToUncheck = document.querySelector(\`.source-group-checkbox[value="\${mapEntry.originalName}"][data-source="\${mapEntry.source}"]\`);
                            if (checkboxToUncheck) checkboxToUncheck.checked = false;
                        }
                        const index = selectedGroupsOrder.indexOf(groupToRemove);
                        if (index !== -1) selectedGroupsOrder.splice(index, 1);
                        groupNameMap.delete(groupToRemove);
                        this.parentElement.remove();
                        updateOrderNumbers();
                    });
                } else {
                    const toRemove = [];
                    groupNameMap.forEach((entry, processedName) => { if (entry.originalName === originalGroupName && entry.source === sourceIndex) toRemove.push(processedName); });
                    toRemove.forEach(groupName => {
                        const index = selectedGroupsOrder.indexOf(groupName);
                        if (index !== -1) selectedGroupsOrder.splice(index, 1);
                        const itemToRemove = document.querySelector(\`.order-item[data-group="\${groupName}"]\`);
                        if (itemToRemove) itemToRemove.remove();
                        groupNameMap.delete(groupName);
                    });
                    updateOrderNumbers();
                }
            });
        });
    }

    function updateOrderNumbers() {
        const orderItems = document.querySelectorAll('.order-item');
        orderItems.forEach((item, index) => { item.querySelector('.order-number').textContent = index + 1; });
    }

    // ============ 地址替换规则 ============
    const MAX_REPLACE_RULES = 10;
    let replaceRules = [];

    function escapeAttr(str) { return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function renderReplaceRules() {
        const list = document.getElementById('replace_rules_list');
        if (!list) return;
        list.innerHTML = '';
        replaceRules.forEach((rule, index) => {
            const row = document.createElement('div');
            row.className = 'replace-rule-row';
            const fromVal = escapeAttr(rule.from);
            const toVal = escapeAttr(rule.to);
            row.innerHTML = '<input type="text" placeholder="查找（例如 http://公网域名:端口）" value="' + fromVal + '" data-field="from" data-index="' + index + '">'
                + '<input type="text" placeholder="替换为（例如 http://内网IP:端口）" value="' + toVal + '" data-field="to" data-index="' + index + '">'
                + '<button type="button" data-index="' + index + '">删除</button>';
            list.appendChild(row);
        });
        list.querySelectorAll('input').forEach(input => {
            input.addEventListener('input', function() {
                const idx = parseInt(this.dataset.index);
                const field = this.dataset.field;
                if (replaceRules[idx]) replaceRules[idx][field] = this.value;
            });
        });
        list.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', function() {
                const idx = parseInt(this.dataset.index);
                replaceRules.splice(idx, 1);
                renderReplaceRules();
            });
        });
    }

    document.getElementById('replace_rules_toggle').addEventListener('click', function() {
        const body = document.getElementById('replace_rules_body');
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        this.textContent = isHidden ? '▾ 地址替换（可选）' : '▸ 地址替换（可选）';
    });

    document.getElementById('add_replace_rule_btn').addEventListener('click', function() {
        if (replaceRules.length >= MAX_REPLACE_RULES) { alert('最多只能添加 ' + MAX_REPLACE_RULES + ' 条规则'); return; }
        replaceRules.push({ from: '', to: '' });
        renderReplaceRules();
    });

    async function loadReplaceRules() {
        try {
            const res = await fetch('/get_replace_rules');
            const data = await res.json();
            if (data.success && Array.isArray(data.rules)) {
                replaceRules = data.rules;
                if (replaceRules.length > 0) {
                    document.getElementById('replace_rules_body').style.display = 'block';
                    document.getElementById('replace_rules_toggle').textContent = '▾ 地址替换（可选）';
                }
                renderReplaceRules();
            }
        } catch (e) {}
    }

    document.getElementById('merge_btn').addEventListener('click', async () => {
        const btn = document.getElementById('merge_btn');
        const nameInput = document.getElementById('merge_file_name');
        const resultDiv = document.getElementById('merge_result');
        const rawName = nameInput.value.trim();
        const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safeName) { resultDiv.className = 'parse-result error'; resultDiv.textContent = '请填写文件名（仅限字母、数字、下划线、连字符）'; resultDiv.style.display = 'block'; return; }
        btn.disabled = true; btn.textContent = '合并中...'; resultDiv.style.display = 'none';
        try {
            const selectedGroups = {};
            document.querySelectorAll('.source-group-checkbox:checked').forEach(checkbox => {
                const sourceIndex = parseInt(checkbox.dataset.source);
                const originalGroupName = checkbox.value;
                let processedName = originalGroupName;
                groupNameMap.forEach((entry, procName) => { if (entry.originalName === originalGroupName && entry.source === sourceIndex.toString()) processedName = procName; });
                if (!selectedGroups[sourceIndex]) selectedGroups[sourceIndex] = [];
                selectedGroups[sourceIndex].push(processedName);
            });
            const hasSelectedGroups = Object.values(selectedGroups).some(groups => groups.length > 0);
            if (!hasSelectedGroups) throw new Error('请至少选择一个分组进行合并');
            const sources = [];
            document.querySelectorAll('.source-item').forEach(item => {
                const sourceIndex = parseInt(item.dataset.source);
                const sourceType = item.dataset.type;
                if (sourceType === 'url') {
                    const url = item.querySelector('input[type="text"]').value.trim();
                    if (url) sources.push({ index: sourceIndex, url, name: \`URL源\${sourceIndex}\`, isLocal: false });
                } else {
                    const fileInput = item.querySelector('input[type="file"]');
                    if (fileInput.files.length > 0) sources.push({ index: sourceIndex, file: fileInput.files[0], name: \`本地源\${sourceIndex}\`, isLocal: true });
                }
            });
            if (sources.length < 1) throw new Error('请至少填写一个有效的源');
            const groupOrder = [...selectedGroupsOrder];
            const formData = new FormData();
            formData.append('name', safeName);
            formData.append('selectedGroups', JSON.stringify(selectedGroups));
            formData.append('groupOrder', JSON.stringify(groupOrder));
            formData.append('groupMap', JSON.stringify(Object.fromEntries(groupNameMap)));
            const validRules = replaceRules.filter(r => r.from && r.to);
            formData.append('replaceRules', JSON.stringify(validRules));
            sources.forEach(source => {
                formData.append('sources', JSON.stringify({ index: source.index, name: source.name, isLocal: source.isLocal, url: source.url || '' }));
                if (source.isLocal && source.file) formData.append(\`file\${source.index}\`, source.file);
            });
            const res = await fetch('/merge_m3u', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                resultDiv.className = 'parse-result success';
                resultDiv.textContent = '合并成功！';
                resultDiv.style.display = 'block';
                document.getElementById('merged_url').value = data.url;
                document.getElementById('result_container').style.display = 'flex';
                nameInput.value = '';
                await loadMergedFileList();
                selectMergedFile(data.url);
            } else {
                resultDiv.className = 'parse-result error';
                resultDiv.textContent = '合并失败：' + data.error;
                resultDiv.style.display = 'block';
            }
        } catch (e) {
            resultDiv.className = 'parse-result error';
            resultDiv.textContent = '合并出错：' + e.message;
            resultDiv.style.display = 'block';
        } finally { btn.disabled = false; btn.textContent = '合并频道'; }
    });

    document.getElementById('copy_merge_btn').addEventListener('click', () => {
        const urlInput = document.getElementById('merged_url');
        if (!urlInput.value) return;
        urlInput.select();
        document.execCommand('copy');
        const btn = document.getElementById('copy_merge_btn');
        const originalText = btn.textContent;
        btn.textContent = '已复制！';
        setTimeout(() => { btn.textContent = originalText; }, 2000);
    });

    async function loadMergedFileList() {
        const listDiv = document.getElementById('merged_file_list');
        if (!listDiv) return;
        try {
            const res = await fetch('/list-merged-files');
            const data = await res.json();
            if (data.success && data.files.length > 0) {
                listDiv.innerHTML = '';
                data.files.forEach(file => {
                    const item = document.createElement('div');
                    item.className = 'merged-file-item';
                    item.dataset.url = file.url;
                    item.innerHTML = \`
                        <div class="merged-file-info">
                            <span class="merged-file-name">\${file.name}</span>
                            <span class="merged-file-meta">\${(file.size / 1024).toFixed(1)}KB · \${new Date(file.createdAt).toLocaleString()}</span>
                        </div>
                        <div class="merged-file-actions">
                            <button class="merged-file-select" data-url="\${file.url}">查看链接</button>
                            <button class="merged-file-delete" data-name="\${file.name}">删除</button>
                        </div>
                    \`;
                    listDiv.appendChild(item);
                });
                listDiv.querySelectorAll('.merged-file-select').forEach(btn => {
                    btn.addEventListener('click', function() { selectMergedFile(this.dataset.url); });
                });
                listDiv.querySelectorAll('.merged-file-delete').forEach(btn => {
                    btn.addEventListener('click', async function() {
                        const name = this.dataset.name;
                        if (!confirm(\`确认删除文件 "\${name}" 吗？\`)) return;
                        try {
                            const res = await fetch('/delete-merged-file', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ name })
                            });
                            const data = await res.json();
                            if (data.success) {
                                await loadMergedFileList();
                                const urlInput = document.getElementById('merged_url');
                                if (urlInput.value.endsWith('/' + name)) {
                                    urlInput.value = '';
                                    document.getElementById('result_container').style.display = 'none';
                                }
                            } else { alert('删除失败：' + data.error); }
                        } catch (e) { alert('删除出错：' + e.message); }
                    });
                });
            } else {
                listDiv.innerHTML = '<div class="merged-file-empty">暂无合并文件</div>';
            }
        } catch (e) {
            listDiv.innerHTML = \`<div class="merged-file-empty">加载失败：\${e.message}</div>\`;
        }
    }

    function selectMergedFile(url) {
        const urlInput = document.getElementById('merged_url');
        urlInput.value = url;
        document.getElementById('result_container').style.display = 'flex';
    }

    // ============ 文件上传 ============
    document.getElementById('upload-btn').addEventListener('click', async () => {
        const fileInput = document.getElementById('file-upload-input');
        const files = fileInput.files;
        const resultDiv = document.getElementById('upload-result');
        const uploadBtn = document.getElementById('upload-btn');
        if (files.length === 0) { resultDiv.className = 'parse-result error'; resultDiv.textContent = '请选择要上传的文件'; resultDiv.style.display = 'block'; return; }
        if (files.length > 3) { resultDiv.className = 'parse-result error'; resultDiv.textContent = '最多只能上传3个文件'; resultDiv.style.display = 'block'; return; }
        for (let i = 0; i < files.length; i++) {
            if (files[i].size > 1 * 1024 * 1024) { resultDiv.className = 'parse-result error'; resultDiv.textContent = \`文件 "\${files[i].name}" 超过1MB限制\`; resultDiv.style.display = 'block'; return; }
            const ext = files[i].name.substring(files[i].name.lastIndexOf('.')).toLowerCase();
            if (ext !== '.m3u' && ext !== '.txt') { resultDiv.className = 'parse-result error'; resultDiv.textContent = \`文件 "\${files[i].name}" 格式不支持，仅限 .m3u 或 .txt\`; resultDiv.style.display = 'block'; return; }
        }
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) { formData.append('files', files[i]); }
        try {
            uploadBtn.disabled = true; uploadBtn.textContent = '上传中...';
            resultDiv.style.display = 'none';
            const res = await fetch('/upload-files', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                resultDiv.className = 'parse-result success';
                resultDiv.textContent = \`上传成功！共上传 \${data.uploadedCount} 个文件\`;
                resultDiv.style.display = 'block';
                loadFileList();
                fileInput.value = '';
            } else {
                resultDiv.className = 'parse-result error';
                resultDiv.textContent = \`上传失败：\${data.error}\`;
                resultDiv.style.display = 'block';
            }
        } catch (e) {
            resultDiv.className = 'parse-result error';
            resultDiv.textContent = \`上传出错：\${e.message}\`;
            resultDiv.style.display = 'block';
        } finally { uploadBtn.disabled = false; uploadBtn.textContent = '上传文件'; }
    });

    async function loadFileList() {
        const fileListDiv = document.getElementById('file-list');
        try {
            const res = await fetch('/list-files');
            const data = await res.json();
            if (data.success && data.files.length > 0) {
                fileListDiv.innerHTML = '';
                data.files.forEach(file => {
                    const fileItem = document.createElement('div');
                    fileItem.className = 'file-item';
                    fileItem.style.marginBottom = '10px';
                    fileItem.innerHTML = \`
                        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%;">
                            <span style="flex: 1; word-break: break-all;">\${file.name}（\${(file.size / 1024).toFixed(1)}KB）</span>
                            <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                                <button class="copy-file-url btn-info" style="padding: 6px 12px; font-size: 13px;" data-url="\${file.url}">复制</button>
                                <button class="rename-file-btn btn-warning" style="padding: 6px 12px; font-size: 13px;" data-name="\${file.name}">重命名</button>
                                <a class="download-file-btn btn-success" style="padding: 6px 12px; font-size: 13px; text-decoration: none; color: white;" href="/download-file?name=\${encodeURIComponent(file.name)}" download>下载</a>
                                <button class="delete-file-btn btn-secondary" style="padding: 6px 12px; font-size: 13px;" data-name="\${file.name}">删除</button>
                            </div>
                        </div>
                    \`;
                    fileListDiv.appendChild(fileItem);
                });
                document.querySelectorAll('.copy-file-url').forEach(btn => {
                    btn.addEventListener('click', function() {
                        const url = this.dataset.url;
                        navigator.clipboard.writeText(url).then(() => {
                            const originalText = this.textContent;
                            this.textContent = '✓ 已复制';
                            setTimeout(() => this.textContent = originalText, 2000);
                        });
                    });
                });
                document.querySelectorAll('.rename-file-btn').forEach(btn => {
                    btn.addEventListener('click', function() {
                        window.currentRenameFile = this.dataset.name;
                        document.getElementById('rename_file_input').value = this.dataset.name;
                        document.getElementById('rename_modal').style.display = 'flex';
                    });
                });
                document.querySelectorAll('.delete-file-btn').forEach(btn => {
                    btn.addEventListener('click', async function() {
                        if (!confirm(\`确定要删除 "\${this.dataset.name}" 吗？\`)) return;
                        const res = await fetch('/delete-file', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: this.dataset.name })
                        });
                        const d = await res.json();
                        if (d.success) loadFileList();
                        else alert('删除失败：' + d.error);
                    });
                });
            } else {
                fileListDiv.innerHTML = '<div class="file-item">暂无上传的文件</div>';
            }
        } catch (e) {
            fileListDiv.innerHTML = \`<div class="file-item error">加载文件列表失败：\${e.message}</div>\`;
        }
    }

    window.closeRenameModal = () => {
        document.getElementById('rename_modal').style.display = 'none';
        window.currentRenameFile = null;
    };

    window.submitRename = async () => {
        const newName = document.getElementById('rename_file_input').value.trim();
        if (!newName || (!newName.endsWith('.m3u') && !newName.endsWith('.txt'))) {
            alert('文件后缀必须是 .m3u 或 .txt');
            return;
        }
        const res = await fetch('/rename-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldName: window.currentRenameFile, newName })
        });
        const d = await res.json();
        if (d.success) {
            closeRenameModal();
            loadFileList();
        } else {
            alert('重命名失败：' + d.error);
        }
    };

    // ============ 初始化 ============
    loadYykm();
    loadReplaceRules();

    window.onload = () => {
        initTabs();
        if (document.querySelector('.tab[data-tab="file-upload"].active')) loadFileList();
        if (document.querySelector('.tab[data-tab="channel-merge"].active')) loadMergedFileList();
    };
  `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>天光云影配置管理</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
        body { margin: 0; padding: 15px; line-height: 1.6; background: #f5f5f5; color: #333; font-size: 14px; }
        header { text-align: center; padding: 15px 0; margin-bottom: 20px; background: linear-gradient(135deg, #007bff, #0056b3); border-radius: 12px; box-shadow: 0 4px 12px rgba(0, 123, 255, 0.2); position: relative; }
        header h1 { color: white; font-size: 20px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); }
        .header-actions { position: absolute; right: 15px; top: 50%; transform: translateY(-50%); }
        .change-password-btn { background: rgba(255, 255, 255, 0.2); color: white; border: 1px solid rgba(255, 255, 255, 0.3); padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: all 0.3s ease; }
        .change-password-btn:hover { background: rgba(255, 255, 255, 0.3); }
        .tabs { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid #e0e0e0; padding-bottom: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
        .tabs::-webkit-scrollbar { display: none; }
        .tab { padding: 12px 16px; border: none; background: #f8f9fa; cursor: pointer; border-radius: 8px; font-size: 14px; font-weight: 500; white-space: nowrap; flex-shrink: 0; transition: all 0.3s ease; border: 1px solid transparent; }
        .tab.active { background: #007bff; color: white; box-shadow: 0 2px 8px rgba(0, 123, 255, 0.3); transform: translateY(-1px); }
        .tab:not(.active):hover { background: #e9ecef; border-color: #dee2e6; }
        .tab-content { display: none; padding: 20px; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; }
        .tab-content.active { display: block; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; color: #2c3e50; font-size: 15px; }
        input, select, textarea { width: 100%; padding: 12px 16px; border: 2px solid #e9ecef; border-radius: 8px; font-size: 15px; transition: all 0.3s ease; background: #f8f9fa; }
        textarea { min-height: 100px; resize: vertical; }
        input:focus, select:focus, textarea:focus { outline: none; border-color: #007bff; background: white; box-shadow: 0 0 0 3px rgba(0,123,255,0.1); }
        button { padding: 14px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; transition: all 0.3s ease; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
        .btn-primary { background: linear-gradient(135deg, #007bff, #0056b3); color: white; box-shadow: 0 2px 8px rgba(0, 123, 255, 0.3); }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0, 123, 255, 0.4); }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-success { background: linear-gradient(135deg, #28a745, #1e7e34); color: white; box-shadow: 0 2px 8px rgba(40, 167, 69, 0.3); }
        .btn-warning { background: linear-gradient(135deg, #ffc107, #e0a800); color: black; box-shadow: 0 2px 8px rgba(255, 193, 7, 0.3); }
        .btn-info { background: linear-gradient(135deg, #17a2b8, #138496); color: white; box-shadow: 0 2px 8px rgba(23, 162, 184, 0.3); }
        .bottom-actions { margin-top: 30px; display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
        .bottom-actions > button { flex: 1; min-width: 120px; }
        .config-url-container { margin: 25px 0 15px; padding: 18px; background: linear-gradient(135deg, #e3f2fd, #bbdefb); border-radius: 12px; border: 2px dashed #90caf9; box-shadow: 0 2px 8px rgba(33, 150, 243, 0.1); display: none; }
        .config-url-container.active { display: block; }
        .url-container { display: flex; flex-direction: column; gap: 12px; margin: 12px 0; }
        .url-container input { flex: 1; padding: 12px 16px; border: 2px solid #b3d1ff; border-radius: 8px; font-family: monospace; font-size: 14px; background: white; }
        .url-container button { padding: 12px 20px; background: linear-gradient(135deg, #007bff, #0056b3); color: white; border: none; border-radius: 8px; cursor: pointer; transition: all 0.3s ease; font-weight: 600; }
        .url-container button:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0, 123, 255, 0.3); }
        .url-container button.copied { background: linear-gradient(135deg, #28a745, #1e7e34); }
        .config-url-container small { text-align: center; color: #546e7a; font-size: 13px; display: block; }
        .cloud-sync-info { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: linear-gradient(135deg, #e8f5e9, #c8e6c9); border-radius: 8px; border-left: 4px solid #4caf50; color: #2e7d32; font-weight: 600; font-size: 15px; }
        .cloud-sync-info .icon { font-size: 18px; }
        .cloud-sync-info small { color: #388e3c; font-weight: 400; font-size: 12px; margin-top: 4px; display: block; }
        .parse-result { margin-top: 15px; padding: 14px 16px; border-radius: 8px; display: none; font-weight: 500; border-left: 4px solid; }
        .success { background: #d4edda; color: #155724; border-left-color: #28a745; }
        .error { background: #f8d7da; color: #721c24; border-left-color: #dc3545; }
        small { color: #6c757d; font-size: 13px; display: block; margin-top: 6px; line-height: 1.4; }
        .file-item { padding: 12px; border-bottom: 1px dashed #e9ecef; background: white; border-radius: 8px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .file-item:last-child { border-bottom: none; }
        .copy-file-url { padding: 8px 16px; font-size: 13px; background: linear-gradient(135deg, #007bff, #0056b3); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); align-items: center; justify-content: center; z-index: 1000; padding: 20px; }
        .modal-content { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); width: 100%; max-width: 400px; }
        .modal-header { margin-bottom: 20px; }
        .modal-header h3 { color: #2c3e50; font-size: 18px; font-weight: 600; }
        .modal-actions { display: flex; gap: 12px; margin-top: 20px; }
        .modal-actions button { flex: 1; }
        .source-controls { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
        .source-controls-row { display: flex; gap: 10px; flex-wrap: wrap; }
        .source-controls-row button { flex: 1; min-width: 140px; }
        .source-item { border: 2px solid #e9ecef; padding: 16px; border-radius: 12px; margin-bottom: 16px; background: #f8f9fa; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .source-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #e9ecef; }
        .source-header h4 { margin: 0; color: #2c3e50; font-size: 16px; font-weight: 600; }
        .source-header-actions { display: flex; gap: 8px; }
        .parse-source-btn { background: #ffc107; color: black; border: none; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
        .parse-source-btn:hover { background: #e0a800; transform: translateY(-1px); }
        .parse-source-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .remove-source-btn { background: #dc3545; color: white; border: none; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
        .remove-source-btn:hover { background: #c82333; transform: translateY(-1px); }
        .source-groups { margin-top: 12px; padding: 12px; background: white; border-radius: 8px; border: 1px solid #e9ecef; }
        .source-groups-title { font-weight: 600; color: #495057; margin-bottom: 10px; font-size: 14px; }
        .source-groups-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
        .group-checkbox-item { display: flex; align-items: center; gap: 8px; padding: 8px; background: white; border-radius: 6px; border: 1px solid #e9ecef; }
        .group-checkbox-item input { width: 18px; height: 18px; margin: 0; }
        #selection_result_container { margin: 16px 0; padding: 16px; border: 2px solid #e9ecef; border-radius: 12px; background: white; display: none; }
        #selection_result_container h3 { margin-bottom: 12px; color: #495057; font-size: 16px; font-weight: 600; }
        .order-list { display: flex; flex-direction: column; gap: 10px; }
        .order-item { padding: 12px; background: #f8f9fa; border-radius: 8px; display: flex; align-items: center; font-size: 14px; border: 1px solid #e9ecef; gap: 8px; }
        .order-number { display: inline-flex; width: 28px; height: 28px; line-height: 28px; text-align: center; background: linear-gradient(135deg, #007bff, #0056b3); color: white; border-radius: 50%; font-size: 13px; font-weight: 600; align-items: center; justify-content: center; flex-shrink: 0; }
        .order-source { display: inline-flex; padding: 4px 10px; background: #e9f5ff; color: #007bff; border-radius: 6px; font-size: 12px; font-weight: 600; flex-shrink: 0; }
        .order-name { flex: 1; font-weight: 500; word-break: break-word; }
        .remove-btn { background: transparent; color: #dc3545; border: none; width: 28px; height: 28px; border-radius: 50%; font-size: 18px; padding: 0; margin: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.3s ease; }
        .remove-btn:hover { background: #dc3545; color: white; transform: scale(1.1); }
        #result_container { margin: 16px 0; display: none; flex-direction: column; gap: 12px; }
        #merged_url { flex: 1; padding: 12px 16px; border: 2px solid #e9ecef; border-radius: 8px; font-size: 15px; background: #f8f9fa; }
        .merge-name-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
        .merge-name-row input { flex: 1; min-width: 200px; }
        .merged-file-list { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
        .merged-file-item { padding: 12px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
        .merged-file-info { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 180px; }
        .merged-file-name { font-weight: 600; color: #2c3e50; word-break: break-all; }
        .merged-file-meta { font-size: 12px; color: #6c757d; }
        .merged-file-actions { display: flex; gap: 8px; }
        .merged-file-select { padding: 8px 12px; font-size: 13px; background: #17a2b8; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; }
        .merged-file-delete { padding: 8px 12px; font-size: 13px; background: #dc3545; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; }
        .merged-file-empty { color: #6c757d; padding: 12px; text-align: center; background: #f8f9fa; border-radius: 8px; }
        .replace-rules-section { margin-top: 16px; }
        .replace-rules-toggle { background: #e9ecef; color: #495057; border: none; padding: 10px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; width: 100%; text-align: left; }
        .replace-rules-toggle:hover { background: #dee2e6; }
        .replace-rules-body { margin-top: 10px; padding: 12px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef; }
        .replace-rules-hint { font-size: 12px; color: #6c757d; margin-bottom: 10px; line-height: 1.5; }
        .replace-rule-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
        .replace-rule-row input { flex: 1; min-width: 120px; padding: 8px 10px; font-size: 13px; border: 1px solid #dee2e6; border-radius: 6px; background: white; }
        .replace-rule-row button { padding: 8px 12px; font-size: 12px; background: #dc3545; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; }
        .replace-rule-row button:hover { background: #c82333; }
        @media (max-width: 768px) {
            body { padding: 12px; font-size: 14px; }
            header { padding: 12px 40px 12px 12px; margin-bottom: 16px; border-radius: 10px; }
            header h1 { font-size: 18px; }
            .header-actions { right: 8px; }
            .change-password-btn { padding: 4px 8px; font-size: 11px; }
            .tab { padding: 10px 14px; font-size: 13px; border-radius: 6px; }
            .tab-content { padding: 16px; border-radius: 10px; }
            input, select, textarea { padding: 14px 16px; font-size: 16px; }
            button { padding: 16px 20px; font-size: 16px; }
            .bottom-actions { flex-direction: column; gap: 10px; }
            .bottom-actions > button { width: 100%; }
            .source-groups-list { grid-template-columns: 1fr; }
            .group-checkbox-item { padding: 10px; }
            .source-controls-row { flex-direction: column; }
            .source-controls-row button { width: 100%; }
            .url-container { gap: 10px; }
            .file-item > div { flex-direction: column; gap: 10px; align-items: stretch; }
            .order-item { flex-wrap: wrap; gap: 6px; }
            .order-name { min-width: 100%; order: 3; margin-top: 6px; }
            .modal { padding: 10px; }
            .source-header { flex-direction: column; align-items: flex-start; gap: 8px; }
        }
        @media (min-width: 769px) and (max-width: 1024px) {
            .group-columns { flex-direction: row; flex-wrap: wrap; }
            .group-column { flex: 1; min-width: 250px; }
        }
        @media (min-width: 1025px) {
            body { max-width: 1200px; margin: 0 auto; padding: 20px; }
            .source-controls { flex-direction: row; flex-wrap: wrap; }
            .source-controls-row { flex: 1; }
            #result_container { flex-direction: row; align-items: center; }
            .url-container { flex-direction: row; align-items: center; }
        }
            /* ===== source-content 行内紧凑布局 ===== */
        #source-content .form-row, #yykm-content .form-row {
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            margin-bottom: 9px !important;
        }
        #source-content .form-row > label, #yykm-content .form-row > label {
            flex: 0 0 46px !important;
            margin: 0 !important;
            padding: 0 !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            color: #2c3e50 !important;
            white-space: nowrap !important;
            text-align: left !important;
            display: block !important;
        }
        #source-content .form-row > input, #yykm-content .form-row > input,
        #source-content .form-row > select, #yykm-content .form-row > select {
            flex: 1 !important;
            min-width: 0 !important;
            width: auto !important;
            height: 38px !important;
            padding: 4px 12px !important;
            font-size: 15px !important;
            line-height: 1.2 !important;
            border-width: 1px !important;
            margin: 0 !important;
            border-radius: 8px !important;
        }
        @media (max-width: 768px) {
            #source-content .form-row > input, #yykm-content .form-row > input,
            #source-content .form-row > select, #yykm-content .form-row > select {
                font-size: 16px !important;
                height: 42px !important;
            }
        }
    </style>
</head>

<body>
    <header>
        <h1>天光云影配置管理</h1>
        <div class="header-actions">
            <button class="change-password-btn" id="change_password_btn">修改密码</button>
        </div>
    </header>

    <div class="tabs">
        <button class="tab active" data-tab="source">天光云影同步配置</button>
        <button class="tab" data-tab="yykm">云影空蒙同步配置</button>
        <button class="tab" data-tab="channel-merge">频道合并</button>
        <button class="tab" data-tab="file-upload">文件上传</button>
    </div>

    <div class="tab-content active" id="source-content">
        <form id="source-form">
            <div class="form-row">
                <label>名字</label>
                <input type="text" name="source_name" value="${escapeHtml(iptvSourceCurrent && iptvSourceCurrent.name || '')}" placeholder="直播源名字">
            </div>
            <div class="form-row">
                <label>地址</label>
                <input type="text" name="current_source_url" value="${escapeHtml(iptvSourceCurrent && iptvSourceCurrent.url || '')}" placeholder="http://xxx.com/all.m3u">
            </div>
            <div class="form-row">
                <label>UA</label>
                <input type="text" name="user_agent" value="${escapeHtml(videoPlayerUserAgent || '')}" placeholder="okHttp/Mod-1.4.0.0">
            </div>
            <div class="form-row">
                <label>EPG</label>
                <input type="text" name="epg_url" value="${escapeHtml(epgSourceCurrent && epgSourceCurrent.url || '')}" placeholder="EPG节目单链接（可选）">
            </div>
            <div class="form-row">
                <label>模式</label>
                <select name="hybrid_mode">
                    <option value="DISABLE" ${iptvHybridMode === 'DISABLE' ? 'selected' : ''}>禁用</option>
                    <option value="IPTV_FIRST" ${iptvHybridMode === 'IPTV_FIRST' ? 'selected' : ''}>直播源优先</option>
                    <option value="HYBRID_FIRST" ${iptvHybridMode === 'HYBRID_FIRST' ? 'selected' : ''}>混合优先</option>
                </select>
            </div>
            <div class="form-group" style="margin-top: 14px;">
                <label>频道分组管理</label>
                <div class="source-controls-row">
                    <button type="button" class="btn-warning" id="parse_groups_btn">解析频道分组</button>
                    <button type="button" class="btn-success" id="save_hide_groups_btn" style="display: none;">保存隐藏设置</button>
                </div>
                <div id="group_parse_result" class="parse-result"></div>
                <div id="group_checkbox_container" class="group-checkbox-list" style="display: none;">
                    <div id="group_checkbox_list">
                        <div>暂无分组数据，请先点击「解析频道分组」</div>
                    </div>
                </div>
                <small>勾选要隐藏的分组（App 内不显示）</small>
            </div>
        </form>
        <div class="bottom-actions">
            <button type="submit" form="source-form" class="btn-primary">保存天光云影同步配置</button>
            <button type="button" class="btn-info" id="manual_check_btn">检测播放源</button>
        </div>
    </div>

    <div class="tab-content" id="yykm-content">
        <form id="yykm-form">
            <div class="form-row">
                <label>名称</label>
                <input type="text" id="yykm_name" placeholder="订阅源名称">
            </div>
            <div class="form-row">
                <label>地址</label>
                <input type="text" id="yykm_uri" placeholder="http://xxx.com/all.m3u">
            </div>
            <div class="form-row">
                <label>EPG</label>
                <input type="text" id="yykm_epg" placeholder="EPG节目单链接（可选）">
            </div>
            <div class="form-row">
                <label>UA</label>
                <input type="text" id="yykm_ua" value="okHttp/Mod-1.4.0.0" placeholder="okHttp/Mod-1.4.0.0">
            </div>
        </form>
        <div class="bottom-actions" style="margin-top: 14px;">
            <button type="button" class="btn-primary" id="yykm_save_btn">保存配置</button>
        </div>
        <div class="url-container" style="margin-top: 20px; display: flex; flex-direction: column; gap: 10px;">
            <label>同步地址：</label>
            <div style="display: flex; gap: 10px; width: 100%; flex-wrap: wrap;">
                <input type="text" id="yykm_config_url" readonly style="background: #f8f9fa; flex: 1; min-width: 200px; margin: 0;">
                <button type="button" class="btn-primary" id="copy_yykm_url_btn" style="white-space: nowrap; width: auto; padding: 10px 20px; margin: 0;">复制地址</button>
            </div>
        </div>
    </div>

    <div class="tab-content" id="channel-merge-content">
        <h3>频道合并工具</h3>
        <p style="margin-bottom: 16px; color: #6c757d;">添加多个M3U源，分别解析后选择需要合并的频道分组，按勾选顺序生成合并后的播放列表。</p>

        <div class="source-controls">
            <div class="source-controls-row">
                <button id="add_url_source_btn" class="btn-primary">添加URL源</button>
                <button id="add_local_source_btn" class="btn-success">添加本地源</button>
            </div>
        </div>

        <div id="sources_container"></div>

        <div class="groups-container" id="groups_container">
            <div id="selection_result_container">
                <h3>已选分组（按勾选顺序排列）</h3>
                <div class="order-list" id="selected_order_list"></div>
                <p style="margin-top: 10px; font-size: 13px; color: #6c757d;">
                    勾选分组将按顺序添加到列表中，点击×可移除。重名分组会自动添加序号区分。
                </p>
            </div>
        </div>

        <div class="merge-name-row">
            <input type="text" id="merge_file_name" placeholder="输入文件名（字母/数字/下划线/连字符）">
            <button id="merge_btn" class="btn-success">合并频道</button>
        </div>
        <div id="merge_result" class="parse-result"></div>

        <div id="result_container">
            <input type="text" id="merged_url" readonly placeholder="合并后的链接将显示在这里">
            <button id="copy_merge_btn" class="btn-info">复制链接</button>
        </div>
        <div class="replace-rules-section">
            <button type="button" class="replace-rules-toggle" id="replace_rules_toggle">▸ 地址替换（可选）</button>
            <div class="replace-rules-body" id="replace_rules_body" style="display:none;">
                <p class="replace-rules-hint">合并时把频道地址里的字符串替换成内网地址。例如：http://fn.qinyin.eu.org:1001 → http://192.168.0.5:1001</p>
                <div id="replace_rules_list"></div>
                <button type="button" class="btn-secondary" id="add_replace_rule_btn" style="margin-top: 8px;">添加规则</button>
            </div>
        </div>

        <h3 style="margin-top: 25px;">合并文件管理</h3>
        <div class="merged-file-list" id="merged_file_list">
            <div class="merged-file-empty">暂无合并文件</div>
        </div>
    </div>

    <div class="tab-content" id="file-upload-content">
        <h3>文件上传</h3>
        <p style="margin-bottom: 16px; color: #6c757d;">仅限 m3u 与 txt 文件，最大1MB，最多3个文件</p>
        <div class="form-group inline">
            <label>选择文件</label>
            <input type="file" id="file-upload-input" multiple accept=".m3u,.txt" style="padding: 12px;">
            <small>支持 .m3u 和 .txt 格式，单个文件不超过1MB，最多上传3个文件</small>
        </div>
        <button id="upload-btn" class="btn-primary" style="width: 100%;">上传文件</button>
        <div id="upload-result" class="parse-result" style="margin-top: 20px;"></div>
        <h3 style="margin-top: 25px;">已上传文件</h3>
        <div id="file-list" style="margin-top: 15px;">
            <div class="file-item">暂无上传的文件</div>
        </div>
    </div>

    <div class="config-url-container" id="config-url-container">
        <div class="url-container">
            <input type="text" id="config_file_url" value="${escapeHtml(fullConfigUrl)}" readonly>
            <button id="copy_url_btn">复制配置地址</button>
        </div>
        <small>复制上面链接地址放入应用的云同步网络链接</small>
    </div>

    <div class="modal" id="rename_modal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000; padding: 20px;">
        <div class="modal-content" style="background: white; padding: 24px; border-radius: 12px; width: 100%; max-width: 400px;">
            <h3 style="margin-bottom: 20px; color: #2c3e50; font-size: 18px;">重命名文件</h3>
            <input type="text" id="rename_file_input" style="width: 100%; padding: 12px 16px; border: 2px solid #e9ecef; border-radius: 8px; font-size: 15px; margin-bottom: 10px;">
            <small style="color: #6c757d; display: block; margin-bottom: 20px;">仅限 .m3u 或 .txt 后缀</small>
            <div style="display: flex; gap: 12px;">
                <button type="button" class="btn-secondary" onclick="closeRenameModal()" style="flex: 1;">取消</button>
                <button type="button" class="btn-primary" onclick="submitRename()" style="flex: 1;">确认</button>
            </div>
        </div>
    </div>

    <div class="modal" id="password_modal">
        <div class="modal-content">
            <div class="modal-header">
                <h3 id="modal_title">修改访问密码</h3>
            </div>
            <form id="password_modal_form"></form>
            <div id="modal_error" class="parse-result error" style="display: none; margin-top: 15px;"></div>
        </div>
    </div>

    <script>${pageScript}</script>
</body>
</html>
  `;
};

// ============ 云影空蒙默认配置 ============
const getDefaultYykm = () => ({
  version: "3.8.4",
  syncAt: Date.now(),
  syncFrom: "云影空蒙配置管理",
  configs: {
    channelSourceList: [],
    videoPlayerUserAgent: "okHttp/Mod-1.4.0.0"
  }
});

// ============ 主请求处理 ============
const handleRequest = async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // ===== 云影空蒙 JSON（公开，无需密码）=====
  if (path === '/yykm.json' && request.method === 'GET') {
    const raw = await globalThis.CONFIG_KV.get(YYKM_KEY);
    const config = raw ? JSON.parse(raw) : getDefaultYykm();
    return new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } });
  }

  // ===== 合并后的 M3U 公开访问：/{name}.m3u =====
  if (request.method === 'GET' && /^\/[a-zA-Z0-9_-]+\.m3u$/.test(path)) {
    const name = path.substring(1);
    const content = await globalThis.CONFIG_KV.get(MERGED_PREFIX + name);
    if (!content) return new Response('文件不存在', { status: 404 });
    return new Response(content, { headers: { 'Content-Type': 'application/x-mpegURL' } });
  }

  // ===== 天光云影配置 JSON（公开，App 云同步用）=====
  if (path === '/all_configs.json' && request.method === 'GET') {
    try {
      const config = await loadConfig();
      return new Response(JSON.stringify(config, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  const handlerWithAuth = requirePassword(async (request, url) => {
    const path = url.pathname;

    if (path === '/' && request.method === 'GET') {
      return new Response(await getIndexHtml(request.url), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/verify-password' && request.method === 'POST') {
      try {
        const { password, action } = await request.json();
        const storedPassword = await loadPassword();
        if (action === 'setup') {
          if (!validatePassword(password)) {
            return new Response(JSON.stringify({ success: false, error: '密码长度必须为6-12位' }), { headers: { 'Content-Type': 'application/json' } });
          }
          await savePassword(password);
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'auth=true; Path=/; HttpOnly; SameSite=Strict' } });
        } else {
          if (password === storedPassword) {
            return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'auth=true; Path=/; HttpOnly; SameSite=Strict' } });
          } else {
            return new Response(JSON.stringify({ success: false, error: '密码错误' }), { headers: { 'Content-Type': 'application/json' } });
          }
        }
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/change-password' && request.method === 'POST') {
      try {
        const { currentPassword, newPassword } = await request.json();
        const storedPassword = await loadPassword();
        if (currentPassword !== storedPassword) return new Response(JSON.stringify({ success: false, error: '当前密码错误' }), { headers: { 'Content-Type': 'application/json' } });
        if (!validatePassword(newPassword)) return new Response(JSON.stringify({ success: false, error: '新密码长度必须为6-12位' }), { headers: { 'Content-Type': 'application/json' } });
        await savePassword(newPassword);
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/parse_channels' && request.method === 'POST') {
      const config = await loadConfig();
      const { iptvSourceCurrent } = config.configs;
      if (!iptvSourceCurrent || !iptvSourceCurrent.url) {
        return new Response(JSON.stringify({ success: false, error: '请先填写有效的播放源链接' }), { headers: { 'Content-Type': 'application/json' } });
      }
      try {
        const groups = await parseM3uGroups(iptvSourceCurrent.url);
        config.configs.iptvChannelGroups = { value: groups };
        await saveConfig(config);
        return new Response(JSON.stringify({ success: true, groups, count: groups.length }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/batch_hide_groups' && request.method === 'POST') {
      const config = await loadConfig();
      const { selected_groups } = await request.json();
      config.configs.iptvChannelGroupHiddenList = selected_groups || [];
      const success = await saveConfig(config);
      return new Response(JSON.stringify({ success, hidden_count: selected_groups ? selected_groups.length : 0 }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/manual_check' && request.method === 'POST') {
      try {
        const result = await checkIptvSource();
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // ===== 保存天光云影配置 =====
    if (path === '/save_source_config' && request.method === 'POST') {
      const config = await loadConfig();
      const body = await request.json();
      const { source_name, current_source_url, user_agent, epg_url, hybrid_mode } = body;

      if (current_source_url !== undefined && current_source_url !== '') {
        // 名字：用户填了就用手填的，留空则自动生成 iptv+日期时间
        let finalName = (source_name || '').trim();
        if (!finalName) finalName = generateIptvName();

        const src = { name: finalName, url: current_source_url, isLocal: false, transformJs: null };
        config.configs.iptvSourceCurrent = src;
        // iptvSourceList.value 与 iptvSourceCurrent 完全一致（永远只有1条）
        config.configs.iptvSourceList = { value: [src] };
      }

      if (user_agent !== undefined) config.configs.videoPlayerUserAgent = user_agent;
      if (epg_url !== undefined) {
        config.configs.epgSourceCurrent = { name: (config.configs.epgSourceCurrent && config.configs.epgSourceCurrent.name) || '默认节目单', url: epg_url };
      }

      // 固定开启云同步
      if (hybrid_mode !== undefined) config.configs.iptvHybridMode = hybrid_mode;
      config.configs.cloudSyncAutoPull = true;
      config.configs.epgEnable = true;

      await saveConfig(config);
      return new Response(JSON.stringify({ success: true, message: '配置保存成功！页面将刷新...', refresh: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ===== 上传文件 =====
    if (path === '/upload-files' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const files = formData.getAll('files');
        if (files.length > 3) return new Response(JSON.stringify({ success: false, error: '最多只能上传3个文件' }), { headers: { 'Content-Type': 'application/json' } });

        const raw = await globalThis.CONFIG_KV.get(UPLOADED_FILES_KEY);
        let existingFiles = raw ? JSON.parse(raw) : [];
        const uploadedFiles = [];

        let maxWjNum = 0;
        existingFiles.forEach(f => {
          const match = f.name.match(/^wj(\d+)\.(m3u|txt)$/i);
          if (match) { const num = parseInt(match[1]); if (num > maxWjNum) maxWjNum = num; }
        });

        for (const file of files) {
          if (file.size > 1 * 1024 * 1024) return new Response(JSON.stringify({ success: false, error: '文件 "' + file.name + '" 超过1MB限制' }), { headers: { 'Content-Type': 'application/json' } });
          const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
          if (ext !== '.m3u' && ext !== '.txt') return new Response(JSON.stringify({ success: false, error: '仅支持 .m3u 和 .txt 文件' }), { headers: { 'Content-Type': 'application/json' } });

          maxWjNum++;
          const originalName = 'wj' + maxWjNum + ext;
          const arrayBuffer = await file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          let binary = '';
          const chunkSize = 0x8000;
          for (let i = 0; i < uint8Array.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, uint8Array.subarray(i, i + chunkSize));
          }
          const fileContent = btoa(binary);
          const urlObj = new URL(request.url);
          const fileInfo = {
            name: originalName, key: 'upload_' + originalName, safeName: originalName,
            size: file.size, content: fileContent, uploadedAt: Date.now(),
            url: urlObj.protocol + '//' + urlObj.host + '/' + originalName
          };
          uploadedFiles.push(fileInfo);
          existingFiles.push(fileInfo);
        }

        if (existingFiles.length > 3) existingFiles.splice(0, existingFiles.length - 3);
        await globalThis.CONFIG_KV.put(UPLOADED_FILES_KEY, JSON.stringify(existingFiles));
        return new Response(JSON.stringify({ success: true, uploadedCount: uploadedFiles.length, files: uploadedFiles.map(f => ({ name: f.name, size: f.size, url: f.url })) }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/list-files' && request.method === 'GET') {
      try {
        const raw = await globalThis.CONFIG_KV.get(UPLOADED_FILES_KEY);
        const files = raw ? JSON.parse(raw) : [];
        const fileMetadata = files.map(file => ({ name: file.name, size: file.size, uploadedAt: file.uploadedAt, url: file.url }));
        return new Response(JSON.stringify({ success: true, files: fileMetadata }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/rename-file' && request.method === 'POST') {
      try {
        const { oldName, newName } = await request.json();
        const raw = await globalThis.CONFIG_KV.get(UPLOADED_FILES_KEY);
        const existingFiles = raw ? JSON.parse(raw) : [];
        const fileIndex = existingFiles.findIndex(f => f.name === oldName);
        if (fileIndex === -1) return new Response(JSON.stringify({ success: false, error: '文件不存在' }), { headers: { 'Content-Type': 'application/json' } });
        const ext = newName.substring(newName.lastIndexOf('.')).toLowerCase();
        if (ext !== '.m3u' && ext !== '.txt') return new Response(JSON.stringify({ success: false, error: '仅支持 .m3u 和 .txt 格式' }), { headers: { 'Content-Type': 'application/json' } });
        const safeFileName = newName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const urlObj = new URL(request.url);
        existingFiles[fileIndex].name = newName;
        existingFiles[fileIndex].safeName = safeFileName;
        existingFiles[fileIndex].url = urlObj.protocol + '//' + urlObj.host + '/' + safeFileName;
        await globalThis.CONFIG_KV.put(UPLOADED_FILES_KEY, JSON.stringify(existingFiles));
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/delete-file' && request.method === 'POST') {
      try {
        const { name } = await request.json();
        const raw = await globalThis.CONFIG_KV.get(UPLOADED_FILES_KEY);
        let existingFiles = raw ? JSON.parse(raw) : [];
        existingFiles = existingFiles.filter(f => f.name !== name);
        await globalThis.CONFIG_KV.put(UPLOADED_FILES_KEY, JSON.stringify(existingFiles));
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/download-file' && request.method === 'GET') {
      try {
        const fileName = url.searchParams.get('name');
        const raw = await globalThis.CONFIG_KV.get(UPLOADED_FILES_KEY);
        const existingFiles = raw ? JSON.parse(raw) : [];
        const matchFile = existingFiles.find(f => f.name === fileName);
        if (!matchFile) return new Response(JSON.stringify({ error: '文件不存在' }), { status: 404 });
        const fileContent = atob(matchFile.content);
        const uint8Array = new Uint8Array(fileContent.length);
        for (let i = 0; i < fileContent.length; i++) uint8Array[i] = fileContent.charCodeAt(i);
        return new Response(uint8Array, {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(fileName) + '"' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // ===== 单源解析 =====
    if (path === '/parse_merge_source' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const sourceIndex = formData.get('sourceIndex');
        const sourceType = formData.get('sourceType');
        let data;
        if (sourceType === 'url') {
          const srcUrl = formData.get('url');
          if (!srcUrl) throw new Error('缺少URL');
          data = await parseM3uContent(srcUrl, null, '');
        } else {
          const file = formData.get('file');
          if (!file) throw new Error('缺少文件');
          const fileContent = await file.text();
          data = await parseM3uContent('local_' + sourceIndex, fileContent, '');
        }
        return new Response(JSON.stringify({ success: true, groups: data.groups }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // ===== 合并并保存 =====
    if (path === '/merge_m3u' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const name = sanitizeFileName(formData.get('name'));
        if (!name) return new Response(JSON.stringify({ success: false, error: '文件名无效' }), { headers: { 'Content-Type': 'application/json' } });
        const fileName = name.endsWith('.m3u') ? name : name + '.m3u';

        const index = await loadMergedIndex();
        if (index.some(f => f.name === fileName)) return new Response(JSON.stringify({ success: false, error: '文件名已存在，请换一个' }), { headers: { 'Content-Type': 'application/json' } });

        const selectedGroups = JSON.parse(formData.get('selectedGroups'));
        const groupOrder = JSON.parse(formData.get('groupOrder'));
        const groupMap = JSON.parse(formData.get('groupMap') || '{}');

        let replaceRules = [];
        try {
          const rawRules = formData.get('replaceRules');
          if (rawRules) { const parsed = JSON.parse(rawRules); if (Array.isArray(parsed)) replaceRules = parsed.filter(r => r && r.from && r.to); }
        } catch (e) { replaceRules = []; }

        const sourcesData = [];
        const files = [];
        for (const [key, value] of formData.entries()) {
          if (key === 'sources') sourcesData.push(JSON.parse(value));
          else if (key.startsWith('file')) files.push({ key, file: value });
        }
        const sources = sourcesData.map(({ index: idx, name: srcName, isLocal, url: srcUrl }) => {
          if (isLocal) {
            const fileEntry = files.find(f => f.key === 'file' + idx);
            if (fileEntry) return { index: idx, name: srcName, isLocal: true, file: fileEntry.file };
          } else return { index: idx, name: srcName, isLocal: false, url: srcUrl };
          return null;
        }).filter(Boolean);

        // 用 groupMap 修正：把处理名还原成原始分组名
        const correctedSelectedGroups = {};
        for (const [srcIdx, list] of Object.entries(selectedGroups)) {
          correctedSelectedGroups[srcIdx] = list.map(processedName => {
            const entry = groupMap[processedName];
            return entry ? entry.originalName : processedName;
          });
        }

        const result = await mergeM3uFiles(sources, selectedGroups, groupOrder, groupMap, '', replaceRules);
        if (!result.success) return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

        const content = result.content;
        await globalThis.CONFIG_KV.put(MERGED_PREFIX + fileName, content);

        const urlObj = new URL(request.url);
        const publicUrl = urlObj.protocol + '//' + urlObj.host + '/' + fileName;
        const newIndexEntry = { name: fileName, size: new Blob([content]).size, createdAt: Date.now(), url: publicUrl };
        index.push(newIndexEntry);
        await saveMergedIndex(index);
        await globalThis.CONFIG_KV.put(REPLACE_RULES_KEY, JSON.stringify(replaceRules));
        return new Response(JSON.stringify({ success: true, url: publicUrl, name: fileName }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/get_replace_rules' && request.method === 'GET') {
      try {
        const raw = await globalThis.CONFIG_KV.get(REPLACE_RULES_KEY);
        const rules = raw ? JSON.parse(raw) : [];
        return new Response(JSON.stringify({ success: true, rules: Array.isArray(rules) ? rules : [] }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/list-merged-files' && request.method === 'GET') {
      try {
        const index = await loadMergedIndex();
        return new Response(JSON.stringify({ success: true, files: index }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/delete-merged-file' && request.method === 'POST') {
      try {
        const { name } = await request.json();
        const safeName = sanitizeFileName(name);
        if (!safeName) return new Response(JSON.stringify({ success: false, error: '文件名无效' }), { headers: { 'Content-Type': 'application/json' } });
        const fileName = safeName.endsWith('.m3u') ? safeName : safeName + '.m3u';
        await globalThis.CONFIG_KV.delete(MERGED_PREFIX + fileName);
        let index = await loadMergedIndex();
        index = index.filter(f => f.name !== fileName);
        await saveMergedIndex(index);
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // ===== 云影空蒙 =====
    if (path === '/get_yykm' && request.method === 'GET') {
      const raw = await globalThis.CONFIG_KV.get(YYKM_KEY);
      const config = raw ? JSON.parse(raw) : getDefaultYykm();
      return new Response(JSON.stringify({ success: true, config }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/save_yykm' && request.method === 'POST') {
      const body = await request.json();
      const raw = await globalThis.CONFIG_KV.get(YYKM_KEY);
      const config = raw ? JSON.parse(raw) : getDefaultYykm();
      config.configs.channelSourceList = body.uri ? [{ name: body.name || '我的NAS', uri: body.uri, epgUriList: body.epg ? [body.epg] : [] }] : [];
      config.configs.videoPlayerUserAgent = body.ua || 'okHttp/Mod-1.4.0.0';
      config.syncAt = Date.now();
      await globalThis.CONFIG_KV.put(YYKM_KEY, JSON.stringify(config));
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ===== 上传文件访问 =====
    if (path !== '/all_configs.json' && path !== '/') {
      try {
        const fileName = path.substring(1);
        if (!fileName) return new Response(JSON.stringify({ error: '无效的文件路径' }), { status: 404 });
        const raw = await globalThis.CONFIG_KV.get(UPLOADED_FILES_KEY);
        const existingFiles = raw ? JSON.parse(raw) : [];
        const matchFile = existingFiles.find(f => f.safeName === fileName);
        if (!matchFile) return new Response(JSON.stringify({ error: '文件不存在' }), { status: 404 });
        const fileContent = atob(matchFile.content);
        const uint8Array = new Uint8Array(fileContent.length);
        for (let i = 0; i < fileContent.length; i++) uint8Array[i] = fileContent.charCodeAt(i);
        const headers = new Headers();
        if (fileName.endsWith('.m3u')) headers.set('Content-Type', 'application/x-mpegURL');
        else if (fileName.endsWith('.xml')) headers.set('Content-Type', 'text/xml');
        else if (fileName.endsWith('.json')) headers.set('Content-Type', 'application/json');
        else if (fileName.endsWith('.txt')) headers.set('Content-Type', 'text/plain');
        else headers.set('Content-Type', 'application/octet-stream');
        return new Response(uint8Array, { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    return new Response('页面不存在', { status: 404 });
  });

  return handlerWithAuth(request, url);
};

export default {
  async fetch(request, env) {
    if (env.CONFIG_KV) globalThis.CONFIG_KV = env.CONFIG_KV;
    return handleRequest(request);
  }
};
