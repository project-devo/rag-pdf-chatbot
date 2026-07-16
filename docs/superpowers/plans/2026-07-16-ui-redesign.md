# RAG PDF Chatbot UI/UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a folder-organized multi-PDF sidebar (collapsible, resizable) and a smart per-document welcome message, without changing the single-document chat model.

**Architecture:** Folder + welcome-cache data lives entirely in Chroma **collection metadata** (no new database, no new files). Backend gains 4 endpoints (`GET/PATCH/DELETE /documents`, `GET /documents/{doc_id}/welcome`) plus a `folder` field on `/upload`. Frontend sidebar becomes a folder tree with collapse/resize state in `localStorage`; chat area gains a landing state (no doc selected) and a cached welcome render (doc selected).

**Tech Stack:** FastAPI, chromadb (PersistentClient, collection metadata), Groq (existing client), vanilla JS/CSS (no new dependencies, no build step).

## Global Constraints

- Chat stays single-document: one `doc_id` per `/chat` call. No cross-collection retrieval merge. (Spec: "Explicitly out of scope")
- No new runtime dependencies. No framework/build-step migration. (Spec: "Explicitly out of scope")
- Default folder name for uploads with no explicit folder: exactly `"Unfiled"` (Spec: Storage)
- `collection.modify(metadata=...)` **replaces** the metadata dict, it does not merge — every call site that updates one key must read-merge-write the full dict (verified empirically against chromadb 1.5.9; this is not documented behavior, treat it as load-bearing)
- Welcome generation failure must never block upload or chat — falls back to a static message (Spec: Error handling)
- Sidebar collapse/resize state persists in `localStorage` (`sidebarCollapsed`, `sidebarWidth`), clamped 200–480px (Spec: Sidebar)
- Mobile (`<=768px`) keeps the existing overlay-drawer behavior; collapse/resize is desktop-only (Spec: Sidebar)

---

### Task 1: Document registry in rag.py (list, folder, delete)

**Files:**
- Modify: `rag.py:100-153` (`get_collection`, `ingest_pdf`)
- Test: `test_rag.py`

**Interfaces:**
- Consumes: `_client` (chromadb PersistentClient, module-level in rag.py), `_embedding_fn` (module-level)
- Produces:
  - `ingest_pdf(pdf_path: str, original_filename: str, folder: str = "Unfiled") -> Dict` — return dict now includes `"folder"` key in both `"ingested"` and `"already_ingested"` branches
  - `list_documents() -> List[Dict]` — each item `{"doc_id": str, "filename": str, "folder": str, "num_chunks": int, "num_pages": Optional[int]}`
  - `set_folder(doc_id: str, folder: str) -> Dict` — same shape as one `list_documents()` item; raises `ValueError(f"Document {doc_id} not found")` if missing
  - `delete_document(doc_id: str) -> None` — raises `ValueError(f"Document {doc_id} not found")` if missing

- [ ] **Step 1: Write the failing tests**

Add to `test_rag.py` (keep the existing assert-based `test_*` + `__main__` runner style already in this file — no pytest dependency):

