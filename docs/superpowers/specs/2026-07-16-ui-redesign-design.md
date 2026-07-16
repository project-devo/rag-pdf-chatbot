# RAG PDF Chatbot — UI/UX Redesign

Date: 2026-07-16
Status: approved

## Scope

- Sidebar: collapsible, drag-resizable, folder tree for multiple PDFs
- Smart launch/welcome message (per-doc, Claude-style, cached)
- No-doc landing state with time-aware greeting

## Explicitly out of scope

- Folder-wide / cross-document chat (chat stays single-doc, one `doc_id` per turn)
- Framework rewrite (stays vanilla JS/CSS, no build step)
- Auth / multi-user

## Backend changes

### Storage

No new DB. Folder + welcome-cache live as **metadata on the existing Chroma collection** (`get_collection(doc_id).modify(metadata=...)`), keyed under `folder`, `welcome_message`, `suggested_questions`. Chroma collection metadata is a flat dict — store JSON-encoded list for suggestions.

Default folder for uploads with no explicit folder: `"Unfiled"`.

### Endpoints (app.py)

- `POST /upload` — gains optional form field `folder` (default `"Unfiled"`). Response unchanged shape, `folder` key added.
- `GET /documents` — list every collection via `_client.list_collections()`, return `[{doc_id, filename, folder, num_chunks, num_pages}]`.
- `PATCH /documents/{doc_id}` — body `{folder}`, updates collection metadata.
- `DELETE /documents/{doc_id}` — `_client.delete_collection(doc_id)`.
- `GET /documents/{doc_id}/welcome` — returns cached `{message, suggested_questions}`; generates + caches on first call (one Groq call, short prompt over first ~3 retrieved/stored chunks).

### rag.py additions

- `list_documents()` — enumerate collections + metadata
- `set_folder(doc_id, folder)`
- `delete_document(doc_id)`
- `get_or_create_welcome(doc_id)` — build from first chunks: 2-sentence summary + 3 suggested questions, one Groq call, cache in collection metadata so repeat visits are free

### Error handling

- Welcome generation failure (Groq error/timeout) → fall back to static "Document loaded, ask away" message; chat path unaffected, failure never blocks upload.
- Empty folders are derived (no doc has folder=X) → don't survive server restart; acceptable, not persisted separately.

## Frontend changes

### Sidebar (static/index.html, style.css, main.js)

- Folder tree: collapsible groups, "Unfiled" default group, new-folder input, per-doc row with move/delete affordance (simple `<select>` for move — no drag-drop, YAGNI)
- **Collapse**: toggle button shrinks sidebar to icon rail (~56px); full width restored on toggle; state in `localStorage.sidebarCollapsed`
- **Resize**: drag handle on sidebar's right edge; clamps 200–480px; width in `localStorage.sidebarWidth`
- Mobile (`<=768px`): unchanged overlay-drawer behavior; collapse/resize desktop-only

### Chat area

- No doc selected: landing message — time-of-day greeting (`Good morning/afternoon/evening`) + doc/folder counts + prompt to pick or upload. Computed client-side from `Date()` + `/documents` response.
- Doc selected: fetch `/documents/{doc_id}/welcome`, render intro text + up to 3 suggested-question chips; clicking a chip fills input and sends immediately.
- Existing chat/typing-indicator/markdown rendering: unchanged.

### Visual pass

- Refresh spacing/typography/message bubbles/status badge within current CSS custom-property system in style.css; add light/dark via `prefers-color-scheme`. No new dependencies (marked.js + lucide stay CDN as-is).

## Testing

- `test_rag.py`: add cases for `set_folder`, `delete_document`, `get_or_create_welcome` (cache hit vs miss), `list_documents` shape
- Manual smoke: upload 2 PDFs to 2 folders, collapse/resize sidebar, reload (persists via localStorage), delete a doc, confirm welcome renders once and is cached on second visit
