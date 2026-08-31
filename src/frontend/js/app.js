// Clash Config Manager - 前端脚本

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function showResult(className, html) {
    const resultDiv = document.getElementById('result');
    resultDiv.style.display = 'block';
    resultDiv.className = 'status ' + className;
    resultDiv.innerHTML = html;
}

function getToken() {
    return localStorage.getItem('update_token') || '';
}

function saveToken() {
    const input = document.getElementById('token-input');
    if (input) {
        localStorage.setItem('update_token', input.value.trim());
    }
}

/**
 * 更新配置
 */
function updateConfig() {
    const btn = document.getElementById('update-btn');
    // 防抖：更新过程中禁用按钮，避免并发触发
    if (btn.disabled) return;
    btn.disabled = true;
    showResult('info', '<p> 正在更新配置...</p>');

    const token = getToken();
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;

    fetch('/update-config', { method: 'POST', headers })
        .then(response => response.json().then(data => ({ ok: response.ok, status: response.status, data })))
        .then(({ ok, status, data }) => {
            if (ok && data.status === 'success') {
                showResult(
                    'success',
                    '<h3> 更新成功</h3><p>时间: ' + escapeHtml(data.timestamp) + '</p>'
                );
                checkStatus();
            } else if (status === 401) {
                showResult(
                    'error',
                    '<h3> 需要更新令牌</h3><p>请在“操作”区域输入更新令牌后重试。</p>'
                );
            } else {
                showResult(
                    'error',
                    '<h3> 更新失败</h3><p>' +
                    escapeHtml(data.message || data.error || '未知错误') +
                    '</p>'
                );
            }
        })
        .catch(error => {
            showResult('error', '<h3> 更新失败</h3><p>' + escapeHtml(error) + '</p>');
        })
        .finally(() => {
            btn.disabled = false;
        });
}

/**
 * 检查服务状态
 */
function checkStatus() {
    showResult('info', '<p> 正在检查状态...</p>');

    fetch('/status')
        .then(response => response.json())
        .then(data => {
            showResult(
                'info',
                '<h3> 状态信息</h3><pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>'
            );
        })
        .catch(error => {
            showResult('error', '<h3> 检查失败</h3><p>' + escapeHtml(error) + '</p>');
        });
}

// 令牌输入框内容变化时保存
document.addEventListener('DOMContentLoaded', function () {
    const input = document.getElementById('token-input');
    if (input) {
        input.value = getToken();
        input.addEventListener('change', saveToken);
    }
});