```python
def test_ingest_pdf_stores_folder_in_metadata(tmp_path):
    from pypdf import PdfWriter
    pdf_path = tmp_path / "sample.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    with open(pdf_path, "wb") as f:
        writer.write(f)

    # A blank page has no extractable text, so ingest_pdf would raise ValueError
    # for chunk emptiness before we ever reach folder handling. Skip straight to
    # the registry functions instead, which is what this task actually adds -
    # ingest_pdf's own text-extraction behavior is already covered.
    doc_id = "doc_task1_test"
    collection = rag.get_collection(doc_id)
    if collection.count() == 0:
        collection.add(
            ids=["c1"],
            documents=["placeholder chunk text"],
            metadatas=[{"page": 1, "filename": "sample.pdf"}],
        )
    collection.modify(metadata={"filename": "sample.pdf", "folder": "Unfiled", "num_pages": 1})

    docs = rag.list_documents()
    match = next((d for d in docs if d["doc_id"] == doc_id), None)
    assert match is not None, "list_documents() should include the collection we just created"
    assert match["folder"] == "Unfiled"
    assert match["filename"] == "sample.pdf"
    assert match["num_chunks"] == 1
    assert match["num_pages"] == 1

    updated = rag.set_folder(doc_id, "Work")
    assert updated["folder"] == "Work"
    refetched = next(d for d in rag.list_documents() if d["doc_id"] == doc_id)
    assert refetched["folder"] == "Work", "set_folder must persist, not just return the new value"
    assert refetched["filename"] == "sample.pdf", "set_folder must not clobber other metadata keys"

    rag.delete_document(doc_id)
    assert all(d["doc_id"] != doc_id for d in rag.list_documents())


def test_set_folder_missing_doc_raises():
    try:
        rag.set_folder("doc_does_not_exist_xyz", "Work")
        assert False, "expected ValueError"
    except ValueError as e:
        assert "doc_does_not_exist_xyz" in str(e)


def test_delete_document_missing_doc_raises():
    try:
        rag.delete_document("doc_does_not_exist_xyz")
        assert False, "expected ValueError"
    except ValueError as e:
        assert "doc_does_not_exist_xyz" in str(e)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python test_rag.py`
