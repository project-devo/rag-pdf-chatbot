// Initialize icons
lucide.createIcons();

// State
let docId = null;
let history = [];
let isProcessing = false;

// DOM Elements
const fileInput = document.getElementById('fileInput');
const uploadBox = document.getElementById('uploadBox');
const statusText = document.getElementById('statusText');
const statusIndicator = document.getElementById('statusIndicator');
const questionInput = document.getElementById('questionInput');
const sendBtn = document.getElementById('sendBtn');
const messagesEl = document.getElementById('messages');
const mobileToggle = document.getElementById('mobileToggle');
const sidebar = document.getElementById('sidebar');
const headerTitle = document.getElementById('headerTitle');

// Mobile sidebar toggle
mobileToggle.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

// --- Collapse ---
const collapseToggle = document.getElementById('collapseToggle');
if (localStorage.getItem('sidebarCollapsed') === 'true') {
  sidebar.classList.add('collapsed');
}
collapseToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
});

// --- Resize ---
const resizeHandle = document.getElementById('resizeHandle');
const savedWidth = localStorage.getItem('sidebarWidth');
if (savedWidth) {
  sidebar.style.setProperty('--sidebar-width', savedWidth + 'px');
  sidebar.style.width = savedWidth + 'px';
}
let resizing = false;
resizeHandle.addEventListener('mousedown', () => {
  resizing = true;
  document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const width = Math.min(480, Math.max(200, e.clientX));
  sidebar.style.width = width + 'px';
});
document.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = false;
  document.body.style.userSelect = '';
  localStorage.setItem('sidebarWidth', parseInt(sidebar.style.width, 10));
});

// --- Folder tree + document registry ---
let allDocs = [];
let activeDocId = null;
const folderTreeEl = document.getElementById('folderTree');
const folderSelectEl = document.getElementById('folderSelect');
const newFolderBtn = document.getElementById('newFolderBtn');
const collapsedFolders = new Set(JSON.parse(localStorage.getItem('collapsedFolders') || '[]'));

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function fetchDocuments() {
  const res = await fetch('/documents');
  allDocs = await res.json();
  renderFolderTree();
  renderFolderSelect();
  return allDocs;
}

function renderFolderSelect() {
  const folders = [...new Set(['Unfiled', ...allDocs.map(d => d.folder)])];
  folderSelectEl.innerHTML = folders.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
}

newFolderBtn.addEventListener('click', () => {
  const name = prompt('New folder name:');
  if (!name) return;
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  opt.selected = true;
  folderSelectEl.appendChild(opt);
});

