/**
 * 跨环境剪贴板复制（带降级）。
 *
 * navigator.clipboard 是 Secure Context API：页面通过 http://<内网IP> 访问时
 * 该对象为 undefined（Chrome 会直接抛 TypeError），必须降级到 execCommand。
 * execCommand 虽被标记废弃，但在所有现行浏览器的非安全上下文中是唯一可用路径。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 首选：现代 API（HTTPS / localhost 等安全上下文）
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到降级路径
  }

  // 降级：隐藏 textarea + execCommand（非安全上下文可用）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);

    // iOS Safari 需要选中内容才能复制
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const ok = document.execCommand('copy');
    sel?.removeAllRanges();
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
