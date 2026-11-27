'use strict';

const invite = document.querySelector('[data-invite]');
if (invite && /^#[A-Za-z0-9_-]{43}$/.test(location.hash)) {
  invite.value = location.hash.slice(1);
  invite.closest('label').hidden = true;
  history.replaceState(null,'',location.pathname);
}

document.addEventListener('click',async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) event.preventDefault();
  if (button.hasAttribute('data-back')) {
    if (history.length > 1) history.back();
    else location.assign('/');
  }
  if (button.hasAttribute('data-prompt')) {
    const form = button.form;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const languages = values.getAll('language');
    const message = form.querySelector('[data-prompt-status]');
    if (!languages.length) {
      message.textContent = ' Select at least one language.';
      return;
    }
    const instructions = document.querySelector('#published-instructions').textContent;
    const prompt = [
      instructions, 'Source copy: '+values.get('source'), 'Audience: '+values.get('audience'),
      'Brand tone: '+values.get('tone'), 'Required facts or terms: '+values.get('terms'),
      'Target languages: '+languages.join(', ')
    ].join('\n\n');
    try {
      await navigator.clipboard.writeText(prompt);
      message.textContent = ' Prompt copied.';
    } catch {
      message.textContent = ' Clipboard unavailable. Copy the published instructions and your inputs manually.';
    }
    return;
  }
  if (!button.dataset.copy) return;
  const text = document.getElementById(button.dataset.copy)?.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    const node = document.getElementById(button.dataset.copy);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    button.textContent = 'Selected. Copy manually';
  }
});

document.addEventListener('change',async (event) => {
  const picker = event.target;
  if (!picker.matches('[data-csv]')) return;
  picker.setCustomValidity('');
  const file = picker.files[0];
  if (!file) return;
  const target = picker.form.elements.namedItem('csv');
  if (file.size > 440000) {
    picker.setCustomValidity('The CSV file is too large.');
    picker.reportValidity();
    return;
  }
  try {
    const text = await file.text();
    if (text.length > 110000) {
      picker.setCustomValidity('The CSV file is too large.');
      picker.reportValidity();
    } else target.value = text;
  } catch {
    picker.setCustomValidity('The CSV file could not be read.');
    picker.reportValidity();
  }
});

for (const form of document.querySelectorAll('[data-audit-upload]')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = form.elements.file.files[0];
    const feedback = form.querySelector('[role="status"]');
    if (!file || file.size > 25*1024*1024) {
      feedback.textContent = 'Choose a JSON file up to 25 MB.';
      return;
    }
    const submit = form.querySelector('button');
    submit.disabled = true;
    feedback.textContent = 'Analyzing the import…';
    try {
      const result = await fetch(form.action,{
        method:'POST',headers:{'Content-Type':'application/json'},body:file
      });
      if (result.redirected || result.status===401) {
        window.location.assign('/login');
        return;
      }
      const data = await result.json();
      if (result.ok && /^\/audit\?source=(chat|logs)$/.test(data.url)) window.location.assign(data.url);
      else feedback.textContent = data.error || 'The report could not be generated.';
    } catch {
      feedback.textContent = 'The import could not be completed. Try again.';
    } finally { submit.disabled = false; }
  });
}
