// Initialize icons
lucide.createIcons();

// State
let docId = null;
let history = [];
let isProcessing = false;

// DOM Elements
const fileInput = document.getElementById('fileInput');
const uploadBox = document.getElementById('uploadBox');
const docInfo = document.getElementById('docInfo');
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
  docInfo.style.display = 'block';
  docInfo.textContent = `Processing ${file.name}...`;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Upload failed');

    docId = data.doc_id;
    headerTitle.textContent = data.filename;
    
    let infoHtml = `<strong>Loaded:</strong> ${data.filename}<br/>`;
    infoHtml += `<strong>Chunks:</strong> ${data.num_chunks}`;
    if (data.num_pages) infoHtml += `<br/><strong>Pages:</strong> ${data.num_pages}`;
    if (data.status === 'already_ingested') infoHtml += `<br/><span style="color:#10b981">Already indexed</span>`;
    
    docInfo.innerHTML = infoHtml;
    setStatus('ready', 'Ready for questions');
    
    questionInput.disabled = false;
    sendBtn.disabled = false;
    history = [];
    
    // Clear chat except welcome
    messagesEl.innerHTML = `
      <div class="msg-wrapper bot">
        <div class="msg">
          <p>Document <strong>${data.filename}</strong> has been loaded successfully. What would you like to know about it?</p>
        </div>
      </div>
    `;
    
    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
      sidebar.classList.remove('open');
    }
    
    questionInput.focus();

  } catch (err) {
    setStatus('error', 'Upload failed');
    docInfo.textContent = err.message;
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

sendBtn.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendQuestion();
  }
});
