/**
 * 跨环境剪贴板复制（三级降级）。
 *
 * navigator.clipboard 是 Secure Context API：页面通过 http://<内网IP> 访问时
 * 该对象为 undefined（Chrome 会直接抛 TypeError）。
 *
 * 注意：单纯的「隐藏 textarea + execCommand('copy')」在某些环境会返回 true
 * 但实际写入为空（选区丢失/焦点问题），因此主降级路径采用
 * 「copy 事件监听 + clipboardData.setData」——execCommand 触发 copy 事件时
 * 由事件处理器直接写入数据，不依赖 DOM 选区，是非安全上下文下最可靠的方式。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 1) 现代 API（HTTPS / localhost 等安全上下文）
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限拒绝或 API 异常 → 降级
  }

  // 2) copy 事件 + clipboardData（不依赖选区，非安全上下文首选）
  try {
    if (copyViaCopyEvent(text)) return true;
  } catch {
    // 继续 3)
  }

  // 3) 兜底：隐藏 textarea + focus/select + execCommand
  try {
    return copyViaTextarea(text);
  } catch {
    return false;
  }
}

/** 方式 2：注册一次性 copy 事件监听器，execCommand 触发事件时写入 clipboardData */
function copyViaCopyEvent(text: string): boolean {
  let handled = false;
  const listener = (e: ClipboardEvent) => {
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
      handled = true;
    }
  };
  document.addEventListener('copy', listener);
  let fired = false;
  try {
    fired = document.execCommand('copy', false, undefined);
  } finally {
    document.removeEventListener('copy', listener);
  }
  return fired && handled;
}

/** 方式 3：隐藏 textarea，focus + 全选 + execCommand（方式 2 失败时的最后手段） */
function copyViaTextarea(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  try {
    // iOS Safari 要求 textarea 可编辑且有焦点；桌面端 focus+select 即可
    const isIOS = /ipad|iphone|iPod/i.test(navigator.userAgent);
    if (isIOS) {
      const oldContentEditable = ta.contentEditable;
      const oldReadOnly = ta.readOnly;
      ta.contentEditable = 'true';
      ta.readOnly = false;
      const range = document.createRange();
      range.selectNodeContents(ta);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.contentEditable = oldContentEditable;
      ta.readOnly = oldReadOnly;
      return ok;
    }
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } finally {
    window.getSelection()?.removeAllRanges();
    document.body.removeChild(ta);
  }
}