function renderFolderTree() {
  const byFolder = {};
  for (const doc of allDocs) {
    (byFolder[doc.folder] ||= []).push(doc);
  }

  folderTreeEl.innerHTML = Object.keys(byFolder).sort().map(folder => {
    const isCollapsed = collapsedFolders.has(folder);
    const allFolders = Object.keys(byFolder).sort();
    const rows = byFolder[folder].map(doc => {
      const options = allFolders.map(f =>
        `<option value="${esc(f)}" ${f === doc.folder ? 'selected' : ''}>${esc(f)}</option>`
      ).join('');
      return `
      <div class="doc-row ${doc.doc_id === activeDocId ? 'active' : ''}" data-doc-id="${esc(doc.doc_id)}">
        <i data-lucide="file-text" style="width:14px;height:14px;flex-shrink:0;"></i>
        <span class="doc-name" title="${esc(doc.filename)}">${esc(doc.filename)}</span>
        <select class="doc-move" data-move-id="${esc(doc.doc_id)}" title="Move to folder">${options}</select>
        <button class="doc-delete" data-delete-id="${esc(doc.doc_id)}" title="Delete">
          <i data-lucide="trash-2" style="width:13px;height:13px;"></i>
        </button>
      </div>
    `;
    }).join('');

    return `
      <div class="folder-group ${isCollapsed ? 'collapsed' : ''}" data-folder="${esc(folder)}">
        <div class="folder-group-header">
          <i data-lucide="chevron-down" class="chevron" style="width:14px;height:14px;"></i>
          <span>${esc(folder)}</span>
          <span style="margin-left:auto;font-weight:400;">${byFolder[folder].length}</span>
        </div>
        ${rows}
      </div>
    `;
  }).join('');

  lucide.createIcons();

  folderTreeEl.querySelectorAll('.folder-group-header').forEach(header => {
    header.addEventListener('click', () => {
      const group = header.parentElement;
      const folder = group.dataset.folder;
      group.classList.toggle('collapsed');
      if (group.classList.contains('collapsed')) collapsedFolders.add(folder);
      else collapsedFolders.delete(folder);
      localStorage.setItem('collapsedFolders', JSON.stringify([...collapsedFolders]));
    });
  });

  folderTreeEl.querySelectorAll('.doc-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.doc-delete') || e.target.closest('.doc-move')) return;
      selectDocument(row.dataset.docId);
    });
  });

  folderTreeEl.querySelectorAll('.doc-move').forEach(select => {
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', async () => {
      const id = select.dataset.moveId;
      await fetch(`/documents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: select.value }),
      });
      await fetchDocuments();
    });
  });

  folderTreeEl.querySelectorAll('.doc-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.deleteId;
      const doc = allDocs.find(d => d.doc_id === id);
      if (!confirm(`Delete "${doc?.filename || id}"? This cannot be undone.`)) return;
      await fetch(`/documents/${id}`, { method: 'DELETE' });
      if (activeDocId === id) {
        activeDocId = null;
        docId = null;
        showLandingState();
      }
      await fetchDocuments();
    });
  });
}

// Drag and drop events
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  uploadBox.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
  uploadBox.addEventListener(eventName, () => uploadBox.classList.add('dragover'), false);
});

['dragleave', 'drop'].forEach(eventName => {
  uploadBox.addEventListener(eventName, () => uploadBox.classList.remove('dragover'), false);
});

uploadBox.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  const files = dt.files;
  if (files && files.length) {
    fileInput.files = files;
    handleFileUpload(files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length) {
    handleFileUpload(e.target.files[0]);
  }
});

function setStatus(state, msg) {
  statusText.textContent = msg;
  statusIndicator.className = 'status-indicator ' + state; // 'loading', 'ready', 'error', ''
}

async function handleFileUpload(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    setStatus('error', 'Please upload a valid PDF file.');
    return;
  }

  setStatus('loading', 'Ingesting PDF...');

  const formData = new FormData();
  formData.append('file', file);
  formData.append('folder', folderSelectEl.value || 'Unfiled');

  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Upload failed');

    await fetchDocuments();
    await selectDocument(data.doc_id);
  } catch (err) {
    setStatus('error', 'Upload failed');
  }
}

function createMessageElement(role, content, sources = null) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${role}`;
  
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg';
  
  if (role === 'bot') {
    // Parse markdown
    msgDiv.innerHTML = marked.parse(content);
  } else {
    msgDiv.textContent = content;
  }
  
  wrapper.appendChild(msgDiv);
  
  if (sources && sources.length) {
    const srcDiv = document.createElement('div');
    srcDiv.className = 'sources';
    
    // Info icon
    const iconSpan = document.createElement('span');
    iconSpan.innerHTML = `<i data-lucide="info"></i>`;
    srcDiv.appendChild(iconSpan);
    
    const textSpan = document.createElement('span');
    const uniquePages = [...new Set(sources.map(s => s.page))].sort((a,b)=>a-b);
    textSpan.textContent = `Sources: p. ${uniquePages.join(', ')}`;
    srcDiv.appendChild(textSpan);
    
    wrapper.appendChild(srcDiv);
  }
  
  return wrapper;
}

function showTypingIndicator() {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper bot typing-wrapper';
  wrapper.id = 'typingIndicator';
  
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg';
  
  msgDiv.innerHTML = `
    <div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
  `;
  
  wrapper.appendChild(msgDiv);
  messagesEl.appendChild(wrapper);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function scrollToBottom() {
  messagesEl.scrollTo({
    top: messagesEl.scrollHeight,
    behavior: 'smooth'
  });
}

async function sendQuestion() {
  const q = questionInput.value.trim();
  if (!q || !docId || isProcessing) return;

  isProcessing = true;
  questionInput.disabled = true;
  sendBtn.disabled = true;
  
  // Add user message
  const userMsg = createMessageElement('user', q);
  messagesEl.appendChild(userMsg);
  history.push({ role: 'user', content: q });
  
  questionInput.value = '';
  scrollToBottom();
  
  setStatus('loading', 'Generating answer...');
  showTypingIndicator();
  lucide.createIcons();

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: docId, question: q, history: history.slice(0, -1) })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Chat request failed');

    removeTypingIndicator();
    
    const botMsg = createMessageElement('bot', data.answer, data.sources);
    messagesEl.appendChild(botMsg);
    history.push({ role: 'assistant', content: data.answer });
    
    setStatus('ready', 'Ready for questions');
  } catch (err) {
    removeTypingIndicator();
    const errorMsg = createMessageElement('bot', `**Error:** ${err.message}`);
    messagesEl.appendChild(errorMsg);
    setStatus('error', 'Error generating answer');
  } finally {
    lucide.createIcons();
    scrollToBottom();
    isProcessing = false;
    questionInput.disabled = false;
    sendBtn.disabled = false;
    questionInput.focus();
  }
}

