// Скрипт webview чата. Работает в песочнице браузера, с расширением общается через postMessage.
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const tokenBanner = document.getElementById('token-banner');

  // Блок ответа, который сейчас стримится
  let currentAnswer = null;
  let currentStatus = null;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  document.getElementById('set-token').addEventListener('click', () => vscode.postMessage({ type: 'setToken' }));

  // Кнопки у блоков кода — через делегирование, блоки создаются динамически
  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const code = btn.closest('.code-block').querySelector('code').textContent;
    if (btn.dataset.action === 'copy') {
      navigator.clipboard.writeText(code);
      flash(btn, 'Скопировано');
    } else if (btn.dataset.action === 'insert') {
      vscode.postMessage({ type: 'insertCode', code });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'restore':
        messagesEl.innerHTML = '';
        currentAnswer = null;
        currentStatus = null;
        setBusy(false);
        for (const entry of msg.history) {
          if (entry.role === 'user') addUser(entry.text);
          else if (entry.role === 'assistant') addMessage('assistant').innerHTML = renderMarkdown(entry.text);
          else addError(entry.text);
        }
        break;
      case 'clear':
        messagesEl.innerHTML = '';
        setBusy(false);
        break;
      case 'tokenState':
        tokenBanner.classList.toggle('hidden', msg.hasToken);
        break;
      case 'userMessage':
        addUser(msg.text);
        break;
      case 'assistantStart':
        setBusy(true);
        currentAnswer = addMessage('assistant');
        currentStatus = document.createElement('div');
        currentStatus.className = 'status';
        currentStatus.textContent = 'Напарник думает…';
        currentAnswer.appendChild(currentStatus);
        break;
      case 'toolCalls':
        if (currentStatus) currentStatus.textContent = 'Ищу: ' + msg.names.map(humanToolName).join(', ') + '…';
        break;
      case 'assistantText':
        if (currentAnswer && msg.text) {
          currentAnswer.innerHTML = renderMarkdown(msg.text);
          scrollToBottom();
        }
        break;
      case 'assistantDone':
        if (currentAnswer) currentAnswer.innerHTML = renderMarkdown(msg.text);
        finishAnswer();
        break;
      case 'error':
        if (currentAnswer && !currentAnswer.querySelector(':not(.status)')) currentAnswer.remove();
        addError(msg.message);
        finishAnswer();
        break;
    }
  });

  function finishAnswer() {
    currentAnswer = null;
    currentStatus = null;
    setBusy(false);
    scrollToBottom();
  }

  function setBusy(busy) {
    sendBtn.disabled = busy;
    stopBtn.classList.toggle('hidden', !busy);
  }

  function addMessage(role) {
    const el = document.createElement('div');
    el.className = 'message ' + role;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function addUser(text) {
    addMessage('user').innerHTML = renderMarkdown(text);
  }

  function addError(text) {
    addMessage('error').textContent = text;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }

  function humanToolName(name) {
    const map = {
      Search_ITS: 'ИТС',
      Fetch_ITS: 'документ ИТС',
      Search_Documentation: 'документация платформы',
      Diff_Documentation_Versions: 'изменения между версиями',
      validate: 'проверка синтаксиса',
    };
    const short = String(name).split('__').pop();
    return map[short] || short;
  }

  // --- Минимальный Markdown: блоки кода, заголовки, списки, **жирный**, `код`, ссылки ---

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function renderInline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  }

  function renderCodeBlock(lang, code) {
    return (
      '<div class="code-block">' +
      '<div class="code-toolbar"><span>' + escapeHtml(lang || 'код') + '</span>' +
      '<button data-action="copy">Копировать</button>' +
      '<button data-action="insert">Вставить</button></div>' +
      '<pre><code>' + escapeHtml(code) + '</code></pre></div>'
    );
  }

  function renderMarkdown(text) {
    const lines = text.split('\n');
    const out = [];
    let listTag = null;
    let listKey = null;
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length) out.push('<p>' + paragraph.map(renderInline).join('<br>') + '</p>');
      paragraph = [];
    };
    const closeList = () => {
      if (listTag) out.push('</' + listTag + '>');
      listTag = null;
      listKey = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*```(\S*)/);
      if (fence) {
        flushParagraph();
        closeList();
        const code = [];
        i++;
        // Незакрытый блок (ответ ещё стримится) — берём до конца текста
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        out.push(renderCodeBlock(fence[1], code.join('\n')));
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)/);
      const bullet = line.match(/^(\s*)[-*]\s+(.*)/);
      const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)/);

      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length + 2; // # → h3, чтобы не было огромных заголовков
        out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      } else if (bullet || numbered) {
        flushParagraph();
        const tag = bullet ? 'ul' : 'ol';
        // Пункт с отступом — вложенный список
        const nested = (bullet || numbered)[1].length >= 2;
        const key = tag + (nested ? '-nested' : '');
        if (listKey !== key) {
          closeList();
          // start — номер из текста: список, прерванный вложенными пунктами, не начинается снова с 1
          const start = numbered ? ' start="' + numbered[2] + '"' : '';
          out.push('<' + tag + (nested ? ' class="nested"' : '') + start + '>');
          listTag = tag;
          listKey = key;
        }
        out.push('<li>' + renderInline(bullet ? bullet[2] : numbered[3]) + '</li>');
      } else if (!line.trim()) {
        flushParagraph();
        closeList();
      } else {
        closeList();
        paragraph.push(line);
      }
    }
    flushParagraph();
    closeList();
    return out.join('');
  }

  vscode.postMessage({ type: 'ready' });
})();