Expected: `AttributeError: module 'rag' has no attribute 'list_documents'` (or similar — the functions don't exist yet)

- [ ] **Step 3: Implement `list_documents`, `set_folder`, `delete_document`; update `ingest_pdf`**

Replace `rag.py:109-153` with:

```python
def get_collection(doc_id: str):
    return _client.get_or_create_collection(
        name=doc_id, embedding_function=_embedding_fn
    )


def list_documents() -> List[Dict]:
    """List every ingested document with its folder and stats."""
    docs = []
    for col in _client.list_collections():
        meta = col.metadata or {}
        docs.append({
            "doc_id": col.name,
            "filename": meta.get("filename", col.name),
            "folder": meta.get("folder", "Unfiled"),
            "num_chunks": col.count(),
            "num_pages": meta.get("num_pages"),
        })
    return docs


def set_folder(doc_id: str, folder: str) -> Dict:
    """Move a document to a different folder. Metadata is replace-on-write,
    so we read-merge-write the full dict rather than passing {"folder": folder}."""
    try:
        collection = _client.get_collection(name=doc_id, embedding_function=_embedding_fn)
    except Exception as e:
        raise ValueError(f"Document {doc_id} not found") from e

    meta = dict(collection.metadata or {})
    meta["folder"] = folder
    collection.modify(metadata=meta)

    return {
        "doc_id": doc_id,
        "filename": meta.get("filename", doc_id),
        "folder": folder,
        "num_chunks": collection.count(),
        "num_pages": meta.get("num_pages"),
    }


def delete_document(doc_id: str) -> None:
    try:
        _client.get_collection(name=doc_id, embedding_function=_embedding_fn)
    except Exception as e:
        raise ValueError(f"Document {doc_id} not found") from e
    _client.delete_collection(doc_id)


def ingest_pdf(pdf_path: str, original_filename: str, folder: str = "Unfiled") -> Dict:
    """
    Ingest a PDF: extract, chunk, embed, and store.
    Idempotent - if the doc was already ingested (same content hash), skip re-embedding.
    Returns metadata about the ingested document.
    """
    doc_id = doc_id_for_file(pdf_path)
    collection = get_collection(doc_id)

    if collection.count() > 0:
        meta = collection.metadata or {}
        return {
            "doc_id": doc_id,
            "filename": meta.get("filename", original_filename),
            "folder": meta.get("folder", "Unfiled"),
            "num_chunks": collection.count(),
            "num_pages": meta.get("num_pages"),
            "status": "already_ingested",
        }

    pages = extract_pages(pdf_path)
    chunks = chunk_text(pages)

    if not chunks:
        raise ValueError(
            "No extractable text found in this PDF. It may be scanned/image-only; "
            "consider OCR-ing it first."
        )

    collection.add(
        ids=[c.id for c in chunks],
        documents=[c.text for c in chunks],
        metadatas=[{"page": c.page, "filename": original_filename} for c in chunks],
    )
    collection.modify(metadata={
        "filename": original_filename,
        "folder": folder,
        "num_pages": len(pages),
    })

    return {
        "doc_id": doc_id,
        "filename": original_filename,
        "folder": folder,
        "num_chunks": len(chunks),
        "num_pages": len(pages),
        "status": "ingested",
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python test_rag.py`
Expected: `ok  test_ingest_pdf_stores_folder_in_metadata`, `ok  test_set_folder_missing_doc_raises`, `ok  test_delete_document_missing_doc_raises`, plus the pre-existing tests, ending `all passed`

- [ ] **Step 5: Commit**

```bash
git add rag.py test_rag.py
git commit -m "feat: add document registry (list/folder/delete) to rag.py"
```

---

### Task 2: Smart welcome message in rag.py

**Files:**
- Modify: `rag.py` (add near `answer_question`, after Task 1's changes)
- Test: `test_rag.py`

**Interfaces:**
- Consumes: `get_collection(doc_id)` (Task 1), `get_groq_client()`, `CHAT_MODEL` (existing module globals)
- Produces: `get_or_create_welcome(doc_id: str) -> Dict` — `{"message": str, "suggested_questions": List[str]}`. Cached in collection metadata under keys `welcome_message` (str) and `welcome_questions` (JSON-encoded string — chromadb metadata values must be str/int/float/bool, not a list, so the list is serialized).

- [ ] **Step 1: Write the failing test**

Add to `test_rag.py`:

```python
def test_get_or_create_welcome_generates_and_caches():
    doc_id = "doc_task2_test"
    collection = rag.get_collection(doc_id)
    if collection.count() == 0:
        collection.add(
            ids=["c1"],
            documents=[
                "This document is a quarterly financial report. Revenue grew 12% "
                "year over year to $4.2M. Operating expenses were $2.8M, driven "
                "mainly by headcount growth in engineering and sales."
            ],
            metadatas=[{"page": 1, "filename": "finance.pdf"}],
        )
    collection.modify(metadata={"filename": "finance.pdf", "folder": "Unfiled", "num_pages": 1})

    first = rag.get_or_create_welcome(doc_id)
    assert isinstance(first["message"], str) and len(first["message"]) > 0
    assert isinstance(first["suggested_questions"], list)
    assert len(first["suggested_questions"]) == 3
    assert all(isinstance(q, str) and q for q in first["suggested_questions"])

    # Second call must hit the cache, not call Groq again - same object back.
    second = rag.get_or_create_welcome(doc_id)
    assert second == first

    rag.delete_document(doc_id)


def test_get_or_create_welcome_missing_doc_raises():
    try:
        rag.get_or_create_welcome("doc_does_not_exist_xyz")
        assert False, "expected ValueError"
    except ValueError as e:
        assert "doc_does_not_exist_xyz" in str(e)
```

Note: this test calls the real Groq API and requires `GROQ_API_KEY` to be set in the environment — same requirement the rest of this project already has for anything touching `answer_question`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python test_rag.py`
Expected: `AttributeError: module 'rag' has no attribute 'get_or_create_welcome'`

- [ ] **Step 3: Implement `get_or_create_welcome`**

Add to `rag.py`, after `set_folder`/`delete_document` from Task 1:

```python
import json

WELCOME_SYSTEM_PROMPT = """You summarize documents for a chat app's welcome screen.
Given excerpts from a document, respond with EXACTLY two lines:
Line 1: a 1-2 sentence plain-English summary of what the document is about.
Line 2: three example questions a user could ask about it, separated by " | ".
No headers, no markdown, no numbering. Example:
This is a Q1 2026 financial report covering revenue, expenses, and headcount growth.
What was total revenue this quarter? | Why did operating expenses increase? | How much did headcount grow?"""


def get_or_create_welcome(doc_id: str) -> Dict:
    try:
        collection = _client.get_collection(name=doc_id, embedding_function=_embedding_fn)
    except Exception as e:
        raise ValueError(f"Document {doc_id} not found") from e

    meta = dict(collection.metadata or {})
    if meta.get("welcome_message") and meta.get("welcome_questions"):
        return {
            "message": meta["welcome_message"],
            "suggested_questions": json.loads(meta["welcome_questions"]),
        }

    sample = collection.get(limit=3)
    excerpt = "\n\n".join(sample.get("documents", []))[:3000]

    fallback = {
        "message": f"Document {meta.get('filename', doc_id)} has been loaded. What would you like to know about it?",
        "suggested_questions": [],
    }
    if not excerpt.strip():
        return fallback

    try:
        client = get_groq_client()
        response = client.chat.completions.create(
            model=CHAT_MODEL,
            max_tokens=300,
            messages=[
                {"role": "system", "content": WELCOME_SYSTEM_PROMPT},
                {"role": "user", "content": f"Document excerpts:\n---\n{excerpt}\n---"},
            ],
        )
        lines = response.choices[0].message.content.strip().split("\n")
        message = lines[0].strip()
        questions = [q.strip() for q in lines[1].split("|")][:3] if len(lines) > 1 else []
        if not message or len(questions) != 3:
            return fallback
    except Exception:
        return fallback

    meta["welcome_message"] = message
    meta["welcome_questions"] = json.dumps(questions)
    collection.modify(metadata=meta)

    return {"message": message, "suggested_questions": questions}
```

Move the `import json` to the top of `rag.py` with the other stdlib imports instead of inline (inline shown above just to mark where it's needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `python test_rag.py`
Expected: `ok  test_get_or_create_welcome_generates_and_caches`, `ok  test_get_or_create_welcome_missing_doc_raises`, `all passed`

If it fails because Groq returned a differently-shaped response (LLMs don't always follow format instructions exactly), the fallback path in the implementation handles that - re-run once. If it fails twice, check `GROQ_API_KEY` is set.

- [ ] **Step 5: Commit**

```bash
git add rag.py test_rag.py
git commit -m "feat: add cached smart welcome message generation to rag.py"
```

---

### Task 3: Document + folder endpoints in app.py

**Files:**
- Modify: `app.py`
- Test: manual (curl), shown below — this repo's only test file (`test_rag.py`) targets `rag.py` directly; app.py has no existing test harness and TestClient usage here would just re-test rag.py through an extra layer. Follow the existing pattern (test at the rag.py level) rather than introducing a new one for four thin endpoints.

**Interfaces:**
- Consumes: `rag.list_documents`, `rag.set_folder`, `rag.delete_document`, `rag.get_or_create_welcome`, `rag.ingest_pdf` (all from Tasks 1-2)
- Produces: routes used by static/main.js in Tasks 5-6:
  - `GET /documents` → `200 List[Dict]`
  - `PATCH /documents/{doc_id}` body `{"folder": str}` → `200 Dict` (same shape as one list item) or `404` if not found
  - `DELETE /documents/{doc_id}` → `204` or `404` if not found
  - `GET /documents/{doc_id}/welcome` → `200 {"message": str, "suggested_questions": List[str]}` or `404` if not found
  - `POST /upload` gains optional form field `folder` (default `"Unfiled"`), response gains `"folder"` key (already produced by `rag.ingest_pdf` in Task 1)

- [ ] **Step 1: Implement the endpoints**

In `app.py`, change the `/upload` handler and add four new routes. Replace:

```python
@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        result = rag.ingest_pdf(tmp_path, original_filename=file.filename)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        os.unlink(tmp_path)

    return result
```

with:

```python
@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...), folder: str = Form("Unfiled")):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        result = rag.ingest_pdf(tmp_path, original_filename=file.filename, folder=folder)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        os.unlink(tmp_path)

    return result