function greetingForTime() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function showLandingState() {
  headerTitle.textContent = 'RAG Assistant';
  questionInput.disabled = true;
  sendBtn.disabled = true;
  setStatus('', 'Awaiting document');

  const folders = new Set(allDocs.map(d => d.folder));
  const docCountText = allDocs.length === 0
    ? 'No documents yet — upload a PDF to get started.'
    : `${allDocs.length} document${allDocs.length === 1 ? '' : 's'} in ${folders.size} folder${folders.size === 1 ? '' : 's'} — pick one from the sidebar or upload a new one.`;

  messagesEl.innerHTML = `
    <div class="msg-wrapper bot">
      <div class="msg">
        <p>${greetingForTime()}. ${docCountText}</p>
      </div>
    </div>
  `;
}

function renderSuggestedQuestions(questions) {
  if (!questions || !questions.length) return '';
  const chips = questions.map(q => `<button class="suggested-chip" data-question="${esc(q)}">${esc(q)}</button>`).join('');
  return `<div class="suggested-chips">${chips}</div>`;
}

async function selectDocument(newDocId) {
  activeDocId = newDocId;
  docId = newDocId;
  history = [];

  const doc = allDocs.find(d => d.doc_id === newDocId);
  headerTitle.textContent = doc ? doc.filename : 'RAG Assistant';
  questionInput.disabled = false;
  sendBtn.disabled = false;
  setStatus('loading', 'Loading welcome...');
  renderFolderTree();

  messagesEl.innerHTML = `
    <div class="msg-wrapper bot"><div class="msg"><p>Loading document context...</p></div></div>
  `;

  try {
    const res = await fetch(`/documents/${newDocId}/welcome`);
    const data = await res.json();
    messagesEl.innerHTML = `
      <div class="msg-wrapper bot">
        <div class="msg"><p>${esc(data.message)}</p></div>
        ${renderSuggestedQuestions(data.suggested_questions)}
      </div>
    `;
  } catch (err) {
    messagesEl.innerHTML = `
      <div class="msg-wrapper bot"><div class="msg"><p>Document loaded. What would you like to know about it?</p></div></div>
    `;
  }

  messagesEl.querySelectorAll('.suggested-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      questionInput.value = chip.dataset.question;
      sendQuestion();
    });
  });

  setStatus('ready', 'Ready for questions');
  if (window.innerWidth <= 768) sidebar.classList.remove('open');
}

fetchDocuments().then(() => showLandingState());

sendBtn.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendQuestion();
  }
});
