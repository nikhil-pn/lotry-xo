// Lotry on XO site: copy-to-clipboard for the banner, and the live rounds rendered from data/rounds.json.
'use strict';

// ---------- Copy (EMBER2026 vote address) ----------

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers without the async clipboard (or non-secure contexts).
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
};

document.querySelectorAll('[data-copy]').forEach((button) => {
  const source = document.getElementById(button.dataset.copy);
  const hint = button.querySelector('.ember__hint');
  let timer;
  button.addEventListener('click', async () => {
    const ok = await copyText(source.textContent.trim());
    if (hint) hint.textContent = ok ? 'copied' : 'select it';
    button.classList.toggle('is-copied', ok);
    if (!ok) {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (hint) hint.textContent = 'copy';
      button.classList.remove('is-copied');
    }, 1800);
  });
});