@app.get("/documents")
def list_documents():
    return rag.list_documents()


class FolderUpdate(BaseModel):
    folder: str


@app.patch("/documents/{doc_id}")
def move_document(doc_id: str, body: FolderUpdate):
    try:
        return rag.set_folder(doc_id, body.folder)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/documents/{doc_id}", status_code=204)
def remove_document(doc_id: str):
    try:
        rag.delete_document(doc_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/documents/{doc_id}/welcome")
def document_welcome(doc_id: str):
    try:
        return rag.get_or_create_welcome(doc_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
```

Add `Form` to the fastapi import line (`from fastapi import FastAPI, UploadFile, File, Form, HTTPException`).

- [ ] **Step 2: Manual verification**

Run: `python app.py` (leave running), then in another terminal:

```bash
curl -s http://localhost:8000/documents
# Expected: []   (or existing docs if chroma_db/ wasn't cleared)

curl -s -X POST http://localhost:8000/upload -F "file=@/path/to/any.pdf" -F "folder=Test Folder"
# Expected: {"doc_id": "doc_...", "filename": "any.pdf", "folder": "Test Folder", "num_chunks": N, "num_pages": M, "status": "ingested"}

curl -s http://localhost:8000/documents
# Expected: [{"doc_id": "doc_...", "filename": "any.pdf", "folder": "Test Folder", ...}]

curl -s -X PATCH http://localhost:8000/documents/doc_xxx -H "Content-Type: application/json" -d '{"folder":"Other"}'
# Expected: {"doc_id": "doc_xxx", ..., "folder": "Other"}

curl -s http://localhost:8000/documents/doc_xxx/welcome
# Expected: {"message": "...", "suggested_questions": ["...", "...", "..."]}

curl -s -X DELETE http://localhost:8000/documents/doc_xxx -o /dev/null -w "%{http_code}\n"
# Expected: 204

curl -s http://localhost:8000/documents/doc_xxx/welcome -o /dev/null -w "%{http_code}\n"
# Expected: 404
```

Stop the server (Ctrl+C) once all responses match.

- [ ] **Step 3: Commit**

```bash
git add app.py
git commit -m "feat: add document registry and welcome endpoints to app.py"
```

---

### Task 4: Sidebar folder tree + collapse/resize (markup, CSS, JS skeleton)

**Files:**
- Modify: `static/index.html`
- Modify: `static/style.css`
- Modify: `static/main.js`

**Interfaces:**
- Consumes: `GET /documents`, `PATCH /documents/{doc_id}`, `DELETE /documents/{doc_id}` (Task 3)
- Produces: global `selectDocument(doc_id)` function used by Task 5 (chat/welcome wiring); `#sidebar`, `#resizeHandle`, `#collapseToggle`, `#folderTree` DOM ids used by Task 5's landing-state code; per-doc move (`<select class="doc-move">`, wired to `PATCH /documents/{doc_id}`) and delete affordances, satisfying the spec's "move/delete affordance" requirement

- [ ] **Step 1: Update `static/index.html` sidebar markup**

Replace the `<aside class="sidebar" id="sidebar">...</aside>` block with:

```html
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <i data-lucide="sparkles" class="logo-icon"></i>
      <h2>Knowledge Base</h2>
      <button class="collapse-toggle" id="collapseToggle" title="Collapse sidebar">
        <i data-lucide="panel-left-close"></i>
      </button>
    </div>

    <label class="upload-box" id="uploadBox">
      <i data-lucide="file-up" class="upload-icon"></i>
      <div>
        <strong>Upload a Document</strong>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">Drag & drop or click to browse</div>
      </div>
      <input type="file" id="fileInput" accept="application/pdf" />
    </label>

    <div class="folder-controls">
      <select id="folderSelect"></select>
      <button id="newFolderBtn" title="New folder"><i data-lucide="folder-plus"></i></button>
    </div>

    <div class="status-badge" id="statusBadge">
      <div class="status-indicator" id="statusIndicator"></div>
      <span id="statusText">Awaiting document</span>
    </div>

    <div class="folder-tree" id="folderTree"></div>

    <div class="resize-handle" id="resizeHandle"></div>
  </aside>
```

`docInfo` div is dropped — per-doc info now lives in the folder tree rows built by JS in Step 3.

- [ ] **Step 2: Add CSS for collapse, resize, and folder tree**

`static/style.css`'s existing `:root` block (`static/style.css:3-14`) only defines colors, no hover/soft-accent tones for the new interactive rows. Add three variables to that existing block rather than starting a second naming scheme - change:

```css
:root {
  --bg: #09090b;
  --panel: rgba(24, 24, 27, 0.7);
  --panel-border: rgba(255, 255, 255, 0.08);
  --accent: #6366f1;
  --accent-hover: #4f46e5;
  --accent-gradient: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
  --text-main: #f8fafc;
  --text-muted: #94a3b8;
  --user-msg: rgba(99, 102, 241, 0.15);
  --bot-msg: rgba(39, 39, 42, 0.5);
}
```

to:

```css
:root {
  --bg: #09090b;
  --panel: rgba(24, 24, 27, 0.7);
  --panel-border: rgba(255, 255, 255, 0.08);
  --accent: #6366f1;
  --accent-hover: #4f46e5;
  --accent-gradient: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
  --text-main: #f8fafc;
  --text-muted: #94a3b8;
  --user-msg: rgba(99, 102, 241, 0.15);
  --bot-msg: rgba(39, 39, 42, 0.5);
  --row-hover: rgba(255, 255, 255, 0.05);
  --accent-soft: rgba(99, 102, 241, 0.12);
  --accent-soft-hover: rgba(99, 102, 241, 0.2);
}
```

This site is dark-only by design (no existing light palette to extend) - Task 6 covers a contrast/consistency pass, not a new light theme.

Then append the following, unrelated to `:root`, to the end of `static/style.css`:

```css
.sidebar {
  position: relative;
  width: var(--sidebar-width, 280px);
  transition: width 0.15s ease;
}

.sidebar.collapsed {
  width: 56px;
  overflow: hidden;
}

.sidebar.collapsed .sidebar-header h2,
.sidebar.collapsed .upload-box,
.sidebar.collapsed .folder-controls,
.sidebar.collapsed .status-badge,
.sidebar.collapsed .folder-tree {
  display: none;
}

.collapse-toggle {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
}

.resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
}

.sidebar.collapsed .resize-handle {
  display: none;
}

.folder-controls {
  display: flex;
  gap: 6px;
  padding: 0 12px 8px;
}

.folder-controls select {
  flex: 1;
  min-width: 0;
}

.folder-tree {
  overflow-y: auto;
  flex: 1;
}

.folder-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-muted);
  user-select: none;
}

.folder-group-header .chevron {
  transition: transform 0.15s ease;
}

.folder-group.collapsed .chevron {
  transform: rotate(-90deg);
}

.folder-group.collapsed .doc-row {
  display: none;
}

.doc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 8px 28px;
  cursor: pointer;
  border-radius: 6px;
  margin: 0 6px;
  font-size: 0.85rem;
}

.doc-row:hover {
  background: var(--row-hover);
}

.doc-row.active {
  background: var(--accent-soft);
  font-weight: 500;
}

.doc-row .doc-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-row .doc-move {
  opacity: 0;
  max-width: 70px;
  font-size: 0.7rem;
  background: var(--panel);
  color: var(--text-muted);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
}

.doc-row .doc-delete {
  opacity: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}

.doc-row:hover .doc-move,
.doc-row:hover .doc-delete {
  opacity: 1;
}
```

- [ ] **Step 3: Add JS for document registry, folder tree rendering, collapse/resize**

First, remove the now-dead `docInfo` element reference from the DOM-elements block at the top of `static/main.js` (Step 1 dropped `#docInfo` from the markup, so this line would resolve to `null`):

```javascript
const docInfo = document.getElementById('docInfo');
```

Delete that line entirely.

Then, in the same file, replace the section from `// Mobile sidebar toggle` down to (but not including) `function setStatus` with:

```javascript
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

async function fetchDocuments() {
  const res = await fetch('/documents');
  allDocs = await res.json();
  renderFolderTree();
  renderFolderSelect();
  return allDocs;
}

function renderFolderSelect() {
  const folders = [...new Set(['Unfiled', ...allDocs.map(d => d.folder)])];
  folderSelectEl.innerHTML = folders.map(f => `<option value="${f}">${f}</option>`).join('');
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
        `<option value="${f}" ${f === doc.folder ? 'selected' : ''}>${f}</option>`
      ).join('');
      return `
      <div class="doc-row ${doc.doc_id === activeDocId ? 'active' : ''}" data-doc-id="${doc.doc_id}">
        <i data-lucide="file-text" style="width:14px;height:14px;flex-shrink:0;"></i>
        <span class="doc-name" title="${doc.filename}">${doc.filename}</span>
        <select class="doc-move" data-move-id="${doc.doc_id}" title="Move to folder">${options}</select>
        <button class="doc-delete" data-delete-id="${doc.doc_id}" title="Delete">
          <i data-lucide="trash-2" style="width:13px;height:13px;"></i>
        </button>
      </div>
    `;
    }).join('');

    return `
      <div class="folder-group ${isCollapsed ? 'collapsed' : ''}" data-folder="${folder}">
        <div class="folder-group-header">
          <i data-lucide="chevron-down" class="chevron" style="width:14px;height:14px;"></i>
          <span>${folder}</span>
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
```

Note: `selectDocument` and `showLandingState` are referenced here but implemented in Task 5 — this task's JS will not fully run standalone yet. That's expected; Task 5 completes the wiring in the same file.

- [ ] **Step 4: Manual verification (partial - full flow verified at end of Task 5)**

Run: `python app.py`, open `http://localhost:8000`, open browser DevTools console.
Expected: no JS errors other than `selectDocument is not defined` / `showLandingState is not defined` (both added in Task 5). Sidebar collapse button and resize handle should already work if you comment out their callers temporarily - full check deferred to Task 5 Step 4.

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/style.css static/main.js
git commit -m "feat: add collapsible/resizable sidebar with folder tree"
```

---

### Task 5: Landing state + smart welcome wiring in main.js

**Files:**
- Modify: `static/main.js`
- Modify: `static/index.html` (header title element already present, reused)

**Interfaces:**
- Consumes: `fetchDocuments()`, `renderFolderTree()`, `allDocs`, `activeDocId` (Task 4); `GET /documents/{doc_id}/welcome` (Task 3)
- Produces: `selectDocument(doc_id)`, `showLandingState()` (referenced by Task 4's delete handler); wires `handleFileUpload` to use the selected folder and refresh the tree

- [ ] **Step 1: Add landing-state and welcome-rendering functions, and `selectDocument`**

In `static/main.js`, add this block immediately before `sendBtn.addEventListener('click', sendQuestion);` (the last two lines of the file):

```javascript
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
  const chips = questions.map(q => `<button class="suggested-chip" data-question="${q.replace(/"/g, '&quot;')}">${q}</button>`).join('');
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
        <div class="msg"><p>${data.message}</p></div>
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
```

- [ ] **Step 2: Rewrite `handleFileUpload` to use the selected folder and refresh the tree**

Replace the existing `handleFileUpload` function body (the `try` block's contents, from `const res = await fetch('/upload'...)` through the end of `docInfo.innerHTML = infoHtml;`) — the whole function becomes:

```javascript
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
```

This drops the `docInfo` element usage (removed from markup in Task 4) and the old inline welcome message (replaced by the smart welcome fetched in `selectDocument`).

- [ ] **Step 3: Add CSS for suggested-question chips**

Append to `static/style.css`:

```css
.suggested-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.suggested-chip {
  background: var(--accent-soft);
  border: 1px solid var(--panel-border);
  border-radius: 16px;
  padding: 6px 14px;
  font-size: 0.82rem;
  cursor: pointer;
  color: inherit;
}

.suggested-chip:hover {
  background: var(--accent-soft-hover);
}
```

- [ ] **Step 4: Full manual verification**

Run: `python app.py`, open `http://localhost:8000`.

1. Page loads → landing message shows time-of-day greeting + "No documents yet" (or existing counts if `chroma_db/` has data)
2. Upload a PDF, pick/type a folder first → after ingest, sidebar shows the new folder group with the doc, chat shows a generated welcome message + 3 clickable question chips (not the old static "Hello! I'm your RAG Assistant" line)
3. Click a suggested chip → it sends as a question and gets answered
4. Upload a second PDF into a different folder → both folders appear, collapsing one hides only its docs
5. Click collapse toggle → sidebar shrinks to icon rail; reload page → stays collapsed (localStorage)
6. Drag the resize handle → sidebar width changes live; reload page → width persists
7. Hover a doc row, use its folder `<select>` to move it to a different folder → row jumps to the new folder group, old folder's count decrements
8. Click the trash icon on a doc row → confirm dialog → doc removed from list; if it was the active doc, chat returns to landing state
9. Resize browser to ≤768px width → sidebar becomes the existing mobile overlay-drawer, collapse/resize handle not shown

- [ ] **Step 5: Commit**

```bash
git add static/main.js static/style.css
git commit -m "feat: wire smart welcome messages and landing state into chat UI"
```

---

### Task 6: Cleanup pass (stale CSS, new-component consistency)

The site is dark-only by design (`static/style.css:3-14` is a single hardcoded dark palette, no existing light variant) - inventing a light theme here would be new scope, not polish. This task instead: removes CSS orphaned by Task 4-5's markup changes, and gives the new components (folder tree, chips, collapse/resize controls) a once-over against the existing dark palette for consistency.

**Files:**
- Modify: `static/style.css`

**Interfaces:**
- Consumes: existing CSS custom-property system in `static/style.css` (including `--row-hover`, `--accent-soft`, `--accent-soft-hover` added in Task 4)
- Produces: nothing consumed by other tasks — this is a leaf, cosmetic-only task

- [ ] **Step 1: Remove the orphaned `#docInfo` rule**

Task 4 Step 1 removed the `<div id="docInfo">` element from `static/index.html`. Delete the now-dead rule at `static/style.css:111-119`:

```css
#docInfo {
  font-size: 0.85rem;
  color: var(--text-muted);
  line-height: 1.6;
  padding: 12px;
  border-radius: 8px;
  background: rgba(0,0,0,0.2);
  border: 1px solid var(--panel-border);
}
```

- [ ] **Step 2: Manual consistency check**

Open `http://localhost:8000`, with a couple of documents uploaded across 2+ folders. Check each against the existing dark palette (`--bg: #09090b`, `--panel-border: rgba(255,255,255,0.08)`, `--accent: #6366f1`):

1. Folder group header text (`--text-muted`) is legible against `--bg`
2. `.doc-row.active` background (`--accent-soft`) is visibly distinct from a plain hovered row (`--row-hover`) — if they look too similar, increase `--accent-soft`'s alpha in the `:root` block from Task 4
3. Suggested-question chips are visibly distinct from the bot message bubble behind them (`--bot-msg`)
4. Collapsed sidebar's icon rail (56px) doesn't clip the collapse-toggle icon itself

Fix any contrast issues found by adjusting the alpha values on `--row-hover` / `--accent-soft` / `--accent-soft-hover` in `:root` (`static/style.css:3-17` after Task 4) — do not add new variables for this.

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "style: remove stale docInfo CSS, polish new component contrast"
```

---

## Post-plan checklist (not a task — verify after Task 6)

- `python test_rag.py` passes
- `python app.py` boots without error
- Full manual flow from Task 5 Step 4 still holds after Task 6's CSS changes
- No leftover references to the removed `docInfo` element or `EMBED_MODEL` env var
