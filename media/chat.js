// Скрипт webview чата. Работает в песочнице браузера, с расширением общается через postMessage.
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const tokenBanner = document.getElementById('token-banner');
  const projectToggle = document.getElementById('project-toggle');
  const editorChip = document.getElementById('editor-chip');

  // Блок ответа, который сейчас стримится
  let currentAnswer = null;
  let currentStatus = null;
  // Анимация статуса «думает»: смена эмодзи, бегущие точки и секундомер — видно, что не завис
  const THINK_FRAMES = ['🤔', '💭', '🧠', '💡'];
  const SEARCH_FRAMES = ['🔍', '📚', '📖', '🔎'];
  const WAIT_FRAMES = ['✋', '👀'];
  const WRITE_FRAMES = ['✍️', '📝'];
  let statusTimer = null;
  let statusStarted = 0;

  // Слэш-команды: список приходит из расширения
  const slashMenu = document.getElementById('slash-menu');
  let commands = [];
  let menuItems = [];
  let menuIndex = 0;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    // Пока идёт ответ, вопросы не отправляем, а слэш-команды (/stop, /exit, /help…) — можно
    if (!text || (sendBtn.disabled && !text.startsWith('/'))) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  });

  input.addEventListener('keydown', (e) => {
    if (!slashMenu.classList.contains('hidden')) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        menuIndex = (menuIndex + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
        renderMenu();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
        e.preventDefault();
        chooseCommand(menuItems[menuIndex], e.key === 'Enter');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Меню показывается, пока введено только «/команда» без пробела
  input.addEventListener('input', updateMenu);
  input.addEventListener('blur', () => setTimeout(hideMenu, 150));
  slashMenu.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-index]');
    if (!item) return;
    e.preventDefault();
    chooseCommand(menuItems[Number(item.dataset.index)], true);
  });

  function updateMenu() {
    const m = input.value.match(/^\/([\w-]*)$/);
    if (!m || commands.length === 0) return hideMenu();
    const query = m[1].toLowerCase();
    menuItems = commands.filter((c) => c.name.startsWith(query));
    if (menuItems.length === 0) return hideMenu();
    menuIndex = Math.min(menuIndex, menuItems.length - 1);
    renderMenu();
    slashMenu.classList.remove('hidden');
  }

  function renderMenu() {
    slashMenu.innerHTML = '';
    menuItems.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'slash-item' + (i === menuIndex ? ' active' : '');
      row.dataset.index = i;
      const name = document.createElement('span');
      name.className = 'slash-name';
      name.textContent = '/' + c.name;
      const desc = document.createElement('span');
      desc.className = 'slash-desc';
      desc.textContent = c.description;
      row.append(name, desc);
      slashMenu.appendChild(row);
    });
    slashMenu.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function hideMenu() {
    slashMenu.classList.add('hidden');
    menuIndex = 0;
  }

  /** Выбор команды: Enter — сразу выполнить, Tab — только дописать в поле */
  function chooseCommand(command, run) {
    if (!command) return;
    hideMenu();
    input.value = '/' + command.name + (command.args ? ' ' : '');
    if (run && !command.args) form.requestSubmit();
    else input.focus();
  }

  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  projectToggle.addEventListener('click', () => vscode.postMessage({ type: 'toggleProject' }));
  editorChip.addEventListener('click', () => vscode.postMessage({ type: 'toggleEditorContext' }));
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
        stopStatus();
        currentAnswer = null;
        currentStatus = null;
        setBusy(false);
        for (const entry of msg.history) {
          if (entry.role === 'user') addUser(entry.text, entry.context);
          else if (entry.role === 'assistant') addMessage('assistant').innerHTML = renderMarkdown(entry.text);
          else if (entry.role === 'step') addStep(entry.text);
          else addError(entry.text);
        }
        break;
      case 'clear':
        stopStatus();
        messagesEl.innerHTML = '';
        setBusy(false);
        break;
      case 'editorContext':
        // Чип: какой файл (и выделение) уйдёт со следующим сообщением; клик — выключить/включить
        editorChip.classList.toggle('hidden', !msg.label);
        editorChip.classList.toggle('off', !msg.enabled);
        editorChip.textContent = '📄 ' + (msg.label || '');
        editorChip.title = msg.enabled
          ? 'Файл ' + msg.path + ' будет приложен к сообщению. Нажмите, чтобы не прикладывать'
          : 'Файл не прикладывается. Нажмите, чтобы приложить';
        break;
      case 'commands':
        commands = msg.list || [];
        break;
      case 'info':
        addInfo(msg.text);
        break;
      case 'tokenState':
        tokenBanner.classList.toggle('hidden', msg.hasToken);
        break;
      case 'projectAccess':
        projectToggle.classList.toggle('on', msg.on);
        projectToggle.title = !msg.available
          ? 'Откройте папку проекта, чтобы дать Напарнику доступ к файлам'
          : msg.on
            ? 'Напарник видит файлы проекта. Нажмите, чтобы выключить'
            : 'Разрешить Напарнику смотреть и читать файлы открытого проекта';
        break;
      case 'editPending': {
        if (document.querySelector('.edit-card[data-id="' + msg.id + '"]')) break;
        const card = document.createElement('div');
        card.className = 'edit-card';
        card.dataset.id = msg.id;
        const title = document.createElement('div');
        title.className = 'edit-title';
        title.textContent = (msg.isNew ? '🆕 Создать файл ' : '✏️ Изменить файл ') + msg.label + '?';
        const hint = document.createElement('div');
        hint.className = 'edit-hint';
        hint.textContent = 'Изменения открыты во вкладке diff. Файл изменится только после «Применить».';
        const buttons = document.createElement('div');
        buttons.className = 'edit-buttons';
        buttons.innerHTML = '<button data-accept="1">Применить</button><button class="secondary" data-accept="0">Отклонить</button>';
        buttons.addEventListener('click', (e) => {
          const btn = e.target.closest('button');
          if (!btn) return;
          vscode.postMessage({ type: 'resolveEdit', id: Number(msg.id), accepted: btn.dataset.accept === '1' });
        });
        card.append(title, hint, buttons);
        if (currentAnswer) messagesEl.insertBefore(card, currentAnswer);
        else messagesEl.appendChild(card);
        if (currentStatus) setStatus('Жду вашего решения по правке', WAIT_FRAMES);
        scrollToBottom();
        break;
      }
      case 'editResolved': {
        const card = document.querySelector('.edit-card[data-id="' + msg.id + '"]');
        if (card) {
          card.classList.add('resolved');
          card.querySelector('.edit-hint').remove();
          card.querySelector('.edit-buttons').textContent = msg.accepted ? '✅ Применено' : '❌ Отклонено';
        }
        if (currentStatus) setStatus('Напарник думает', THINK_FRAMES);
        break;
      }
      case 'step':
        // Шаг вставляется перед блоком ответа, который сейчас печатается
        addStep(msg.text, currentAnswer);
        if (currentStatus) setStatus('Напарник думает', THINK_FRAMES);
        break;
      case 'userMessage':
        addUser(msg.text, msg.context);
        break;
      case 'assistantStart':
        setBusy(true);
        currentAnswer = addMessage('assistant');
        currentStatus = createStatus();
        currentAnswer.appendChild(currentStatus);
        setStatus('Напарник думает', THINK_FRAMES);
        break;
      case 'toolCalls':
        if (currentStatus) setStatus('Ищу: ' + msg.names.map(humanToolName).join(', '), SEARCH_FRAMES);
        break;
      case 'assistantText':
        if (!currentAnswer) break;
        currentAnswer.innerHTML = msg.text ? renderMarkdown(msg.text) : '';
        if (msg.writing && currentStatus) {
          // Модель пишет файл: его текст скрыт, под уже напечатанным текстом показываем прогресс
          const w = msg.writing;
          setStatus((w.isNew ? 'Пишет ' : 'Готовит правку ') + w.path + ' · ' + w.chars.toLocaleString('ru-RU') + ' симв.', WRITE_FRAMES);
          currentAnswer.appendChild(currentStatus);
        } else if (!msg.text && currentStatus) {
          // Новый шаг агентного цикла: возвращаем статус вместо текста
          currentAnswer.appendChild(currentStatus);
        }
        scrollToBottom();
        break;
      case 'assistantDone':
        if (currentAnswer) currentAnswer.innerHTML = renderMarkdown(msg.text);
        finishAnswer();
        break;
      case 'error':
        // Статус убираем; уже напечатанный текст ответа оставляем, пустой блок — удаляем
        currentStatus?.remove();
        if (currentAnswer && !currentAnswer.textContent.trim()) currentAnswer.remove();
        addError(msg.message);
        finishAnswer();
        break;
    }
  });

  function finishAnswer() {
    stopStatus();
    currentAnswer = null;
    currentStatus = null;
    setBusy(false);
    scrollToBottom();
  }

  function createStatus() {
    const el = document.createElement('div');
    el.className = 'status';
    el.innerHTML = '<span class="status-emoji"></span><span class="status-text"></span><span class="status-dots"></span><span class="status-time"></span>';
    return el;
  }

  /** Текст статуса и набор эмодзи. Секундомер считает текущий этап: при смене этапа начинается заново */
  function setStatus(text, frames) {
    if (!currentStatus) return;
    currentStatus.querySelector('.status-text').textContent = text;
    if (currentStatus.frames !== frames) statusStarted = Date.now();
    currentStatus.frames = frames;
    if (statusTimer) return;

    let tick = 0;
    const render = () => {
      // Статус мог быть снят со страницы, когда пошёл текст ответа — тогда просто ждём
      const el = currentStatus;
      if (!el) return;
      const frames = el.frames || THINK_FRAMES;
      el.querySelector('.status-emoji').textContent = frames[Math.floor(tick / 2) % frames.length];
      el.querySelector('.status-dots').textContent = '.'.repeat((tick % 3) + 1);
      const seconds = Math.floor((Date.now() - statusStarted) / 1000);
      el.querySelector('.status-time').textContent = seconds >= 3 ? seconds + ' с' : '';
      tick++;
    };
    render();
    statusTimer = setInterval(render, 400);
  }

  function stopStatus() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
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

  function addUser(text, context) {
    const el = addMessage('user');
    el.innerHTML = renderMarkdown(text);
    if (context) {
      const ctx = document.createElement('div');
      ctx.className = 'user-context';
      ctx.textContent = '📄 ' + context;
      el.appendChild(ctx);
    }
  }

  function addStep(text, before) {
    const el = document.createElement('div');
    el.className = 'step';
    el.textContent = text;
    if (before) messagesEl.insertBefore(el, before);
    else messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addInfo(markdown) {
    const el = addMessage('info');
    el.innerHTML = renderMarkdown(markdown);
    scrollToBottom();
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
