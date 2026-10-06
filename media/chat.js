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
  // Меню общее: слэш-команды или файлы для @-упоминания (список приходит из расширения)
  let menuMode = 'slash';
  let mentionQuery = null;
  let mentionTimer = null;

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
        chooseItem(menuItems[menuIndex], e.key === 'Enter');
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
      // Поле пустое, а правка ждёт решения — Enter применяет её
      const pending = pendingEditId();
      if (!input.value.trim() && pending !== undefined) {
        resolveEdit(pending, true);
        return;
      }
      form.requestSubmit();
    }
    if (e.key === 'Escape' && !input.value.trim() && pendingEditId() !== undefined) {
      e.preventDefault();
      resolveEdit(pendingEditId(), false);
    }
  });

  /** Последняя правка, ждущая решения */
  function pendingEditId() {
    const cards = messagesEl.querySelectorAll('.edit-card:not(.resolved)');
    return cards.length > 0 ? Number(cards[cards.length - 1].dataset.id) : undefined;
  }

  function resolveEdit(id, accepted) {
    vscode.postMessage({ type: 'resolveEdit', id: Number(id), accepted });
    // После решения возвращаем фокус в поле ввода
    input.focus();
  }

  // Меню показывается, пока введено только «/команда» без пробела
  input.addEventListener('input', updateMenu);
  input.addEventListener('blur', () => setTimeout(hideMenu, 150));
  slashMenu.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-index]');
    if (!item) return;
    e.preventDefault();
    chooseItem(menuItems[Number(item.dataset.index)], true);
  });
  // Курсор переместили стрелками или мышью — подсказка по @ могла стать неактуальной
  input.addEventListener('click', updateMenu);

  function updateMenu() {
    const m = input.value.match(/^\/([\w-]*)$/);
    if (m && commands.length > 0) {
      menuMode = 'slash';
      mentionQuery = null;
      const query = m[1].toLowerCase();
      menuItems = commands.filter((c) => c.name.startsWith(query));
      if (menuItems.length === 0) return hideMenu();
      menuIndex = Math.min(menuIndex, menuItems.length - 1);
      renderMenu();
      slashMenu.classList.remove('hidden');
      return;
    }
    // «@часть-пути» прямо перед курсором — просим у расширения подходящие файлы
    const mention = input.value.slice(0, input.selectionStart).match(/(?:^|\s)@([^\s"]*)$/);
    if (!mention) {
      mentionQuery = null;
      return hideMenu();
    }
    menuMode = 'mention';
    mentionQuery = mention[1];
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => vscode.postMessage({ type: 'mentionQuery', query: mentionQuery }), 80);
  }

  function showMentionResults(query, paths) {
    // Ответ на устаревший запрос (пользователь печатает дальше) не показываем
    if (menuMode !== 'mention' || query !== mentionQuery) return;
    menuItems = paths.map((p) => ({ path: p }));
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
      const desc = document.createElement('span');
      desc.className = 'slash-desc';
      if (c.path !== undefined) {
        const slash = c.path.lastIndexOf('/');
        name.textContent = c.path.slice(slash + 1);
        desc.textContent = slash > 0 ? c.path.slice(0, slash) : '';
        row.title = c.path;
      } else {
        name.textContent = '/' + c.name;
        desc.textContent = c.description;
      }
      row.append(name, desc);
      slashMenu.appendChild(row);
    });
    slashMenu.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function hideMenu() {
    slashMenu.classList.add('hidden');
    menuIndex = 0;
  }

  function chooseItem(item, run) {
    if (menuMode === 'mention') insertMention(item);
    else chooseCommand(item, run);
  }

  /** Заменить «@часть» перед курсором полным путём файла; путь с пробелами — в кавычках */
  function insertMention(item) {
    if (!item) return;
    hideMenu();
    const caret = input.selectionStart;
    const token = /\s/.test(item.path) ? '@"' + item.path + '" ' : '@' + item.path + ' ';
    const before = input.value.slice(0, caret).replace(/@[^\s"]*$/, token);
    input.value = before + input.value.slice(caret);
    input.setSelectionRange(before.length, before.length);
    mentionQuery = null;
    input.focus();
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
        closeStepGroups();
        scrollToBottom(true);
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
      case 'mentionResults':
        showMentionResults(msg.query, msg.items || []);
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
        const hint = document.createElement('div');
        hint.className = 'edit-hint';
        const buttons = document.createElement('div');
        buttons.className = 'edit-buttons';
        const op = msg.operation;
        card.dataset.operation = op ? '1' : '';
        if (op) {
          // Перенос, копирование, удаление: diff нет — всё видно в карточке
          const what = op.isDir ? 'папку ' : '';
          title.textContent =
            op.kind === 'move' ? '🚚 Перенести ' + what + op.from + ' → ' + op.to + '?'
            : op.kind === 'copy' ? '📑 Скопировать ' + what + op.from + ' → ' + op.to + '?'
            : '🗑️ Удалить ' + what + op.from + '? (в корзину)';
          hint.textContent = 'Enter — выполнить, Esc — отклонить.';
          if (op.isDir) {
            const list = document.createElement('div');
            list.className = 'edit-files';
            const more = op.totalFiles - op.files.length;
            list.textContent = op.totalFiles === 0
              ? 'Папка пуста.'
              : 'Файлов: ' + op.totalFiles + '\n' + op.files.join('\n') + (more > 0 ? '\n… ещё ' + more : '');
            card.append(list);
          }
          buttons.innerHTML = '<button data-accept="1">Выполнить</button><button class="secondary" data-accept="0">Отклонить</button>';
        } else {
          title.textContent = (msg.isNew ? '🆕 Создать файл ' : '✏️ Изменить файл ') + msg.label + '?';
          hint.textContent = 'Изменения открыты во вкладке diff. Enter — применить, Esc — отклонить.';
          buttons.innerHTML = '<button data-accept="1">Применить</button><button class="secondary" data-accept="0">Отклонить</button>';
        }
        buttons.addEventListener('click', (e) => {
          const btn = e.target.closest('button');
          if (!btn) return;
          resolveEdit(msg.id, btn.dataset.accept === '1');
        });
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            resolveEdit(msg.id, false);
          }
        });
        card.prepend(title, hint);
        card.append(buttons);
        if (currentAnswer) messagesEl.insertBefore(card, currentAnswer);
        else messagesEl.appendChild(card);
        // Фокус на «Применить» — Enter сразу применяет. Если пользователь что-то печатает, не мешаем
        if (!input.value.trim()) buttons.querySelector('button').focus();
        if (currentStatus) setStatus(op ? 'Жду вашего решения' : 'Жду вашего решения по правке', WAIT_FRAMES);
        scrollToBottom();
        break;
      }
      case 'editResolved': {
        const card = document.querySelector('.edit-card[data-id="' + msg.id + '"]');
        if (card) {
          card.classList.add('resolved');
          card.querySelector('.edit-hint').remove();
          card.querySelector('.edit-buttons').textContent = msg.accepted ? (card.dataset.operation ? '✅ Выполнено' : '✅ Применено') : '❌ Отклонено';
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
        scrollToBottom(true);
        break;
      case 'assistantStart':
        setBusy(true);
        currentAnswer = addMessage('assistant');
        currentStatus = createStatus();
        currentAnswer.appendChild(currentStatus);
        setStatus('Напарник думает', THINK_FRAMES);
        break;
      case 'toolCalls':
        if (!currentStatus) break;
        // План задач модели — не поиск
        if (msg.names.every((n) => n === 'TodoWrite')) setStatus('Составляю план', THINK_FRAMES);
        else if (msg.names.every((n) => /__validate$/.test(n) || n === 'TodoWrite')) setStatus('Проверяю синтаксис', SEARCH_FRAMES);
        else setStatus('Ищу: ' + msg.names.filter((n) => n !== 'TodoWrite').map(humanToolName).join(', '), SEARCH_FRAMES);
        break;
      case 'assistantText':
        if (!currentAnswer) break;
        currentAnswer.innerHTML = msg.text ? renderMarkdown(msg.text) : '';
        if (msg.writing && currentStatus) {
          // Модель пишет файл: его текст скрыт, под уже напечатанным текстом показываем прогресс
          const w = msg.writing;
          setStatus((w.isNew ? 'Пишет ' : 'Готовит правку ') + w.path + ' · ' + w.chars.toLocaleString('ru-RU') + ' ' + plural(w.chars, 'символ', 'символа', 'символов'), WRITE_FRAMES);
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
    closeStepGroups();
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
      // Пока пишется файл, растёт счётчик символов — бегущие точки после него лишние
      el.querySelector('.status-dots').textContent = frames === WRITE_FRAMES ? '' : '.'.repeat((tick % 3) + 1);
      const seconds = Math.floor((Date.now() - statusStarted) / 1000);
      el.querySelector('.status-time').textContent = seconds >= 3 ? seconds + ' с' : '';
      tick++;
    };
    render();
    statusTimer = setInterval(render, 400);
  }

  /** 1 символ, 2 символа, 5 символов */
  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
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

  /**
   * Шаги работы с проектом («Читаю…», «Смотрю…») собираются в свёрнутую группу:
   * пока идёт ответ — видно последний шаг и счётчик, после ответа — сводка. Клик разворачивает список.
   */
  function addStep(text, before) {
    // Продолжаем открытую группу, если она стоит прямо перед местом вставки
    const prev = before ? before.previousElementSibling : messagesEl.lastElementChild;
    let group = prev && prev.classList.contains('steps') && !prev.classList.contains('closed') ? prev : null;
    if (!group) {
      group = createStepGroup();
      if (before) messagesEl.insertBefore(group, before);
      else messagesEl.appendChild(group);
    }
    const step = document.createElement('div');
    step.className = 'step';
    step.textContent = text;
    group.querySelector('.steps-list').appendChild(step);
    const count = group.querySelectorAll('.step').length;
    group.querySelector('.steps-summary').textContent = text + (count > 1 ? ' · ещё ' + (count - 1) : '');
    scrollToBottom();
  }

  function createStepGroup() {
    const group = document.createElement('div');
    group.className = 'steps';
    const header = document.createElement('div');
    header.className = 'steps-header';
    header.innerHTML = '<span class="steps-arrow">▸</span><span class="steps-summary"></span>';
    const list = document.createElement('div');
    list.className = 'steps-list';
    header.addEventListener('click', () => group.classList.toggle('expanded'));
    group.append(header, list);
    return group;
  }

  /** Ответ готов: открытые группы шагов превращаются в сводку «Просмотрено: 12 папок, 3 файла» */
  function closeStepGroups() {
    for (const group of messagesEl.querySelectorAll('.steps:not(.closed)')) {
      group.classList.add('closed');
      const steps = [...group.querySelectorAll('.step')].map((s) => s.textContent);
      group.querySelector('.steps-summary').textContent = summarizeSteps(steps);
    }
  }

  function summarizeSteps(steps) {
    const count = (prefix) => steps.filter((s) => s.startsWith(prefix)).length;
    const parts = [
      [count('📂'), 'папку', 'папки', 'папок'],
      [count('📄'), 'файл', 'файла', 'файлов'],
      [count('🔍'), 'поиск', 'поиска', 'поисков'],
    ]
      .filter(([n]) => n > 0)
      .map(([n, one, few, many]) => n + ' ' + plural(n, one, few, many));
    const edits = count('✏️') + count('🆕') + count('🚚') + count('📑') + count('🗑️');
    const viewed = parts.length > 0 ? 'Просмотрено: ' + parts.join(', ') : '';
    const proposed = edits > 0 ? 'предложено правок: ' + edits : '';
    return [viewed, proposed].filter(Boolean).join('; ').replace(/^п/, 'П') || steps.length + ' ' + plural(steps.length, 'шаг', 'шага', 'шагов');
  }

  function addInfo(markdown) {
    const el = addMessage('info');
    el.innerHTML = renderMarkdown(markdown);
    scrollToBottom();
  }

  function addError(text) {
    addMessage('error').textContent = text;
  }

  // Прокрутка за ответом — только пока пользователь внизу: прокрутил выше, чтобы читать, — не дёргаем
  let stickToBottom = true;
  messagesEl.addEventListener('scroll', () => {
    stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  });

  function scrollToBottom(force) {
    if (force) stickToBottom = true;
    if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
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
      TodoWrite: 'план задач',
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
